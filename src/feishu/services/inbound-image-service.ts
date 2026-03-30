import { Buffer } from 'node:buffer';

import type * as lark from '@larksuiteoapi/node-sdk';

import type { FileAttachment } from '../../bridge/types.js';
import { PENDING_INBOUND_IMAGE_TTL_MS } from '../constants.js';
import type { PendingInboundImage } from '../types.js';
import {
  extensionForMimeType,
  pendingInboundImageKey,
} from '../utils.js';

export class InboundImageService {
  readonly pendingInboundImages = new Map<string, PendingInboundImage>();

  constructor(
    private readonly getClient: () => lark.Client | null,
  ) {}

  reset(): void {
    this.pendingInboundImages.clear();
  }

  prunePendingInboundImages(now = Date.now()): void {
    for (const [key, entry] of this.pendingInboundImages) {
      if (now - entry.createdAt > PENDING_INBOUND_IMAGE_TTL_MS) {
        this.pendingInboundImages.delete(key);
      }
    }
  }

  getPendingInboundImage(
    chatId: string,
    senderId: string,
    messageId: string,
    threadId?: string,
  ): PendingInboundImage | null {
    const key = pendingInboundImageKey(chatId, senderId, messageId, threadId);
    const entry = this.pendingInboundImages.get(key) || null;
    if (!entry) return null;
    if (Date.now() - entry.createdAt <= PENDING_INBOUND_IMAGE_TTL_MS) {
      return entry;
    }
    this.pendingInboundImages.delete(key);
    return {
      ...entry,
      errorMessage: '这张图片已过期，请重新发送图片后再直接回复文字。',
      attachments: undefined,
    };
  }

  setPendingInboundImage(entry: PendingInboundImage): void {
    this.pendingInboundImages.set(entry.key, entry);
  }

  async downloadInboundImageAttachment(messageId: string, imageKey: string): Promise<FileAttachment> {
    const client = this.getClient();
    if (!client?.im?.messageResource?.get) {
      throw new Error('Feishu 图片资源下载能力不可用');
    }
    const response = await client.im.messageResource.get({
      params: { type: 'image' },
      path: {
        message_id: messageId,
        file_key: imageKey,
      },
    });
    const stream = response.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const contentType = typeof response.headers?.['content-type'] === 'string'
      ? response.headers['content-type']
      : 'image/png';
    const extension = extensionForMimeType(contentType);
    return {
      id: `feishu-image:${messageId}`,
      name: `feishu-image-${messageId}.${extension}`,
      type: contentType,
      size: buffer.length,
      data: buffer.toString('base64'),
    };
  }

  resolveReferencedInboundImages(
    chatId: string,
    senderId: string,
    threadId: string | undefined,
    referenceIds: Array<string | undefined>,
  ): { attachments?: FileAttachment[]; errorMessage?: string } {
    for (const referenceId of referenceIds) {
      if (!referenceId) continue;
      const entry = this.getPendingInboundImage(chatId, senderId, referenceId, threadId);
      if (!entry) continue;
      if (entry.attachments?.length) {
        return { attachments: entry.attachments };
      }
      return {
        errorMessage: entry.errorMessage || '这张图片暂时无法读取，请重新发送图片后再直接回复文字。',
      };
    }
    return {};
  }
}
