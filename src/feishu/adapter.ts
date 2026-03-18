import * as lark from '@larksuiteoapi/node-sdk';

import type {
  ChannelAddress,
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../bridge/types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../bridge/channel-adapter.js';
import { getBridgeContext } from '../bridge/context.js';
import { handlePermissionCallback } from '../bridge/permission-broker.js';
import {
  buildCardContent,
  buildPostContent,
  hasComplexMarkdown,
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
} from '../bridge/markdown/feishu.js';

import type { MultiplexLLMProvider } from '../multiplex-llm-provider.js';
import type { RuntimeName } from '../runtime-types.js';
import { JsonFileStore } from '../store.js';

const STREAM_ELEMENT_ID = 'stream_content';
const TYPING_EMOJI = 'Typing';
export const FEISHU_REQUIRED_APP_SCOPES = [
  'im:message:send_as_bot',
  'im:message:readonly',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message:update',
  'im:message.reactions:read',
  'im:message.reactions:write_only',
  'im:chat:read',
  'im:chat:update',
  'im:resource',
  'cardkit:card:write',
  'cardkit:card:read',
] as const;

type MemberIdType = 'open_id' | 'user_id' | 'union_id';

interface SenderIdentity {
  id: string;
  type: MemberIdType;
}

interface FeishuMessageEventData {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: 'p2p' | 'group' | string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    message_type: string;
    content: string;
    create_time: string;
  };
}

interface PreviewArtifact {
  key: string;
  routeKey: string;
  chatId: string;
  draftId: number;
  replyToMessageId?: string;
  messageId?: string;
  cardId?: string;
  lastText: string;
  sequence: number;
  mode: 'cardkit' | 'patch';
}

function buildRouteKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:thread:${threadId}` : `${chatId}:main`;
}

function routeKeyForAddress(address: Pick<ChannelAddress, 'chatId' | 'threadId'>): string {
  return buildRouteKey(address.chatId, address.threadId);
}

function previewKey(routeKey: string, draftId: number): string {
  return `${routeKey}:${draftId}`;
}

function sanitizeTitleFallback(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 30) || '新会话';
}

function buildSimpleCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

function buildStreamingCardSkeleton(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: true,
      summary: {
        content: 'Thinking...',
        i18n_content: {
          zh_cn: '思考中...',
          en_us: 'Thinking...',
        },
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          element_id: STREAM_ELEMENT_ID,
        },
      ],
    },
  };
}

function buildPermissionCard(text: string, buttons: NonNullable<OutboundMessage['inlineButtons']>): lark.InteractiveCard {
  const actions = buttons.flat().map((button) => {
    const lower = button.text.toLowerCase();
    const type: 'default' | 'danger' | 'primary' =
      lower.includes('deny') ? 'danger' : lower.includes('allow') ? 'primary' : 'default';
    return {
      tag: 'button' as const,
      text: {
        tag: 'plain_text' as const,
        content: button.text,
      },
      type,
      value: {
        callback_data: button.callbackData,
      },
    };
  });
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: 'Permission Required',
      },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: text,
      },
      {
        tag: 'action',
        actions,
      },
    ],
  };
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFragments(item));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim()) {
    return [record.text.trim()];
  }
  return Object.values(record).flatMap((item) => collectTextFragments(item));
}

function parseTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    return collectTextFragments(parsed).join('\n').trim();
  } catch {
    return content.trim();
  }
}

function normalizeMarkdown(message: OutboundMessage): string {
  let text = message.text;
  if (message.parseMode === 'HTML') {
    text = htmlToFeishuMarkdown(text);
  }
  if (message.parseMode === 'Markdown' || message.parseMode === 'HTML') {
    text = preprocessFeishuMarkdown(text);
  }
  return text;
}

function assertLarkOk(response: { code?: number; msg?: string }, context: string): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`${context}: code=${response.code}, msg=${response.msg || 'unknown error'}`);
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function findMissingAppScopes(visibleScopes: readonly string[]): string[] {
  const granted = new Set(visibleScopes);
  return FEISHU_REQUIRED_APP_SCOPES.filter((scope) => !granted.has(scope));
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private chatQueues = new Map<string, Promise<void>>();
  private seenMessageIds = new Map<string, number>();
  private lastIncomingMessageId = new Map<string, string>();
  private typingReactions = new Map<string, string>();
  private previewArtifacts = new Map<string, PreviewArtifact>();
  private activePreviewByRoute = new Map<string, string>();
  private pendingTitles = new Set<string>();

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const { appId, appSecret, domain } = this.getClientConfig();
    this.restClient = new lark.Client({ appId, appSecret, domain });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': async (data: unknown) => this.handleCardAction(data as lark.InteractiveCardActionEvent),
    });

    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.info,
    });

    const wsClientAny = this.wsClient as unknown as {
      handleEventData: (data: unknown) => unknown;
    };
    const originalHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
    wsClientAny.handleEventData = (data: unknown) => {
      const frame = data as { headers?: Array<{ key?: string; value?: string }> };
      const messageType = frame.headers?.find((header) => header.key === 'type')?.value;
      if (messageType === 'card' && frame.headers) {
        return originalHandleEventData({
          ...frame,
          headers: frame.headers.map((header) =>
            header.key === 'type' ? { ...header, value: 'event' } : header,
          ),
        });
      }
      return originalHandleEventData(data);
    };

    this.running = true;
    void this.runScopeDiagnostic();
    void this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('[feishu-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      this.wsClient?.close({ force: true });
    } catch {
      // ignore
    }
    this.wsClient = null;
    this.restClient = null;
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
    this.queue = [];
    this.chatQueues.clear();
    this.previewArtifacts.clear();
    this.activePreviewByRoute.clear();
    this.pendingTitles.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.running) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  validateConfig(): string | null {
    const { store } = getBridgeContext();
    if (!store.getSetting('bridge_feishu_app_id')) return 'CTI_FEISHU_APP_ID is required';
    if (!store.getSetting('bridge_feishu_app_secret')) return 'CTI_FEISHU_APP_SECRET is required';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const { store } = getBridgeContext();
    const allowed = store.getSetting('bridge_feishu_allowed_users');
    if (!allowed) return true;
    const allowSet = new Set(
      allowed
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
    return allowSet.has(userId);
  }

  onMessageStart(address: ChannelAddress): void {
    if (!this.restClient) return;
    const routeKey = routeKeyForAddress(address);
    const messageId = this.lastIncomingMessageId.get(routeKey);
    if (!messageId) return;
    void this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((response) => {
      const reactionId = response.data?.reaction_id;
      if (reactionId) this.typingReactions.set(routeKey, reactionId);
    }).catch(() => {});
  }

  onMessageEnd(address: ChannelAddress): void {
    if (!this.restClient) return;
    const routeKey = routeKeyForAddress(address);
    const reactionId = this.typingReactions.get(routeKey);
    const messageId = this.lastIncomingMessageId.get(routeKey);
    if (!reactionId || !messageId) return;
    this.typingReactions.delete(routeKey);
    void this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => {});
  }

  getPreviewCapabilities(address: ChannelAddress): PreviewCapabilities | null {
    const store = this.getStore();
    if (!store.getChannelBinding(this.channelType, address.chatId)) {
      return null;
    }
    return {
      supported: true,
      privateOnly: false,
    };
  }

  async sendPreview(address: ChannelAddress, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.restClient) return 'skip';
    const processedText = preprocessFeishuMarkdown(text);
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    let artifact = this.previewArtifacts.get(key);
    if (!artifact) {
      const createdArtifact = await this.createPreviewArtifact(address, draftId, processedText);
      if (!createdArtifact) return 'degrade';
      artifact = createdArtifact;
      this.previewArtifacts.set(key, artifact);
      this.activePreviewByRoute.set(routeKey, key);
    }

    try {
      if (artifact.mode === 'cardkit' && artifact.cardId) {
        artifact.sequence += 1;
        const response = await this.restClient.cardkit.v1.cardElement.content({
          path: { card_id: artifact.cardId, element_id: STREAM_ELEMENT_ID },
          data: {
            content: processedText,
            sequence: artifact.sequence,
          },
        });
        assertLarkOk(response, 'cardkit.cardElement.content');
      } else if (artifact.messageId) {
        await this.patchInteractiveCard(artifact.messageId, buildSimpleCard(processedText));
      }
      artifact.lastText = processedText;
      return 'sent';
    } catch (error) {
      if (artifact.mode === 'cardkit' && artifact.messageId) {
        artifact.mode = 'patch';
        try {
          await this.patchInteractiveCard(artifact.messageId, buildSimpleCard(processedText));
          artifact.lastText = processedText;
          return 'sent';
        } catch {
          console.warn('[feishu-adapter] Preview degraded after CardKit failure:', error);
        }
      }
      return 'degrade';
    }
  }

  endPreview(address: ChannelAddress, draftId: number): void {
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    this.previewArtifacts.delete(key);
    if (this.activePreviewByRoute.get(routeKey) === key) {
      this.activePreviewByRoute.delete(routeKey);
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(message.address, normalizeMarkdown(message), message.inlineButtons, message.replyToMessageId);
    }

    const activePreviewKey = this.activePreviewByRoute.get(routeKeyForAddress(message.address));
    if (activePreviewKey) {
      const artifact = this.previewArtifacts.get(activePreviewKey);
      if (artifact?.messageId) {
        try {
          const finalText = normalizeMarkdown(message);
          if (artifact.mode === 'cardkit' && artifact.cardId) {
            artifact.sequence += 1;
            const card = buildSimpleCard(finalText);
            const updateResponse = await this.restClient.cardkit.v1.card.update({
              path: { card_id: artifact.cardId },
              data: {
                card: {
                  type: 'card_json',
                  data: JSON.stringify(card),
                },
                sequence: artifact.sequence,
              },
            });
            assertLarkOk(updateResponse, 'cardkit.card.update');
            artifact.sequence += 1;
            const settingsResponse = await this.restClient.cardkit.v1.card.settings({
              path: { card_id: artifact.cardId },
              data: {
                settings: JSON.stringify({ streaming_mode: false }),
                sequence: artifact.sequence,
              },
            });
            assertLarkOk(settingsResponse, 'cardkit.card.settings');
          } else {
            await this.patchInteractiveCard(artifact.messageId, buildSimpleCard(finalText));
          }
          artifact.lastText = finalText;
          void this.maybeRenameChat(message.address.chatId);
          return { ok: true, messageId: artifact.messageId };
        } catch (error) {
          console.warn('[feishu-adapter] Failed to finalize preview in place:', error);
        }
      }
    }

    const text = normalizeMarkdown(message);
    const result = hasComplexMarkdown(text)
      ? await this.sendAsInteractiveCard(message.address, text, message.replyToMessageId)
      : await this.sendAsPost(message.address, text, message.replyToMessageId);
    if (result.ok) {
      void this.maybeRenameChat(message.address.chatId);
    }
    return result;
  }

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const messageId = data.message.message_id;
    if (data.sender.sender_type === 'app') return;
    if (this.seenMessageIds.has(messageId)) return;
    this.seenMessageIds.set(messageId, Date.now());
    if (this.seenMessageIds.size > 1000) {
      const first = this.seenMessageIds.keys().next().value;
      if (first) this.seenMessageIds.delete(first);
    }

    const sender = this.extractSenderIdentity(data);
    if (!sender || !this.isAuthorized(sender.id, data.message.chat_id)) {
      console.warn(
        `[feishu-adapter] Dropped inbound message ${messageId}: unauthorized or sender identity missing ` +
        `(chat=${data.message.chat_id})`,
      );
      return;
    }

    const threadId = data.message.thread_id || undefined;
    const routeKey = buildRouteKey(data.message.chat_id, threadId);
    this.lastIncomingMessageId.set(routeKey, messageId);
    const text = data.message.message_type === 'text' ? parseTextContent(data.message.content) : '';
    console.log(
      `[feishu-adapter] Inbound message ${messageId} chat=${data.message.chat_id}` +
      `${threadId ? ` thread=${threadId}` : ''} type=${data.message.message_type} chatType=${data.message.chat_type}`,
    );
    if (!text) {
      console.warn(
        `[feishu-adapter] Dropped inbound message ${messageId}: empty parsed text ` +
        `(type=${data.message.message_type}, content=${data.message.content.slice(0, 200)})`,
      );
      return;
    }

    await this.enqueueChatTask(routeKey, async () => {
      const inbound: InboundMessage = {
        messageId,
        address: {
          channelType: this.channelType,
          chatId: data.message.chat_id,
          userId: sender.id,
          ...(threadId ? { threadId } : {}),
        },
        text,
        timestamp: Number(data.message.create_time || Date.now()),
        raw: {
          rootId: data.message.root_id,
          parentId: data.message.parent_id,
          threadId,
        },
      };

      if (data.message.chat_type === 'p2p') {
        await this.handleDirectMessage(sender, inbound);
        return;
      }
      await this.handleGroupMessage(sender, inbound);
    });
  }

  private async handleCardAction(event: lark.InteractiveCardActionEvent): Promise<{ toast: { type: string; content: string } }> {
    const callbackData = typeof event.action?.value?.callback_data === 'string'
      ? event.action.value.callback_data
      : '';
    if (!callbackData) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    const store = this.getStore();
    const permissionRequestId = callbackData.split(':').slice(2).join(':');
    const link = store.getPermissionLink(permissionRequestId);
    if (link && handlePermissionCallback(callbackData, link.chatId)) {
      return { toast: { type: 'success', content: 'Permission updated' } };
    }
    return { toast: { type: 'warning', content: 'Permission already handled' } };
  }

  private async handleDirectMessage(sender: SenderIdentity, inbound: InboundMessage): Promise<void> {
    const command = inbound.text.trim().toLowerCase();
    if (command === '/new:claude' || command === '/new:codex') {
      await this.handleCreateSessionCommand(sender, inbound, command.endsWith('codex') ? 'codex' : 'claude');
      return;
    }
    await this.sendAsPost(
      inbound.address,
      '私聊仅支持 `/new:claude` 和 `/new:codex`。发送命令后 Bot 会新建群聊并将该群绑定到一个新会话。',
      inbound.messageId,
    );
  }

  private async handleGroupMessage(_sender: SenderIdentity, inbound: InboundMessage): Promise<void> {
    const text = inbound.text.trim();
    const lower = text.toLowerCase();
    if (lower.startsWith('/perm ')) {
      const handled = this.handlePermissionCommand(inbound.address.chatId, text, inbound.messageId);
      if (!handled) {
        await this.sendAsPost(inbound.address, '无效的权限命令，格式为 `/perm allow|allow_session|deny <id>`。', inbound.messageId);
      }
      return;
    }
    if (lower === '/reset') {
      await this.handleResetCommand(inbound.address, inbound.messageId);
      return;
    }
    if (lower.startsWith('/new')) {
      await this.sendAsPost(inbound.address, '请先私聊 Bot 使用 `/new:claude` 或 `/new:codex` 创建新会话。', inbound.messageId);
      return;
    }
    if (lower.startsWith('/')) {
      await this.sendAsPost(inbound.address, '该群仅支持普通对话、`/reset` 与 `/perm ...`。如需新会话，请私聊 Bot。', inbound.messageId);
      return;
    }

    const binding = this.getStore().getChannelBinding(this.channelType, inbound.address.chatId);
    if (!binding) {
      await this.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    this.enqueue(inbound);
  }

  private async handleCreateSessionCommand(sender: SenderIdentity, inbound: InboundMessage, runtime: RuntimeName): Promise<void> {
    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      ensureRuntimeAvailable?: (target: RuntimeName) => Promise<void>;
    };
    try {
      await llm.ensureRuntimeAvailable?.(runtime);
    } catch (error) {
      await this.sendAsPost(
        inbound.address,
        `无法创建 ${runtime} 会话：${error instanceof Error ? error.message : String(error)}`,
        inbound.messageId,
      );
      return;
    }

    let chatId = '';
    try {
      chatId = await this.createSessionGroup(runtime, sender);
      const store = this.getStore();
      const model = runtime === 'codex'
        ? store.getSetting('bridge_codex_default_model') || ''
        : store.getSetting('bridge_claude_default_model') || store.getSetting('bridge_default_model') || '';
      const session = store.createRuntimeSession({
        runtime,
        model,
        cwd: store.getSetting('bridge_default_work_dir') || process.cwd(),
      });
      store.upsertChannelBinding({
        channelType: this.channelType,
        chatId,
        codepilotSessionId: session.id,
        workingDirectory: session.working_directory,
        model: session.model,
      });
      await this.sendAsPost({ channelType: this.channelType, chatId }, `已创建 ${runtime} 会话。后续请直接在本群继续对话。`);
      await this.sendAsPost(inbound.address, `已创建新群并绑定 ${runtime} 会话。`, inbound.messageId);
    } catch (error) {
      console.error('[feishu-adapter] Failed to initialize group session:', error);
      const message = `创建会话失败：${error instanceof Error ? error.message : String(error)}`;
      if (chatId) {
        await this.sendAsPost({ channelType: this.channelType, chatId }, `初始化失败：${message}`);
      }
      await this.sendAsPost(inbound.address, message, inbound.messageId);
    }
  }

  private async handleResetCommand(address: ChannelAddress, replyToMessageId?: string): Promise<void> {
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, address.chatId);
    if (!binding) {
      await this.sendAsPost(address, '当前群尚未绑定会话，请先私聊 Bot 使用 `/new:claude` 或 `/new:codex`。', replyToMessageId);
      return;
    }
    const ext = store.getSessionExt(binding.codepilotSessionId);
    const runtime = ext?.runtime || 'claude';
    const session = store.createRuntimeSession({
      runtime,
      model: binding.model,
      cwd: binding.workingDirectory,
    });
    store.upsertChannelBinding({
      channelType: this.channelType,
      chatId: address.chatId,
      codepilotSessionId: session.id,
      workingDirectory: binding.workingDirectory,
      model: binding.model,
    });
    const updated = store.getChannelBinding(this.channelType, address.chatId);
    if (updated) {
      store.updateChannelBinding(updated.id, { mode: binding.mode, sdkSessionId: '' });
    }
    await this.sendAsPost(address, `已重置当前群会话，runtime 保持为 ${runtime}。`, replyToMessageId);
  }

  private handlePermissionCommand(chatId: string, text: string, messageId?: string): boolean {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) return false;
    const action = parts[1].toLowerCase();
    if (action !== 'allow' && action !== 'allow_session' && action !== 'deny') return false;
    const permissionRequestId = parts.slice(2).join(' ');
    return handlePermissionCallback(`perm:${action}:${permissionRequestId}`, chatId, messageId);
  }

  private async createSessionGroup(runtime: RuntimeName, sender: SenderIdentity): Promise<string> {
    if (!this.restClient) throw new Error('Feishu client not initialized');
    const response = await this.restClient.im.chat.create({
      params: {
        user_id_type: sender.type,
        set_bot_manager: true,
      },
      data: {
        name: runtime === 'codex' ? 'Codex 新会话' : 'Claude 新会话',
        chat_mode: 'group',
        chat_type: 'private',
        group_message_type: 'chat',
        user_id_list: [sender.id],
      },
    });
    assertLarkOk(response, 'im.chat.create');
    const chatId = response.data?.chat_id;
    if (!chatId) throw new Error('Create group succeeded without chat_id');
    return chatId;
  }

  private async maybeRenameChat(chatId: string): Promise<void> {
    if (!this.restClient || this.pendingTitles.has(chatId)) return;
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId);
    if (!binding) return;
    const ext = store.getSessionExt(binding.codepilotSessionId);
    if (!ext || ext.titleStatus === 'done' || ext.titleStatus === 'running') return;
    const { messages } = store.getMessages(binding.codepilotSessionId);
    const firstUser = messages.find((message) => message.role === 'user');
    const firstAssistant = messages.find((message) => message.role === 'assistant');
    if (!firstUser || !firstAssistant) return;

    this.pendingTitles.add(chatId);
    store.updateSessionExt(binding.codepilotSessionId, { titleStatus: 'running' });

    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      generateTitle?: (sessionId: string, userText: string, assistantText: string) => Promise<string | null>;
    };
    const fallbackTitle = sanitizeTitleFallback(firstUser.content);

    try {
      const generated = await llm.generateTitle?.(binding.codepilotSessionId, firstUser.content, firstAssistant.content);
      const title = generated || fallbackTitle;
      const response = await this.restClient.im.chat.update({
        path: { chat_id: chatId },
        data: { name: title },
      });
      assertLarkOk(response, 'im.chat.update');
      store.updateSessionExt(binding.codepilotSessionId, {
        title,
        titleStatus: 'done',
      });
    } catch (error) {
      console.warn('[feishu-adapter] Failed to rename chat:', error);
      store.updateSessionExt(binding.codepilotSessionId, {
        title: fallbackTitle,
        titleStatus: 'failed',
      });
    } finally {
      this.pendingTitles.delete(chatId);
    }
  }

  private async createPreviewArtifact(address: ChannelAddress, draftId: number, text: string): Promise<PreviewArtifact | null> {
    if (!this.restClient) return null;
    const routeKey = routeKeyForAddress(address);
    const replyToMessageId = this.lastIncomingMessageId.get(routeKey);
    try {
      const createResponse = await this.restClient.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(buildStreamingCardSkeleton()),
        },
      });
      assertLarkOk(createResponse, 'cardkit.card.create');
      const cardId = createResponse.data?.card_id;
      if (!cardId) throw new Error('CardKit create succeeded without card_id');
      const sendResponse = await this.sendLarkMessage(
        address,
        'interactive',
        JSON.stringify({
          type: 'card',
          data: { card_id: cardId },
        }),
        replyToMessageId,
      );
      assertLarkOk(sendResponse, 'im.message.sendCardByCardId');
      const messageId = sendResponse.data?.message_id;
      if (!messageId) throw new Error('CardKit send succeeded without message_id');
      return {
        key: previewKey(routeKey, draftId),
        routeKey,
        chatId: address.chatId,
        draftId,
        replyToMessageId,
        messageId,
        cardId,
        lastText: text,
        sequence: 0,
        mode: 'cardkit',
      };
    } catch (error) {
      console.warn('[feishu-adapter] CardKit preview unavailable, falling back to message patch:', error);
      try {
        const sendResult = await this.sendInteractiveCard(address, buildSimpleCard(text), replyToMessageId);
        return {
          key: previewKey(routeKey, draftId),
          routeKey,
          chatId: address.chatId,
          draftId,
          replyToMessageId,
          messageId: sendResult.messageId,
          lastText: text,
          sequence: 0,
          mode: 'patch',
        };
      } catch (fallbackError) {
        console.warn('[feishu-adapter] Preview fallback failed:', fallbackError);
        return null;
      }
    }
  }

  private extractSenderIdentity(data: FeishuMessageEventData): SenderIdentity | null {
    const senderId = data.sender.sender_id;
    if (senderId?.open_id) return { id: senderId.open_id, type: 'open_id' };
    if (senderId?.user_id) return { id: senderId.user_id, type: 'user_id' };
    if (senderId?.union_id) return { id: senderId.union_id, type: 'union_id' };
    return null;
  }

  private getClientConfig(): { appId: string; appSecret: string; domain: lark.Domain } {
    const { store } = getBridgeContext();
    const appId = store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = store.getSetting('bridge_feishu_app_secret') || '';
    const domain = store.getSetting('bridge_feishu_domain') === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;
    return { appId, appSecret, domain };
  }

  private getStore(): JsonFileStore {
    return getBridgeContext().store as JsonFileStore;
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private async enqueueChatTask(chatId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chatQueues.get(chatId) || Promise.resolve();
    const next = previous.then(task, task);
    this.chatQueues.set(chatId, next);
    try {
      await next;
    } finally {
      if (this.chatQueues.get(chatId) === next) {
        this.chatQueues.delete(chatId);
      }
    }
  }

  private async sendPermissionCard(
    address: ChannelAddress,
    text: string,
    buttons: NonNullable<OutboundMessage['inlineButtons']>,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const result = await this.sendInteractiveCard(address, buildPermissionCard(text, buttons), replyToMessageId);
    return {
      ok: true,
      messageId: result.messageId,
    };
  }

  private async sendAsInteractiveCard(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult> {
    const content = buildCardContent(text);
    const response = await this.sendLarkMessage(address, 'interactive', content, replyToMessageId);
    assertLarkOk(response, 'im.message.sendInteractive');
    return {
      ok: true,
      messageId: response.data?.message_id,
    };
  }

  private async sendAsPost(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult> {
    const content = buildPostContent(text);
    const response = await this.sendLarkMessage(address, 'post', content, replyToMessageId);
    assertLarkOk(response, 'im.message.sendPost');
    return {
      ok: true,
      messageId: response.data?.message_id,
    };
  }

  private async sendInteractiveCard(
    address: ChannelAddress,
    card: Record<string, unknown> | lark.InteractiveCard,
    replyToMessageId?: string,
  ): Promise<{ messageId: string }> {
    const response = await this.sendLarkMessage(address, 'interactive', JSON.stringify(card), replyToMessageId);
    assertLarkOk(response, 'im.message.sendInteractiveCard');
    return { messageId: response.data?.message_id || '' };
  }

  private async sendLarkMessage(
    address: ChannelAddress,
    msgType: 'interactive' | 'post',
    content: string,
    replyToMessageId?: string,
  ): Promise<{ code?: number; msg?: string; data?: { message_id?: string; chat_id?: string } }> {
    if (replyToMessageId) {
      return this.restClient!.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: msgType,
          content,
          ...(address.threadId ? { reply_in_thread: true } : {}),
        },
      });
    }
    const receiveId = address.threadId || address.chatId;
    const receiveIdType = (address.threadId ? 'thread_id' : 'chat_id') as 'thread_id' | 'chat_id';
    return this.restClient!.im.message.create({
      params: { receive_id_type: receiveIdType as never },
      data: {
        receive_id: receiveId,
        msg_type: msgType,
        content,
      },
    });
  }

  private async patchInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const response = await this.restClient!.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
      },
    });
    assertLarkOk(response, 'im.message.patch');
  }

  private async runScopeDiagnostic(): Promise<void> {
    if (!this.restClient) return;
    try {
      const client = this.restClient as unknown as {
        request?: (payload: { method: string; url: string; params?: Record<string, string> }) => Promise<{
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
}

registerAdapterFactory('feishu', () => new FeishuAdapter());
