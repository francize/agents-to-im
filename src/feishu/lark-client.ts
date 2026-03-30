import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import * as lark from '@larksuiteoapi/node-sdk';

import type { ChannelAddress } from '../bridge/types.js';
import { findMissingAppScopes } from './constants.js';
import type {
  LarkMessageResponse,
  PatchCardOptions,
} from './types.js';
import {
  assertLarkOk,
  isNonEmptyString,
} from './utils.js';

export class LarkClient {
  readonly outboundMessageQueues = new Map<string, Promise<void>>();
  readonly lastOutboundMessageAt = new Map<string, number>();

  private client: lark.Client | null = null;

  getClient(): lark.Client | null {
    return this.client;
  }

  setClient(client: lark.Client | null): void {
    this.client = client;
    if (!client) {
      this.outboundMessageQueues.clear();
      this.lastOutboundMessageAt.clear();
    }
  }

  async sendMessage(
    address: ChannelAddress,
    msgType: 'interactive' | 'post' | 'image',
    content: string,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<LarkMessageResponse> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }
    return this.enqueueMessage(address.chatId, async () => {
      const uuid = requestUuid || randomUUID().slice(0, 50);
      if (replyToMessageId) {
        return this.client!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            msg_type: msgType,
            content,
            uuid,
            ...(address.threadId ? { reply_in_thread: true } : {}),
          },
        });
      }
      const receiveId = address.threadId || address.chatId;
      const receiveIdType = (address.threadId ? 'thread_id' : 'chat_id') as 'thread_id' | 'chat_id';
      return this.client!.im.message.create({
        params: { receive_id_type: receiveIdType as never },
        data: {
          receive_id: receiveId,
          msg_type: msgType,
          content,
          uuid,
        },
      });
    });
  }

  async sendCard(
    address: ChannelAddress,
    card: Record<string, unknown> | lark.InteractiveCard,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<{ messageId: string; openMessageId?: string }> {
    const response = await this.sendMessage(
      address,
      'interactive',
      JSON.stringify(card),
      replyToMessageId,
      requestUuid,
    );
    assertLarkOk(response, 'im.message.sendInteractiveCard');
    return {
      messageId: response.data?.message_id || '',
      openMessageId: response.data?.open_message_id,
    };
  }

  async patchCard(
    messageId: string,
    card: Record<string, unknown>,
    options?: PatchCardOptions,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }
    const response = await (this.client.im.message as {
      patch: (payload: {
        path: { message_id: string };
        data: { content: string };
        params?: { message_id_type: 'open_message_id' };
      }) => Promise<{ code?: number; msg?: string }>;
    }).patch({
      path: { message_id: messageId },
      ...(options?.messageIdType === 'open_message_id'
        ? { params: { message_id_type: 'open_message_id' as const } }
        : {}),
      data: {
        content: JSON.stringify(card),
      },
    });
    assertLarkOk(response, 'im.message.patch');
  }

  async deleteMessageQuietly(messageId: string): Promise<void> {
    const messageApi = this.client?.im?.message as {
      delete?: (payload: { path: { message_id: string } }) => Promise<{ code?: number; msg?: string }>;
    } | undefined;
    if (!messageApi?.delete) return;
    try {
      const response = await messageApi.delete({
        path: { message_id: messageId },
      });
      assertLarkOk(response, 'im.message.delete');
    } catch (error) {
      console.warn('[feishu-adapter] Failed to delete stale preview placeholder:', error);
    }
  }

  async uploadImage(filePath: string): Promise<string> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }
    const image = fs.readFileSync(filePath);
    const response = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image,
      },
    });
    const imageKey = response?.image_key;
    if (!imageKey) {
      throw new Error('Feishu image upload succeeded without image_key');
    }
    return imageKey;
  }

  async runScopeDiagnostic(): Promise<void> {
    if (!this.client) return;
    try {
      const client = this.client as unknown as {
        request?: (payload: {
          method: string;
          url: string;
          params?: Record<string, string>;
        }) => Promise<{
          code?: number;
          msg?: string;
          data?: { app?: { scopes?: Array<{ scope?: string }> } };
        }>;
      };
      if (!client.request) return;
      const response = await client.request({
        method: 'GET',
        url: '/open-apis/application/v6/applications/me',
        params: { lang: 'zh_cn' },
      });
      if (response.code !== 0) {
        console.warn(`[feishu-adapter] Scope diagnostic unavailable: ${response.msg || response.code}`);
        return;
      }
      const scopes = response.data?.app?.scopes?.map((item) => item.scope).filter(isNonEmptyString) || [];
      const missingScopes = findMissingAppScopes(scopes);
      console.log(`[feishu-adapter] Scope diagnostic: ${scopes.length} app scope(s) visible`);
      if (missingScopes.length > 0) {
        console.warn(
          `[feishu-adapter] Missing recommended app scopes: ${missingScopes.join(', ')}. ` +
          '消息收发、群改名、流式卡片或 typing 可能受影响。',
        );
      }
    } catch (error) {
      console.warn('[feishu-adapter] Scope diagnostic failed:', error instanceof Error ? error.message : error);
    }
  }

  private async enqueueMessage<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.outboundMessageQueues.get(chatId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => {}).then(() => current);
    this.outboundMessageQueues.set(chatId, queued);

    await previous.catch(() => {});
    try {
      const lastSentAt = this.lastOutboundMessageAt.get(chatId) || 0;
      const elapsed = Date.now() - lastSentAt;
      const minIntervalMs = 250;
      if (elapsed < minIntervalMs) {
        await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
      }
      const result = await task();
      this.lastOutboundMessageAt.set(chatId, Date.now());
      return result;
    } finally {
      release();
      const pending = this.outboundMessageQueues.get(chatId);
      if (pending === queued) {
        this.outboundMessageQueues.delete(chatId);
      }
    }
  }
}
