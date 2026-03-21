import { randomUUID } from 'node:crypto';

import * as lark from '@larksuiteoapi/node-sdk';

import type {
  ChannelAddress,
  ChannelType,
  InboundMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../bridge/types.js';
import type { StructuredInputRequestInfo, StructuredInputResponse } from '../bridge/host.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../bridge/channel-adapter.js';
import { getBridgeContext } from '../bridge/context.js';
import { handlePermissionCallback } from '../bridge/permission-broker.js';
import { validateMode } from '../bridge/security/validators.js';
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
const STREAM_PLACEHOLDER_TEXT = '🤖 努力回答中...';
const PLAN_SUFFIX = ' [PLAN]';
const STRUCTURED_INPUT_PREFIX = 'structured-input';
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

type StructuredActionEvent = lark.InteractiveCardActionEvent & {
  action: lark.InteractiveCardActionEvent['action'] & {
    form_value?: Record<string, unknown>;
    name?: string;
    options?: string[];
    input_value?: string;
    checked?: boolean;
  };
  operator?: {
    open_id?: string;
    user_id?: string;
  };
  context?: {
    open_message_id?: string;
    open_chat_id?: string;
  };
};

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

function stripPlanSuffix(text: string): string {
  return text.replace(/\s*\[PLAN\]$/, '').trim();
}

function defaultChatName(runtime: RuntimeName): string {
  return runtime === 'codex' ? 'Codex 新会话' : 'Claude 新会话';
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
        content: STREAM_PLACEHOLDER_TEXT,
        i18n_content: {
          zh_cn: STREAM_PLACEHOLDER_TEXT,
          en_us: 'Working on it...',
        },
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: STREAM_PLACEHOLDER_TEXT,
          element_id: STREAM_ELEMENT_ID,
        },
      ],
    },
  };
}

function buildActionCard(
  title: string,
  text: string,
  buttons: NonNullable<OutboundMessage['inlineButtons']>,
  template: NonNullable<lark.InteractiveCard['header']>['template'] = 'orange',
): Record<string, unknown> {
  const actionColumns = buttons.flat().map((button) => {
    const lower = button.text.toLowerCase();
    const type: 'default' | 'danger' | 'primary' =
      lower.includes('deny') ? 'danger' : lower.includes('allow') ? 'primary' : 'default';
    return {
      tag: 'column' as const,
      width: 'auto' as const,
      elements: [
        {
          tag: 'button' as const,
          text: {
            tag: 'plain_text' as const,
            content: button.text,
          },
          type,
          behaviors: [
            {
              type: 'callback' as const,
              value: {
                callback_data: button.callbackData,
              },
            },
          ],
        },
      ],
    };
  });
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          horizontal_align: 'left',
          columns: actionColumns,
        },
      ],
    },
  };
}

function buildPermissionCard(text: string, buttons: NonNullable<OutboundMessage['inlineButtons']>): Record<string, unknown> {
  return buildActionCard('Permission Required', text, buttons, 'orange');
}

function buildStructuredFieldName(requestId: string, questionId: string, kind: 'answer' | 'other'): string {
  const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_]/g, '_');
  return `${STRUCTURED_INPUT_PREFIX}_${sanitize(requestId)}_${kind}_${sanitize(questionId)}`;
}

function buildStructuredInputQuestionElements(request: StructuredInputRequestInfo): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: 'Codex 需要你补充一些信息后才能继续。',
    },
  ];

  for (const question of request.questions) {
    elements.push({
      tag: 'markdown',
      content: `**${question.header || question.id}**\n${question.question}`,
    });

    if (question.options?.length) {
      elements.push({
        tag: 'select_static',
        name: buildStructuredFieldName(request.requestId, question.id, 'answer'),
        placeholder: {
          tag: 'plain_text',
          content: '请选择',
        },
        width: 'fill',
        options: question.options.map((option) => ({
          text: {
            tag: 'plain_text',
            content: option.label,
          },
          value: option.label,
        })),
      });
    }

    if (!question.options?.length || question.isOther) {
      elements.push({
        tag: 'input',
        name: buildStructuredFieldName(request.requestId, question.id, 'other'),
        width: 'fill',
        placeholder: {
          tag: 'plain_text',
          content: question.options?.length ? '可补充自定义答案' : '请输入答案',
        },
      });
    }

    if (question.options?.length && question.isOther) {
      elements.push({
        tag: 'markdown',
        content: '如果预设选项都不合适，可填写上面的自定义输入框。',
      });
    }
  }

  elements.push({
    tag: 'column_set',
    horizontal_align: 'right',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            name: `submit_${request.requestId}`,
            form_action_type: 'submit',
            type: 'primary',
            text: {
              tag: 'plain_text',
              content: '提交',
            },
            behaviors: [
              {
                type: 'callback',
                value: {
                  callback_data: `input:submit:${request.requestId}`,
                },
              },
            ],
          },
        ],
      },
    ],
  });

  return [
    {
      tag: 'form',
      name: `form_${request.requestId.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      elements,
    },
  ];
}

function buildResolvedStructuredInputElements(
  request: StructuredInputRequestInfo,
  note: string,
  answers?: StructuredInputResponse['answers'],
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: note,
      },
    },
  ];
  for (const question of request.questions) {
    const submitted = answers?.[question.id]?.answers
      ?.map((answer) => answer.trim())
      .filter(Boolean) || [];
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${question.header || question.id}**\n${question.question}`,
      },
    });
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: submitted.length > 0
          ? `已提交：${submitted.join(' / ')}`
          : '已提交：未记录答案',
      },
    });
  }
  return elements;
}

function buildStructuredInputCard(
  request: StructuredInputRequestInfo,
  options?: { resolved?: boolean; note?: string; answers?: StructuredInputResponse['answers'] },
): Record<string, unknown> {
  const elements = options?.resolved
    ? buildResolvedStructuredInputElements(
        request,
        options.note || '该问答已完成，Codex 正在继续执行。',
        options.answers,
      )
    : buildStructuredInputQuestionElements(request);

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '补充信息',
      },
      template: 'wathet',
    },
    body: {
      elements,
    },
  };
}

function buildStructuredInputFallbackText(request: StructuredInputRequestInfo): string {
  const lines: string[] = ['Codex 需要你补充一些信息后才能继续。', ''];
  request.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header || question.id}`);
    lines.push(question.question);
    if (question.options?.length) {
      lines.push(`可选项：${question.options.map((option) => option.label).join(' / ')}`);
    }
    lines.push('');
  });
  lines.push('当前交互卡发送失败，请转到本地 Codex 继续，或稍后重试。');
  return lines.join('\n').trim();
}

function extractStructuredAnswers(
  request: StructuredInputRequestInfo,
  value: Record<string, unknown> | undefined,
  persistedAnswers?: StructuredInputResponse['answers'],
): StructuredInputResponse {
  const answers: StructuredInputResponse['answers'] = persistedAnswers
    ? JSON.parse(JSON.stringify(persistedAnswers))
    : {};
  const record = value || {};
  for (const question of request.questions) {
    const selected = collectTextFragments(record[buildStructuredFieldName(request.requestId, question.id, 'answer')]);
    const other = collectTextFragments(record[buildStructuredFieldName(request.requestId, question.id, 'other')]);
    const resolved = [...selected, ...other];
    if (resolved.length > 0) {
      answers[question.id] = { answers: resolved };
    }
  }
  return { answers };
}

function isStructuredInputFieldInteraction(event: lark.InteractiveCardActionEvent): boolean {
  const tag = typeof event.action?.tag === 'string' ? event.action.tag : '';
  if (tag === 'select_static' || tag === 'select_person' || tag === 'input') {
    return true;
  }
  const value = event.action?.value;
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => key.startsWith(`${STRUCTURED_INPUT_PREFIX}:`));
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

function buildPlanningPrompt(requestText: string): string {
  return [
    '你现在处于 PLAN 阶段。',
    '只输出计划，不要执行，不要调用工具，不要修改文件，也不要声称已经完成。',
    '请给出简洁、可执行的步骤、前置条件和主要风险。',
    '',
    '需求如下：',
    requestText,
  ].join('\n');
}

function buildPlanExecutionPrompt(requestText: string): string {
  return [
    '用户已经确认上一轮计划，现在开始实施。',
    '不要重复输出完整计划，直接执行当前需求；必要时只保留简短进度说明。',
    '',
    '原始需求如下：',
    requestText,
  ].join('\n');
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
  private outboundMessageQueues = new Map<string, Promise<void>>();
  private lastOutboundMessageAt = new Map<string, number>();

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
      'im.message.message_read_v1': async () => {},
      'card.action.trigger': async (data: unknown) => {
        try {
          return await this.handleCardAction(data as StructuredActionEvent);
        } catch (error) {
          console.warn('[feishu-adapter] card.action.trigger handler error:', error);
          return {
            toast: {
              type: 'error',
              content: '交互处理失败，请稍后重试。',
            },
          };
        }
      },
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
    this.outboundMessageQueues.clear();
    this.lastOutboundMessageAt.clear();
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
    if (reactionId && messageId) {
      this.typingReactions.delete(routeKey);
      void this.restClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }).catch(() => {});
    }
    void this.syncChatName(address.chatId);
  }

  getPreviewCapabilities(address: ChannelAddress): PreviewCapabilities | null {
    const store = this.getStore();
    if (!store.getChannelBinding(this.channelType, address.chatId)) {
      return null;
    }
    return {
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    };
  }

  async sendPreview(address: ChannelAddress, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.restClient) return 'skip';
    const processedText = preprocessFeishuMarkdown(text);
    if (!processedText.trim()) return 'skip';
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

  async primePreview(address: ChannelAddress, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.restClient) return 'skip';
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    if (this.previewArtifacts.has(key)) {
      return 'sent';
    }
    const createdArtifact = await this.createPreviewArtifact(address, draftId, '');
    if (!createdArtifact) return 'degrade';
    this.previewArtifacts.set(key, createdArtifact);
    this.activePreviewByRoute.set(routeKey, key);
    return 'sent';
  }

  endPreview(address: ChannelAddress, draftId: number): void {
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    this.previewArtifacts.delete(key);
    if (this.activePreviewByRoute.get(routeKey) === key) {
      this.activePreviewByRoute.delete(routeKey);
    }
  }

  async sendStructuredInputRequest(
    address: ChannelAddress,
    request: StructuredInputRequestInfo,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const hasSecret = request.questions.some((question) => question.isSecret);
    if (hasSecret) {
      await this.sendAsPost(
        address,
        '当前问题包含敏感输入，飞书群聊不适合采集。请转到本地 Codex 继续。',
        replyToMessageId,
      );
      getBridgeContext().permissions.resolvePendingStructuredInput?.(request.requestId, { answers: {} });
      return { ok: true };
    }
    const result = await this.sendInteractiveCard(
      address,
      buildStructuredInputCard(request),
      replyToMessageId,
    );
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  async resolveStructuredInputRequest(requestId: string): Promise<void> {
    const request = this.getStore().getStructuredInputRequest(requestId);
    if (!request?.messageId) return;
    try {
      await this.patchInteractiveCard(
        request.messageId,
        buildStructuredInputCard({
          requestId: request.requestId,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          questions: request.questions,
        }, {
          resolved: true,
          note: '该问答已完成，Codex 正在继续执行。',
          answers: request.draftAnswers,
        }),
      );
    } catch (error) {
      console.warn('[feishu-adapter] Failed to resolve structured input card:', error);
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    if (message.rawCard) {
      const result = await this.sendInteractiveCard(message.address, message.rawCard, message.replyToMessageId);
      return {
        ok: true,
        messageId: result.messageId,
        openMessageId: result.openMessageId,
      };
    }

    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(
        message.address,
        normalizeMarkdown(message),
        message.inlineButtons,
        message.replyToMessageId,
        message.cardHeader,
      );
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
          return { ok: true, messageId: artifact.messageId, openMessageId: artifact.messageId };
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

  private async handleCardAction(event: StructuredActionEvent): Promise<{ toast: { type: string; content: string } }> {
    const callbackData = typeof event.action?.value?.callback_data === 'string'
      ? event.action.value.callback_data
      : '';
    console.log(
      `[feishu-adapter] card.action.trigger tag=${event.action?.tag || 'unknown'} ` +
      `open_message_id=${event.open_message_id || event.context?.open_message_id || 'unknown'} ` +
      `callback=${callbackData || '(none)'}`,
    );
    if (!callbackData) {
      if (isStructuredInputFieldInteraction(event)) {
        return { toast: { type: 'success', content: '已记录选择，填写完成后点击提交。' } };
      }
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    if (callbackData.startsWith('perm:')) {
      const store = this.getStore();
      const permissionRequestId = callbackData.split(':').slice(2).join(':');
      const link = store.getPermissionLink(permissionRequestId);
      if (link && handlePermissionCallback(callbackData, link.chatId, event.open_message_id)) {
        return { toast: { type: 'success', content: 'Permission updated' } };
      }
      return { toast: { type: 'warning', content: 'Permission already handled' } };
    }
    if (callbackData.startsWith('input:')) {
      return this.handleStructuredInputCardAction(event, callbackData);
    }
    if (callbackData.startsWith('plan:')) {
      return this.handlePlanCardAction(event, callbackData);
    }
    return { toast: { type: 'warning', content: 'Unsupported action' } };
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
    const store = this.getStore();
    const text = inbound.text.trim();
    const lower = text.toLowerCase();
    const binding = store.getChannelBinding(this.channelType, inbound.address.chatId);
    const workflow = binding ? store.getActivePlanWorkflowByBinding(binding.id) : null;

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
    if (lower.startsWith('/mode')) {
      if (!binding) {
        await this.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
        return;
      }
      await this.handleModeCommand(binding.id, text, inbound.address, inbound.messageId);
      return;
    }
    if (lower === '/plan' || lower.startsWith('/plan ')) {
      if (!binding) {
        await this.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
        return;
      }
      await this.handlePlanCommand(binding.id, inbound);
      return;
    }
    if (lower.startsWith('/new')) {
      await this.sendAsPost(inbound.address, '请先私聊 Bot 使用 `/new:claude` 或 `/new:codex` 创建新会话。', inbound.messageId);
      return;
    }
    if (lower.startsWith('/')) {
      await this.sendAsPost(inbound.address, '该群仅支持普通对话、`/plan`、`/mode`、`/reset` 与 `/perm ...`。如需新会话，请私聊 Bot。', inbound.messageId);
      return;
    }

    if (!binding) {
      await this.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    if (workflow) {
      const consumed = await this.handlePlanWorkflowMessage(binding.id, workflow.workflowId, inbound);
      if (consumed) return;
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
      await this.syncChatName(chatId);
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
    const workflow = store.getActivePlanWorkflowByBinding(binding.id);
    if (workflow) {
      store.deletePlanWorkflow(workflow.workflowId);
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
    await this.syncChatName(address.chatId);
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

  private async handleModeCommand(bindingId: string, text: string, address: ChannelAddress, replyToMessageId?: string): Promise<void> {
    const parts = text.trim().split(/\s+/);
    const mode = parts[1]?.toLowerCase() || '';
    if (!validateMode(mode)) {
      await this.sendAsPost(address, '用法：`/mode plan|code|ask`。', replyToMessageId);
      return;
    }
    const store = this.getStore();
    const binding = Array.from(store.listChannelBindings(this.channelType)).find((item) => item.id === bindingId);
    if (!binding) {
      await this.sendAsPost(address, '当前群尚未绑定会话。', replyToMessageId);
      return;
    }
    const runtime = store.getSessionExt(binding.codepilotSessionId)?.runtime || 'claude';
    if (runtime === 'codex' && mode === 'plan') {
      const llm = getBridgeContext().llm as MultiplexLLMProvider & {
        ensureCodexNativePlanAvailable?: () => Promise<void>;
      };
      try {
        await llm.ensureCodexNativePlanAvailable?.();
      } catch (error) {
        await this.sendAsPost(
          address,
          `当前本地 Codex 不支持原生 plan：${error instanceof Error ? error.message : String(error)}`,
          replyToMessageId,
        );
        return;
      }
    }
    const workflow = store.getActivePlanWorkflowByBinding(bindingId);
    if (workflow) {
      store.deletePlanWorkflow(workflow.workflowId);
    }
    store.updateChannelBinding(bindingId, { mode });
    await this.syncChatName(address.chatId);
    await this.sendAsPost(address, `已切换到 ${mode} 模式。`, replyToMessageId);
  }

  private async handlePlanCommand(bindingId: string, inbound: InboundMessage): Promise<void> {
    const store = this.getStore();
    const binding = Array.from(store.listChannelBindings(this.channelType)).find((item) => item.id === bindingId);
    if (!binding) {
      await this.sendAsPost(inbound.address, '当前群尚未绑定会话。', inbound.messageId);
      return;
    }
    const runtime = store.getSessionExt(binding.codepilotSessionId)?.runtime || 'claude';
    const existing = store.getActivePlanWorkflowByBinding(bindingId);
    if (existing) {
      await this.sendAsPost(
        inbound.address,
        runtime === 'codex'
          ? existing.status === 'awaiting_confirmation'
            ? '当前群已有待确认的原生 PLAN 结果。请点击上一张计划卡片中的“是，实施此计划”，或直接在原线程回复告诉 Codex 如何调整；也可以使用 `/mode ...` / `/reset` 覆盖。'
            : '当前群已有等待中的原生 PLAN 请求。请先在原线程继续输入，或使用 `/mode ...` / `/reset` 覆盖。'
          : '当前群已有进行中的 PLAN 流程。请先点击上一张计划卡片中的“执行 / 继续 / 取消”，或使用 `/mode ...` / `/reset` 覆盖。',
        inbound.messageId,
      );
      return;
    }

    const requestText = inbound.text.trim().slice('/plan'.length).trim();
    if (runtime === 'codex') {
      const llm = getBridgeContext().llm as MultiplexLLMProvider & {
        ensureCodexNativePlanAvailable?: () => Promise<void>;
      };
      try {
        await llm.ensureCodexNativePlanAvailable?.();
      } catch (error) {
        await this.sendAsPost(
          inbound.address,
          `当前本地 Codex 不支持原生 plan：${error instanceof Error ? error.message : String(error)}`,
          inbound.messageId,
        );
        return;
      }
      if (!requestText) {
        store.upsertPlanWorkflow({
          bindingId,
          channelType: this.channelType,
          chatId: inbound.address.chatId,
          codepilotSessionId: binding.codepilotSessionId,
          status: 'awaiting_input',
          previousMode: binding.mode,
          requestText: '',
          address: inbound.address,
          routeKey: routeKeyForAddress(inbound.address),
          requestMessageId: inbound.messageId,
          resolved: true,
        });
        await this.syncChatName(inbound.address.chatId);
        await this.sendAsPost(inbound.address, '已进入原生 PLAN 流程。下一条同线程消息将作为 plan 请求发送给 Codex。', inbound.messageId);
        return;
      }
      const workflow = store.upsertPlanWorkflow({
        bindingId,
        channelType: this.channelType,
        chatId: inbound.address.chatId,
        codepilotSessionId: binding.codepilotSessionId,
        status: 'planning',
        previousMode: binding.mode,
        requestText,
        address: inbound.address,
        routeKey: routeKeyForAddress(inbound.address),
        requestMessageId: inbound.messageId,
        resolved: true,
      });
      await this.syncChatName(inbound.address.chatId);
      this.enqueue(this.buildNativePlanRequestInbound(inbound.address, inbound.messageId, workflow.workflowId, requestText));
      return;
    }

    const workflow = store.upsertPlanWorkflow({
      bindingId,
      channelType: this.channelType,
      chatId: inbound.address.chatId,
      codepilotSessionId: binding.codepilotSessionId,
      status: requestText ? 'planning' : 'awaiting_input',
      previousMode: binding.mode,
      requestText,
      address: inbound.address,
      routeKey: routeKeyForAddress(inbound.address),
      requestMessageId: inbound.messageId,
      resolved: true,
    });
    await this.syncChatName(inbound.address.chatId);

    if (!requestText) {
      await this.sendAsPost(inbound.address, '已进入 PLAN 流程。下一条非命令消息将作为规划需求。', inbound.messageId);
      return;
    }

    this.enqueue(this.buildPlanRequestInbound(inbound.address, inbound.messageId, workflow.workflowId, requestText));
  }

  private async handlePlanWorkflowMessage(bindingId: string, workflowId: string, inbound: InboundMessage): Promise<boolean> {
    const store = this.getStore();
    const workflow = store.getPlanWorkflow(workflowId);
    if (!workflow) return false;
    const binding = Array.from(store.listChannelBindings(this.channelType)).find((item) => item.id === bindingId);
    const runtime = binding ? (store.getSessionExt(binding.codepilotSessionId)?.runtime || 'claude') : 'claude';
    const routeKey = routeKeyForAddress(inbound.address);
    if (workflow.routeKey !== routeKey) {
      await this.sendAsPost(
        inbound.address,
        '当前 PLAN 流程已在另一条线程中进行，请回原线程继续或先取消。',
        inbound.messageId,
      );
      return true;
    }
    if (workflow.bindingId !== bindingId) return false;

    switch (workflow.status) {
      case 'awaiting_input':
        if (runtime === 'codex') {
          store.updatePlanWorkflow(workflow.workflowId, {
            status: 'planning',
            requestText: inbound.text.trim(),
            address: inbound.address,
            routeKey,
            requestMessageId: inbound.messageId,
            resolved: true,
          });
          this.enqueue(this.buildNativePlanRequestInbound(inbound.address, inbound.messageId, workflow.workflowId, inbound.text.trim()));
          return true;
        }
        store.updatePlanWorkflow(workflow.workflowId, {
          status: 'planning',
          requestText: inbound.text.trim(),
          address: inbound.address,
          routeKey,
          requestMessageId: inbound.messageId,
          planMessageId: '',
          actionCardMessageId: '',
          resolved: true,
        });
        this.enqueue(this.buildPlanRequestInbound(inbound.address, inbound.messageId, workflow.workflowId, inbound.text.trim()));
        return true;
      case 'planning':
        await this.sendAsPost(inbound.address, '当前 PLAN 请求正在处理中，请等待本轮计划完成。', inbound.messageId);
        return true;
      case 'awaiting_confirmation':
        if (runtime === 'codex') {
          const requestText = inbound.text.trim();
          store.updatePlanWorkflow(workflow.workflowId, {
            status: 'planning',
            requestText,
            address: inbound.address,
            routeKey,
            requestMessageId: inbound.messageId,
            actionCardMessageId: '',
            actionCardOpenMessageId: '',
            resolved: true,
          });
          this.enqueue(this.buildNativePlanRequestInbound(inbound.address, inbound.messageId, workflow.workflowId, requestText));
          return true;
        }
        await this.sendAsPost(inbound.address, '请先点击上一张计划卡片中的“执行 / 继续 / 取消”。', inbound.messageId);
        return true;
      default:
        return false;
    }
  }

  private buildPlanRequestInbound(address: ChannelAddress, messageId: string, workflowId: string, requestText: string): InboundMessage {
    return {
      messageId,
      address,
      text: requestText,
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId,
          promptText: buildPlanningPrompt(requestText),
          storedUserText: requestText,
          permissionMode: 'plan',
        },
      },
    };
  }

  private buildNativePlanRequestInbound(address: ChannelAddress, messageId: string, workflowId: string, requestText: string): InboundMessage {
    return {
      messageId,
      address,
      text: requestText,
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'native_plan_request',
          workflowId,
          promptText: requestText,
          storedUserText: requestText,
          permissionMode: 'plan',
          collaborationMode: 'plan',
        },
      },
    };
  }

  private buildPlanExecutionInbound(address: ChannelAddress, messageId: string, workflowId: string, requestText: string): InboundMessage {
    const storedUserText = `执行已确认计划：${requestText}`;
    return {
      messageId,
      address,
      text: storedUserText,
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_execute',
          workflowId,
          promptText: buildPlanExecutionPrompt(requestText),
          storedUserText,
          permissionMode: 'acceptEdits',
          collaborationMode: 'default',
        },
      },
    };
  }

  private async handleStructuredInputCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const [, action, requestId, questionId] = callbackData.split(':');
    if (!requestId) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    const store = this.getStore();
    const request = store.getStructuredInputRequest(requestId);
    if (!request) {
      return { toast: { type: 'warning', content: '问答请求不存在或已失效' } };
    }

    const actionMessageId = event.open_message_id || event.context?.open_message_id || '';
    const knownIds = [request.messageId, request.openMessageId].filter((value): value is string => !!value);
    if (knownIds.length > 1 && !knownIds.includes(actionMessageId)) {
      return { toast: { type: 'warning', content: '问答卡已过期' } };
    }

    if (action === 'field' && questionId) {
      const selected = collectTextFragments(event.action?.option);
      if (selected.length === 0) {
        return { toast: { type: 'warning', content: '未读取到所选项' } };
      }
      const nextDraftAnswers = extractStructuredAnswers(
        {
          requestId: request.requestId,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          questions: request.questions,
        },
        undefined,
        {
          ...(request.draftAnswers || {}),
          [questionId]: { answers: selected },
        },
      ).answers;
      store.updateStructuredInputRequest(requestId, { draftAnswers: nextDraftAnswers });
      return { toast: { type: 'success', content: '已记录选择，填写完成后点击提交。' } };
    }

    if (action !== 'submit') {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }

    const hasSecret = request.questions.some((question) => question.isSecret);
    if (hasSecret) {
      if (!store.markStructuredInputRequestResolved(requestId)) {
        return { toast: { type: 'warning', content: '问答已经提交过了' } };
      }
      setImmediate(() => {
        void this.resolveStructuredInputRequest(requestId);
        getBridgeContext().permissions.resolvePendingStructuredInput?.(requestId, { answers: {} });
      });
      return { toast: { type: 'warning', content: '该问题涉及敏感输入，请转到本地 Codex 继续' } };
    }

    const answers = extractStructuredAnswers(
      request,
      ((event.action?.form_value || event.action?.value) as Record<string, unknown> | undefined),
      request.draftAnswers,
    );
    const hasAnswers = Object.keys(answers.answers).length > 0;
    if (!hasAnswers) {
      return { toast: { type: 'warning', content: '请至少填写一个答案' } };
    }

    store.updateStructuredInputRequest(requestId, { draftAnswers: answers.answers });

    if (!store.markStructuredInputRequestResolved(requestId)) {
      return { toast: { type: 'warning', content: '问答已经提交过了' } };
    }

    setImmediate(() => {
      const resolved = getBridgeContext().permissions.resolvePendingStructuredInput?.(requestId, answers);
      if (!resolved) {
        store.updateStructuredInputRequest(requestId, { resolved: false });
        return;
      }
      void this.resolveStructuredInputRequest(requestId);
    });

    return { toast: { type: 'success', content: '答案已提交' } };
  }

  private async handlePlanCardAction(
    event: lark.InteractiveCardActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const [, action, workflowId] = callbackData.split(':');
    if (!workflowId || !action) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    const store = this.getStore();
    const workflow = store.getPlanWorkflow(workflowId);
    if (!workflow) {
      return { toast: { type: 'warning', content: 'PLAN workflow not found' } };
    }
    const knownIds = [
      workflow.actionCardMessageId,
      workflow.actionCardOpenMessageId,
    ].filter((value): value is string => !!value);
    if (knownIds.length > 1 && !knownIds.includes(event.open_message_id)) {
      return { toast: { type: 'warning', content: 'PLAN card is stale' } };
    }
    if (workflow.status !== 'awaiting_confirmation') {
      return { toast: { type: 'warning', content: 'PLAN workflow is no longer waiting for confirmation' } };
    }
    if (!store.markPlanWorkflowResolved(workflowId)) {
      return { toast: { type: 'warning', content: 'PLAN action already handled' } };
    }

    const binding = store.getChannelBinding(this.channelType, workflow.chatId);
    switch (action) {
      case 'execute':
        if (binding) {
          store.updateChannelBinding(binding.id, { mode: 'code' });
        }
        store.deletePlanWorkflow(workflowId);
        await this.syncChatName(workflow.chatId);
        this.enqueue(this.buildPlanExecutionInbound(
          workflow.address,
          workflow.requestMessageId || workflow.planMessageId || workflow.actionCardMessageId || workflow.workflowId,
          workflowId,
          workflow.requestText,
        ));
        return { toast: { type: 'success', content: '开始执行已确认计划' } };
      case 'continue':
        store.updatePlanWorkflow(workflowId, {
          status: 'awaiting_input',
          resolved: true,
        });
        await this.syncChatName(workflow.chatId);
        return { toast: { type: 'success', content: '继续保持 PLAN 模式' } };
      case 'cancel':
        if (binding) {
          store.updateChannelBinding(binding.id, { mode: workflow.previousMode });
        }
        store.deletePlanWorkflow(workflowId);
        await this.syncChatName(workflow.chatId);
        return { toast: { type: 'success', content: '已取消 PLAN 流程' } };
      default:
        store.updatePlanWorkflow(workflowId, { resolved: false });
        return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
  }

  private async createSessionGroup(runtime: RuntimeName, sender: SenderIdentity): Promise<string> {
    if (!this.restClient) throw new Error('Feishu client not initialized');
    const response = await this.restClient.im.chat.create({
      params: {
        user_id_type: sender.type,
        set_bot_manager: true,
      },
      data: {
        name: defaultChatName(runtime),
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
      store.updateSessionExt(binding.codepilotSessionId, {
        title,
        titleStatus: 'done',
      });
      await this.syncChatName(chatId);
    } catch (error) {
      console.warn('[feishu-adapter] Failed to rename chat:', error);
      store.updateSessionExt(binding.codepilotSessionId, {
        title: fallbackTitle,
        titleStatus: 'failed',
      });
      await this.syncChatName(chatId);
    } finally {
      this.pendingTitles.delete(chatId);
    }
  }

  private shouldDecoratePlan(bindingId: string, mode: 'code' | 'plan' | 'ask'): boolean {
    if (mode === 'plan') return true;
    return !!this.getStore().getActivePlanWorkflowByBinding(bindingId);
  }

  private computeChatDisplayName(chatId: string): string | null {
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId);
    if (!binding) return null;
    const ext = store.getSessionExt(binding.codepilotSessionId);
    const runtime = ext?.runtime || 'claude';
    const baseName = stripPlanSuffix(ext?.title || defaultChatName(runtime));
    if (!this.shouldDecoratePlan(binding.id, binding.mode)) {
      return baseName;
    }
    return `${baseName}${PLAN_SUFFIX}`;
  }

  private async syncChatName(chatId: string): Promise<void> {
    if (!this.restClient) return;
    const chatApi = this.restClient.im?.chat;
    if (!chatApi?.update) return;
    const name = this.computeChatDisplayName(chatId);
    if (!name) return;
    try {
      const response = await chatApi.update({
        path: { chat_id: chatId },
        data: { name },
      });
      assertLarkOk(response, 'im.chat.update');
    } catch (error) {
      console.warn('[feishu-adapter] Failed to sync chat name:', error);
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
        const fallbackText = text.trim() ? text : STREAM_PLACEHOLDER_TEXT;
        const sendResult = await this.sendInteractiveCard(address, buildSimpleCard(fallbackText), replyToMessageId);
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
    cardHeader?: OutboundMessage['cardHeader'],
  ): Promise<SendResult> {
    const card = cardHeader
      ? buildActionCard(cardHeader.title, text, buttons, cardHeader.template || 'blue')
      : buildPermissionCard(text, buttons);
    const result = await this.sendInteractiveCard(address, card, replyToMessageId);
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private async sendAsInteractiveCard(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult> {
    const content = buildCardContent(text);
    const response = await this.sendLarkMessage(address, 'interactive', content, replyToMessageId);
    assertLarkOk(response, 'im.message.sendInteractive');
    return {
      ok: true,
      messageId: response.data?.message_id,
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private async sendAsPost(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult> {
    const content = buildPostContent(text);
    const response = await this.sendLarkMessage(address, 'post', content, replyToMessageId);
    assertLarkOk(response, 'im.message.sendPost');
    return {
      ok: true,
      messageId: response.data?.message_id,
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private async sendInteractiveCard(
    address: ChannelAddress,
    card: Record<string, unknown> | lark.InteractiveCard,
    replyToMessageId?: string,
  ): Promise<{ messageId: string; openMessageId?: string }> {
    const response = await this.sendLarkMessage(address, 'interactive', JSON.stringify(card), replyToMessageId);
    assertLarkOk(response, 'im.message.sendInteractiveCard');
    return {
      messageId: response.data?.message_id || '',
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private async sendLarkMessage(
    address: ChannelAddress,
    msgType: 'interactive' | 'post',
    content: string,
    replyToMessageId?: string,
  ): Promise<{ code?: number; msg?: string; data?: { message_id?: string; open_message_id?: string; chat_id?: string } }> {
    return this.enqueueOutboundMessage(address.chatId, async () => {
      if (replyToMessageId) {
        return this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            msg_type: msgType,
            content,
            uuid: randomUUID().slice(0, 50),
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
          uuid: randomUUID().slice(0, 50),
        },
      });
    });
  }

  private async enqueueOutboundMessage<T>(
    chatId: string,
    task: () => Promise<T>,
  ): Promise<T> {
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
