import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import * as lark from '@larksuiteoapi/node-sdk';

import type {
  ActivityEvent,
  ChannelAddress,
  ChannelBinding,
  ChannelType,
  FileAttachment,
  InboundMessage,
  OutboundImage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../bridge/types.js';
import { DEFAULT_CHANNEL_INSTANCE_ID, resolveChannelInstanceId } from '../bridge/types.js';
import type { StructuredInputRequestInfo, StructuredInputResponse } from '../bridge/host.js';
import { BaseChannelAdapter } from '../bridge/channel-adapter.js';
import { getBridgeContext } from '../bridge/context.js';
import { appendLocalCommandExchange } from '../bridge/local-command-history.js';
import { validateMode } from '../bridge/security/validators.js';
import {
  buildCardContent,
  buildPostContent,
  hasComplexMarkdown,
  preprocessFeishuMarkdown,
} from '../bridge/markdown/feishu.js';
import {
  CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE,
  buildHandledClaudePlanExitCard,
  buildClaudePlanExecutionPrompt,
  buildClaudePlanFollowUpPrompt,
  buildClaudePlanModeUpdates,
} from '../runtime/claude-plan-exit.js';
import {
  getClaudeModeSuffix,
  getClaudeModeTitle,
  normalizeClaudePermissionMode,
} from '../runtime/claude-mode.js';
import type { ClaudePermissionMode } from '../runtime/claude-mode.js';
import {
  listRecentNativeSessions,
  type NativeReplayItem,
} from '../infra/native-session-history.js';

import type { MultiplexLLMProvider } from '../providers/multiplex.js';
import { listRecentWorkspaces, type RecentWorkspaceOption } from '../infra/recent-workspaces.js';
import type { RuntimeName } from '../runtime/types.js';
import { JsonFileStore } from '../infra/store.js';
import {
  extractActionSenderIdentity as extractActionSenderIdentityWithContext,
  findBindingById as findBindingByIdWithContext,
  handleCardAction as handleCardActionWithContext,
  handleClaudePlanExitCardAction as handleClaudePlanExitCardActionWithContext,
  handleCreateSessionCommand as handleCreateSessionCommandWithContext,
  handleDirectMessage as handleDirectMessageWithContext,
  handleGroupMessage as handleGroupMessageWithContext,
  handleIncomingEvent as handleIncomingEventWithContext,
  handleModeCommand as handleModeCommandWithContext,
  handleNewSessionCardAction as handleNewSessionCardActionWithContext,
  handlePlanCardAction as handlePlanCardActionWithContext,
  handlePlanCommand as handlePlanCommandWithContext,
  handlePlanWorkflowMessage as handlePlanWorkflowMessageWithContext,
  handleResetCommand as handleResetCommandWithContext,
  handleResumeCardAction as handleResumeCardActionWithContext,
  handleResumeSessionCommand as handleResumeSessionCommandWithContext,
  handleStructuredInputCardAction as handleStructuredInputCardActionWithContext,
  patchActionCardSafely as patchActionCardSafelyWithContext,
  replayNativeSessionHistory as replayNativeSessionHistoryWithContext,
} from './handlers/index.js';
import { LarkClient } from './lark-client.js';
import {
  buildActivityCard,
  buildActionCard,
  buildClaudeModeCard,
  buildHandledPermissionCard,
  buildHandledPlanCard,
  buildNewClaudeSessionCard,
  buildNewCodexSessionCard,
  buildPermissionCard,
  buildReplayMessageText,
  buildResumeSessionCard,
  buildSimpleCard,
  buildStatusCard,
  buildStreamingCardSkeleton,
  buildStructuredInputCard,
  buildStructuredInputFallbackText,
  extractStructuredAnswers,
  getActivityEventId,
  isStructuredInputFieldInteraction,
  splitReplayText,
} from './cards/index.js';
import {
  NEW_SESSION_WORKDIR_FIELD,
  PENDING_INBOUND_IMAGE_TTL_MS,
  PLAN_SUFFIX,
  STREAM_ELEMENT_ID,
  STREAM_PLACEHOLDER_TEXT,
  TYPING_EMOJI,
  findMissingAppScopes,
} from './constants.js';
import type {
  ActivityArtifact,
  FeishuAdapterOptions,
  FeishuChatUpdatedEventData,
  FeishuMessageEventData,
  PendingActivitySend,
  PendingInboundImage,
  PreviewArtifact,
  SenderIdentity,
  StructuredActionEvent,
} from './types.js';
import { ActivityService } from './services/activity-service.js';
import { InboundImageService } from './services/inbound-image-service.js';
import { PreviewService } from './services/preview-service.js';
import {
  activityKey,
  assertLarkOk,
  buildPlanExecutionPrompt,
  buildPlanningPrompt,
  buildRouteKey,
  collectTextFragments,
  defaultChatName,
  extensionForMimeType,
  isNonEmptyString,
  isRecoverableMessageSendError,
  normalizeMarkdown,
  normalizePath,
  parseImageResourceKey,
  parseTextContent,
  pendingInboundImageKey,
  previewKey,
  resolveActionOpenMessageId,
  resolveClaudeBindingMode,
  routeKeyForAddress,
  stableMessageUuid,
  stripClaudeModeSuffix,
} from './utils.js';

export { FEISHU_REQUIRED_APP_SCOPES, findMissingAppScopes } from './constants.js';
export type { FeishuAdapterOptions } from './types.js';

function isToolCallActivityEvent(event: ActivityEvent): boolean {
  return event.kind === 'tool_activity'
    || event.kind === 'command_execution'
    || event.kind === 'file_change';
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';
  private readonly instanceAdapterId: string;
  private readonly instanceProfileId: string;
  private static readonly SELF_RENAME_ECHO_TTL_MS = 30_000;

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private chatQueues = new Map<string, Promise<void>>();
  private seenMessageIds = new Map<string, number>();
  private lastIncomingMessageId = new Map<string, string>();
  private typingReactions = new Map<string, string>();
  private pendingTitleSyncs = new Set<string>();
  private knownChatNames = new Map<string, string>();
  private selfRenameEchoes = new Map<string, number>();
  private readonly larkClient = new LarkClient();
  private readonly previewService = new PreviewService(
    this.larkClient,
    (routeKey) => this.lastIncomingMessageId.get(routeKey),
  );
  private readonly activityService = new ActivityService(
    this.larkClient,
    (routeKey) => this.lastIncomingMessageId.get(routeKey),
  );
  private readonly inboundImageService = new InboundImageService(
    () => this.restClient,
  );

  constructor(
    private readonly options: FeishuAdapterOptions = {
      profile: {
        id: DEFAULT_CHANNEL_INSTANCE_ID,
      },
    },
  ) {
    super();
    this.instanceProfileId = options.profile.id || DEFAULT_CHANNEL_INSTANCE_ID;
    this.instanceAdapterId = `${this.channelType}:${this.instanceProfileId}`;
  }

  get adapterId(): string {
    return this.instanceAdapterId;
  }

  get profileId(): string {
    return this.instanceProfileId;
  }

  get label(): string {
    return this.instanceProfileId;
  }

  get restClient(): lark.Client | null {
    return this.larkClient.getClient();
  }

  set restClient(client: lark.Client | null) {
    this.larkClient.setClient(client);
  }

  get previewArtifacts(): Map<string, PreviewArtifact> {
    return this.previewService.previewArtifacts;
  }

  get activePreviewByRoute(): Map<string, string> {
    return this.previewService.activePreviewByRoute;
  }

  get activityArtifacts(): Map<string, ActivityArtifact> {
    return this.activityService.activityArtifacts;
  }

  get pendingActivitySends(): Map<string, PendingActivitySend> {
    return this.activityService.pendingActivitySends;
  }

  get pendingInboundImages(): Map<string, PendingInboundImage> {
    return this.inboundImageService.pendingInboundImages;
  }

  get outboundMessageQueues(): Map<string, Promise<void>> {
    return this.larkClient.outboundMessageQueues;
  }

  get lastOutboundMessageAt(): Map<string, number> {
    return this.larkClient.lastOutboundMessageAt;
  }

  private getLarkClient(): LarkClient {
    return this.larkClient;
  }

  private getPreviewService(): PreviewService {
    return this.previewService;
  }

  private getActivityService(): ActivityService {
    return this.activityService;
  }

  private getInboundImageService(): InboundImageService {
    return this.inboundImageService;
  }

  private setLastIncomingMessageId(routeKey: string, messageId: string): void {
    this.lastIncomingMessageId.set(routeKey, messageId);
  }

  private markSeenMessage(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return false;
    this.seenMessageIds.set(messageId, Date.now());
    if (this.seenMessageIds.size > 1000) {
      const first = this.seenMessageIds.keys().next().value;
      if (first) this.seenMessageIds.delete(first);
    }
    return true;
  }

  private getHandlerContext(): import('./types.js').AdapterContext {
    return {
      channelType: this.channelType,
      profileId: this.profileId,
      label: this.label,
      getStore: this.getStore.bind(this),
      getLarkClient: this.getLarkClient.bind(this),
      getPreviewService: this.getPreviewService.bind(this),
      getActivityService: this.getActivityService.bind(this),
      getInboundImageService: this.getInboundImageService.bind(this),
      withInstance: this.withInstance.bind(this),
      isAuthorized: this.isAuthorized.bind(this),
      setLastIncomingMessageId: this.setLastIncomingMessageId.bind(this),
      markSeenMessage: this.markSeenMessage.bind(this),
      enqueue: this.enqueue.bind(this),
      enqueueChatTask: this.enqueueChatTask.bind(this),
      sendAsPost: this.sendAsPost.bind(this),
      sendAsInteractiveCard: this.sendAsInteractiveCard.bind(this),
      sendInteractiveCard: this.sendInteractiveCard.bind(this),
      patchInteractiveCard: this.patchInteractiveCard.bind(this),
      patchActionCardSafely: this.patchActionCardSafely.bind(this),
      handleCreateSessionCommand: this.handleCreateSessionCommand.bind(this),
      handleNewSessionCardAction: this.handleNewSessionCardAction.bind(this),
      handleClaudeModeCardAction: this.handleClaudeModeCardAction.bind(this),
      handleResumeSessionCommand: this.handleResumeSessionCommand.bind(this),
      handleResumeCardAction: this.handleResumeCardAction.bind(this),
      handleResetCommand: this.handleResetCommand.bind(this),
      handleModeCommand: this.handleModeCommand.bind(this),
      handlePlanCommand: this.handlePlanCommand.bind(this),
      handlePlanWorkflowMessage: this.handlePlanWorkflowMessage.bind(this),
      handlePlanCardAction: this.handlePlanCardAction.bind(this),
      handleClaudePlanExitCardAction: this.handleClaudePlanExitCardAction.bind(this),
      handleStructuredInputCardAction: this.handleStructuredInputCardAction.bind(this),
      resolveStructuredInputRequest: this.resolveStructuredInputRequest.bind(this),
      getRecentWorkspaceOptions: this.getRecentWorkspaceOptions.bind(this),
      resolveSelectedWorkdir: this.resolveSelectedWorkdir.bind(this),
      createBoundSession: this.createBoundSession.bind(this),
      ensureRuntimeAvailable: this.ensureRuntimeAvailable.bind(this),
      sendNewSessionCard: this.sendNewSessionCard.bind(this),
      sendClaudeModeCard: this.sendClaudeModeCard.bind(this),
      appendBindingCommandExchange: this.appendBindingCommandExchange.bind(this),
      syncChatName: this.syncChatName.bind(this),
      findBindingById: this.findBindingById.bind(this),
      extractActionSenderIdentity: this.extractActionSenderIdentity.bind(this),
      replayNativeSessionHistory: this.replayNativeSessionHistory.bind(this),
      buildPlanRequestInbound: this.buildPlanRequestInbound.bind(this),
      buildNativePlanRequestInbound: this.buildNativePlanRequestInbound.bind(this),
      buildPlanExecutionInbound: this.buildPlanExecutionInbound.bind(this),
      prunePendingInboundImages: this.prunePendingInboundImages.bind(this),
      setPendingInboundImage: this.setPendingInboundImage.bind(this),
      downloadInboundImageAttachment: this.downloadInboundImageAttachment.bind(this),
      resolveReferencedInboundImages: this.resolveReferencedInboundImages.bind(this),
    };
  }

  private withInstance(address: ChannelAddress): ChannelAddress {
    return {
      ...address,
      channelInstanceId: resolveChannelInstanceId(address) === DEFAULT_CHANNEL_INSTANCE_ID
        ? this.profileId
        : resolveChannelInstanceId(address),
    };
  }

  private usesLegacyStoreSettings(): boolean {
    return !this.options.profile.appId && !this.options.profile.appSecret;
  }

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
      'im.chat.updated_v1': async (data: unknown) => {
        await this.handleChatUpdatedEvent(data as FeishuChatUpdatedEventData);
      },
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
    void this.larkClient.runScopeDiagnostic();
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
    this.pendingTitleSyncs.clear();
    this.knownChatNames.clear();
    this.selfRenameEchoes.clear();
    this.previewService.reset();
    this.activityService.reset();
    this.inboundImageService.reset();
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
    const store = this.tryGetStore();
    const appId = this.options.profile.appId || store?.getSetting('bridge_feishu_app_id') || '';
    const appSecret = this.options.profile.appSecret || store?.getSetting('bridge_feishu_app_secret') || '';
    if (!appId) return `${this.label}: CTI_FEISHU_APP_ID is required`;
    if (!appSecret) return `${this.label}: CTI_FEISHU_APP_SECRET is required`;
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowed = this.options.profile.allowedUsers
      || (this.usesLegacyStoreSettings()
        ? (this.getStore().getSetting('bridge_feishu_allowed_users') || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined);
    if (!allowed || allowed.length === 0) return true;
    const allowSet = new Set(allowed.map((item) => item.trim()).filter(Boolean));
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
    if (!store.getChannelBinding(this.channelType, address.chatId, this.profileId)) {
      return null;
    }
    return {
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    };
  }

  async sendPreview(address: ChannelAddress, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    const processedText = preprocessFeishuMarkdown(text);
    if (!processedText.trim()) return 'skip';
    return this.previewService.sendPreview(this.withInstance(address), processedText, draftId);
  }

  async primePreview(address: ChannelAddress, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    return this.previewService.primePreview(this.withInstance(address), draftId);
  }

  endPreview(address: ChannelAddress, draftId: number): void {
    this.previewService.endPreview(this.withInstance(address), draftId);
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
        '当前问题包含敏感输入，飞书群聊不适合采集。请转到本地命令行继续。',
        replyToMessageId,
      );
      getBridgeContext().permissions.resolvePendingStructuredInput?.(request.requestId, { answers: {} });
      return { ok: true };
    }
    try {
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
    } catch (error) {
      console.warn('[feishu-adapter] Failed to send structured input card, falling back to post:', error);
      const fallback = await this.sendAsPost(
        address,
        buildStructuredInputFallbackText(request),
        replyToMessageId,
      );
      return {
        ok: fallback.ok,
        error: fallback.error,
        messageId: fallback.messageId,
        openMessageId: fallback.openMessageId,
      };
    }
  }

  async resolveStructuredInputRequest(requestId: string): Promise<void> {
    const request = this.getStore().getStructuredInputRequest(requestId);
    if (request?.channelInstanceId !== this.profileId) return;
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
          note: '该问答已完成，正在继续执行。',
          answers: request.draftAnswers,
        }),
      );
    } catch (error) {
      console.warn('[feishu-adapter] Failed to resolve structured input card:', error);
    }
  }

  shouldProjectActivityEvent(event: ActivityEvent): boolean {
    if (!isToolCallActivityEvent(event)) return true;
    return this.options.profile.showToolCallCards === true;
  }

  async upsertActivityEvent(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (!this.shouldProjectActivityEvent(event)) {
      return { ok: true };
    }
    return this.activityService.upsertActivityEvent(
      this.withInstance(address),
      event,
      replyToMessageId,
      true,
    );
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    const address = this.withInstance(message.address);

    if (message.rawCard) {
      const result = await this.sendInteractiveCard(address, message.rawCard, message.replyToMessageId);
      return {
        ok: true,
        messageId: result.messageId,
        openMessageId: result.openMessageId,
      };
    }

    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(
        address,
        normalizeMarkdown(message),
        message.inlineButtons,
        message.replyToMessageId,
        message.cardHeader,
      );
    }

    const finalPreview = await this.previewService.finalizePreview(address, normalizeMarkdown(message));
    if (finalPreview?.ok) {
      void this.maybeSyncSessionTitle(address.chatId);
      return finalPreview;
    }

    const text = normalizeMarkdown(message);
    const result = hasComplexMarkdown(text)
      ? await this.sendAsInteractiveCard(address, text, message.replyToMessageId)
      : await this.sendAsPost(address, text, message.replyToMessageId);
    if (result.ok) {
      void this.maybeSyncSessionTitle(address.chatId);
    }
    return result;
  }

  async sendImage(image: OutboundImage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    try {
      const address = this.withInstance(image.address);
      const imageKey = await this.uploadImageFile(image.filePath);
      const response = await this.sendLarkMessage(
        address,
        'image',
        JSON.stringify({ image_key: imageKey }),
        image.replyToMessageId,
      );
      assertLarkOk(response, 'im.message.sendImage');
      return {
        ok: true,
        messageId: response.data?.message_id,
        openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private appendBindingCommandExchange(binding: ChannelBinding | null, commandText: string, replyText: string): void {
    if (!binding?.codepilotSessionId) return;
    appendLocalCommandExchange(this.getStore(), binding.codepilotSessionId, commandText, replyText);
  }

  private prunePendingInboundImages(now = Date.now()): void {
    this.inboundImageService.prunePendingInboundImages(now);
  }

  private getPendingInboundImage(chatId: string, senderId: string, messageId: string, threadId?: string): PendingInboundImage | null {
    return this.inboundImageService.getPendingInboundImage(chatId, senderId, messageId, threadId);
  }

  private setPendingInboundImage(entry: PendingInboundImage): void {
    this.inboundImageService.setPendingInboundImage(entry);
  }

  private async downloadInboundImageAttachment(messageId: string, imageKey: string): Promise<FileAttachment> {
    return this.inboundImageService.downloadInboundImageAttachment(messageId, imageKey);
  }

  private resolveReferencedInboundImages(
    chatId: string,
    senderId: string,
    threadId: string | undefined,
    referenceIds: Array<string | undefined>,
  ): { attachments?: FileAttachment[]; errorMessage?: string } {
    return this.inboundImageService.resolveReferencedInboundImages(
      chatId,
      senderId,
      threadId,
      referenceIds,
    );
  }

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    return handleIncomingEventWithContext(this.getHandlerContext(), data);
  }

  private async handleCardAction(event: StructuredActionEvent): Promise<{ toast: { type: string; content: string } }> {
    return handleCardActionWithContext(this.getHandlerContext(), event);
  }

  private async patchActionCardSafely(
    messageId: string | undefined,
    card: Record<string, unknown>,
    kind: string,
    openMessageId?: string,
  ): Promise<void> {
    return patchActionCardSafelyWithContext(this.getHandlerContext(), messageId, card, kind, openMessageId);
  }

  private findBindingById(bindingId: string): ChannelBinding | null {
    return findBindingByIdWithContext(this.getHandlerContext(), bindingId);
  }

  private extractActionSenderIdentity(event: StructuredActionEvent): SenderIdentity | null {
    return extractActionSenderIdentityWithContext(this.getHandlerContext(), event);
  }

  private getRecentWorkspaceOptions(): RecentWorkspaceOption[] {
    const store = this.getStore();
    return listRecentWorkspaces(
      store.listChannelBindings(this.channelType),
      store.getSetting('bridge_default_work_dir') || process.cwd(),
    );
  }

  private resolveSelectedWorkdir(formValue?: Record<string, unknown>): string {
    const selected = collectTextFragments(formValue?.[NEW_SESSION_WORKDIR_FIELD]);
    if (selected[0]) {
      return normalizePath(selected[0]);
    }
    const fallback = this.getRecentWorkspaceOptions()[0]?.value
      || this.getStore().getSetting('bridge_default_work_dir')
      || process.cwd();
    return normalizePath(fallback);
  }

  private buildSessionReadyMessage(runtime: RuntimeName, binding: ChannelBinding): string {
    if (runtime === 'claude') {
      const modeTitle = getClaudeModeTitle(resolveClaudeBindingMode(binding));
      return [
        `已创建 Claude 会话，当前 mode：**${modeTitle}**。`,
        '后续直接在本群发送消息继续对话。',
        '可用命令：`/stop` 中断当前输出、`/mode` 切换 mode、`/reset` 重置会话。权限请求请直接使用卡片按钮处理。',
      ].join('\n');
    }
    return [
      `已创建 codex 会话，当前模式：**${binding.mode === 'plan' ? 'Plan' : '默认'}**。`,
      '后续请直接在本群继续对话。',
      '可用命令：`/stop` 中断当前输出、`/mode` 切换 mode、`/reset` 重置会话。',
    ].join('\n');
  }

  private async ensureRuntimeAvailable(runtime: RuntimeName): Promise<void> {
    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      ensureRuntimeAvailable?: (target: RuntimeName) => Promise<void>;
    };
    await llm.ensureRuntimeAvailable?.(runtime);
  }

  private async createBoundSession(
    runtime: RuntimeName,
    sender: SenderIdentity,
    options?: {
      claudePermissionMode?: ClaudePermissionMode;
      cwd?: string;
      bindingMode?: 'code' | 'plan' | 'ask';
      skipReadyMessage?: boolean;
    },
  ): Promise<{ chatId: string; binding: ChannelBinding }> {
    await this.ensureRuntimeAvailable(runtime);
    const store = this.getStore();
    const chatId = await this.createSessionGroup(runtime, sender, options?.claudePermissionMode);
    const session = store.createRuntimeSession({
      runtime,
      model: '',
      cwd: options?.cwd || store.getSetting('bridge_default_work_dir') || process.cwd(),
    });
    const initialBinding = store.upsertChannelBinding({
      channelType: this.channelType,
      channelInstanceId: this.profileId,
      chatId,
      codepilotSessionId: session.id,
      workingDirectory: session.working_directory,
      model: session.model,
      ...(runtime === 'claude'
        ? { claudePermissionMode: options?.claudePermissionMode || 'default' }
        : {}),
    });
    if (options?.bindingMode && initialBinding.mode !== options.bindingMode) {
      store.updateChannelBinding(initialBinding.id, { mode: options.bindingMode });
    }
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId) || initialBinding;
    await this.syncChatName(chatId);
    if (!options?.skipReadyMessage) {
      await this.sendAsPost(
        { channelType: this.channelType, channelInstanceId: this.profileId, chatId },
        this.buildSessionReadyMessage(runtime, binding),
      );
    }
    return { chatId, binding };
  }

  private async sendClaudeModeCard(
    address: ChannelAddress,
    scope: 'new' | 'switch',
    replyToMessageId?: string,
    options?: {
      selectedMode?: ClaudePermissionMode;
      bindingId?: string;
      note?: string;
    },
  ): Promise<SendResult> {
    const result = await this.sendInteractiveCard(
      address,
      buildClaudeModeCard(scope, options),
      replyToMessageId,
    );
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private async sendNewSessionCard(
    address: ChannelAddress,
    runtime: RuntimeName,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const workspaces = this.getRecentWorkspaceOptions();
    const card = runtime === 'codex'
      ? buildNewCodexSessionCard(workspaces)
      : buildNewClaudeSessionCard(workspaces);
    const result = await this.sendInteractiveCard(address, card, replyToMessageId);
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private async handleDirectMessage(sender: SenderIdentity, inbound: InboundMessage): Promise<void> {
    return handleDirectMessageWithContext(this.getHandlerContext(), sender, inbound);
  }

  private async handleGroupMessage(_sender: SenderIdentity, inbound: InboundMessage): Promise<void> {
    return handleGroupMessageWithContext(this.getHandlerContext(), _sender, inbound);
  }

  private async handleCreateSessionCommand(sender: SenderIdentity, inbound: InboundMessage, runtime: RuntimeName): Promise<void> {
    return handleCreateSessionCommandWithContext(this.getHandlerContext(), sender, inbound, runtime);
  }

  private async handleResumeSessionCommand(
    _sender: SenderIdentity,
    inbound: InboundMessage,
    runtime: RuntimeName,
  ): Promise<void> {
    return handleResumeSessionCommandWithContext(this.getHandlerContext(), _sender, inbound, runtime);
  }

  private async handleNewSessionCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleNewSessionCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async handleResumeCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleResumeCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async replayNativeSessionHistory(
    address: ChannelAddress,
    runtime: RuntimeName,
    items: NativeReplayItem[],
  ): Promise<void> {
    return replayNativeSessionHistoryWithContext(this.getHandlerContext(), address, runtime, items);
  }

  private async handleResetCommand(address: ChannelAddress, replyToMessageId?: string): Promise<void> {
    return handleResetCommandWithContext(this.getHandlerContext(), address, replyToMessageId);
  }

  private async handleModeCommand(bindingId: string, text: string, address: ChannelAddress, replyToMessageId?: string): Promise<void> {
    return handleModeCommandWithContext(this.getHandlerContext(), bindingId, text, address, replyToMessageId);
  }

  private async handlePlanCommand(bindingId: string, inbound: InboundMessage): Promise<void> {
    return handlePlanCommandWithContext(this.getHandlerContext(), bindingId, inbound);
  }

  private async handlePlanWorkflowMessage(bindingId: string, workflowId: string, inbound: InboundMessage): Promise<boolean> {
    return handlePlanWorkflowMessageWithContext(this.getHandlerContext(), bindingId, workflowId, inbound);
  }

  private buildPlanRequestInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      promptText?: string;
      attachments?: FileAttachment[];
    },
  ): InboundMessage {
    return {
      messageId,
      address,
      text: requestText,
      timestamp: Date.now(),
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId,
          ...(options?.attemptId ? { attemptId: options.attemptId } : {}),
          promptText: options?.promptText || buildPlanningPrompt(requestText),
          storedUserText: requestText,
          permissionMode: 'plan',
        },
      },
    };
  }

  private buildNativePlanRequestInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      attachments?: FileAttachment[];
    },
  ): InboundMessage {
    return {
      messageId,
      address,
      text: requestText,
      timestamp: Date.now(),
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      bridgeMeta: {
        planWorkflow: {
          kind: 'native_plan_request',
          workflowId,
          ...(options?.attemptId ? { attemptId: options.attemptId } : {}),
          promptText: requestText,
          storedUserText: requestText,
          permissionMode: 'plan',
          collaborationMode: 'plan',
        },
      },
    };
  }

  private buildPlanExecutionInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
      planText?: string;
    },
  ): InboundMessage {
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
          ...(options?.attemptId ? { attemptId: options.attemptId } : {}),
          promptText: buildClaudePlanExecutionPrompt(requestText, options?.planText),
          storedUserText,
          permissionMode: options?.permissionMode || 'acceptEdits',
          collaborationMode: 'default',
        },
      },
    };
  }

  private async handleClaudeModeCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const parts = callbackData.split(':');
    const scope = parts[1];
    const bindingId = scope === 'switch' ? parts[2] : '';
    const rawMode = scope === 'switch' ? parts[3] : parts[2];
    const mode = normalizeClaudePermissionMode(rawMode);
    if (!mode || (scope !== 'new' && scope !== 'switch')) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }

    const actionMessageId = resolveActionOpenMessageId(event);

    if (scope === 'new') {
      const sender = this.extractActionSenderIdentity(event);
      if (!sender) {
        return { toast: { type: 'warning', content: '无法识别当前操作人' } };
      }
      const cwd = this.resolveSelectedWorkdir(event.action?.form_value as Record<string, unknown> | undefined);
      try {
        await this.createBoundSession('claude', sender, {
          claudePermissionMode: mode,
          cwd,
        });
        await this.patchActionCardSafely(
          undefined,
          buildStatusCard(
            'Claude 会话已创建',
            `工作区：\`${cwd}\`\n\n当前 mode：**${getClaudeModeTitle(mode)}**。\n\n请直接进入新群继续对话。`,
            'green',
          ),
          'claude-mode',
          actionMessageId,
        );
        return { toast: { type: 'success', content: `已创建 ${getClaudeModeTitle(mode)} 会话` } };
      } catch (error) {
        console.error('[feishu-adapter] Failed to create Claude session from mode card:', error);
        return {
          toast: {
            type: 'warning',
            content: `创建会话失败：${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    }

    const binding = bindingId ? this.findBindingById(bindingId) : null;
    if (!binding) {
      return { toast: { type: 'warning', content: '当前群尚未绑定会话' } };
    }
    const runtime = this.getStore().getSessionExt(binding.codepilotSessionId)?.runtime || 'claude';
    if (runtime !== 'claude') {
      return { toast: { type: 'warning', content: '当前群不是 Claude 会话' } };
    }

    const currentMode = resolveClaudeBindingMode(binding);
    if (currentMode !== mode) {
      this.getStore().updateChannelBinding(binding.id, {
        claudePermissionMode: mode,
        mode: 'code',
      });
      await this.syncChatName(binding.chatId);
    }
    await this.patchActionCardSafely(
      undefined,
      buildClaudeModeCard('switch', {
        selectedMode: mode,
        bindingId: binding.id,
        note: `已切换到 **${getClaudeModeTitle(mode)}**。`,
      }),
      'claude-mode',
      actionMessageId,
    );
    return {
      toast: {
        type: 'success',
        content: currentMode === mode
          ? `当前已是 ${getClaudeModeTitle(mode)}`
          : `已切换到 ${getClaudeModeTitle(mode)}`,
      },
    };
  }

  private async handleStructuredInputCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleStructuredInputCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async handlePlanCardAction(
    event: lark.InteractiveCardActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handlePlanCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async handleClaudePlanExitCardAction(
    event: lark.InteractiveCardActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleClaudePlanExitCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async createSessionGroup(
    runtime: RuntimeName,
    sender: SenderIdentity,
    claudePermissionMode?: ClaudePermissionMode,
  ): Promise<string> {
    if (!this.restClient) throw new Error('Feishu client not initialized');
    const initialName = defaultChatName(runtime, claudePermissionMode);
    const response = await this.restClient.im.chat.create({
      params: {
        user_id_type: sender.type,
        set_bot_manager: true,
      },
      data: {
        name: initialName,
        chat_mode: 'group',
        chat_type: 'private',
        group_message_type: 'chat',
        user_id_list: [sender.id],
      },
    });
    assertLarkOk(response, 'im.chat.create');
    const chatId = response.data?.chat_id;
    if (!chatId) throw new Error('Create group succeeded without chat_id');
    this.knownChatNames.set(chatId, initialName);
    return chatId;
  }

  private chatNameKey(chatId: string, name: string): string {
    return `${chatId}\u0000${name}`;
  }

  private pruneSelfRenameEchoes(now = Date.now()): void {
    for (const [key, expiresAt] of this.selfRenameEchoes) {
      if (expiresAt <= now) this.selfRenameEchoes.delete(key);
    }
  }

  private rememberObservedChatName(chatId: string, name: string): void {
    this.knownChatNames.set(chatId, name);
  }

  private rememberSelfRename(chatId: string, name: string): void {
    this.pruneSelfRenameEchoes();
    this.selfRenameEchoes.set(
      this.chatNameKey(chatId, name),
      Date.now() + FeishuAdapter.SELF_RENAME_ECHO_TTL_MS,
    );
  }

  private consumeSelfRenameEcho(chatId: string, name: string): boolean {
    this.pruneSelfRenameEchoes();
    const key = this.chatNameKey(chatId, name);
    const expiresAt = this.selfRenameEchoes.get(key);
    if (!expiresAt || expiresAt <= Date.now()) {
      this.selfRenameEchoes.delete(key);
      return false;
    }
    this.selfRenameEchoes.delete(key);
    return true;
  }

  private async handleChatUpdatedEvent(data: FeishuChatUpdatedEventData): Promise<void> {
    const chatId = data.chat_id?.trim();
    const beforeName = data.before_change?.name?.trim() || '';
    const afterName = data.after_change?.name?.trim() || '';
    if (!chatId || !afterName) return;

    this.rememberObservedChatName(chatId, afterName);
    if (beforeName === afterName || this.consumeSelfRenameEcho(chatId, afterName)) return;

    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId);
    if (!binding) return;

    store.updateSessionExt(binding.codepilotSessionId, {
      title: afterName,
      titleStatus: 'done',
      displayNameMode: 'manual_locked',
    });

    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      writeSessionTitle?: (sessionId: string, title: string) => Promise<void>;
    };
    try {
      await llm.writeSessionTitle?.(binding.codepilotSessionId, afterName);
    } catch (error) {
      console.warn('[feishu-adapter] Failed to push manual title to runtime:', error);
    }
  }

  private async maybeSyncSessionTitle(chatId: string): Promise<void> {
    if (this.pendingTitleSyncs.has(chatId)) return;
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId);
    if (!binding) return;

    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      readSessionTitle?: (sessionId: string) => Promise<string | null>;
      writeSessionTitle?: (sessionId: string, title: string) => Promise<void>;
    };

    this.pendingTitleSyncs.add(chatId);
    try {
      const ext = store.getSessionExt(binding.codepilotSessionId);
      if (!ext || ext.displayNameMode === 'native_locked') return;

      if (ext.displayNameMode === 'manual_locked') {
        const manualTitle = ext.title?.trim();
        if (!manualTitle) return;
        const runtimeTitle = (await llm.readSessionTitle?.(binding.codepilotSessionId))?.trim() || '';
        if (runtimeTitle === manualTitle) return;
        await llm.writeSessionTitle?.(binding.codepilotSessionId, manualTitle);
        return;
      }

      const runtimeTitle = (await llm.readSessionTitle?.(binding.codepilotSessionId))?.trim();
      if (!runtimeTitle) return;
      if (runtimeTitle === (ext.title || '').trim() && ext.titleStatus === 'done') return;

      store.updateSessionExt(binding.codepilotSessionId, {
        title: runtimeTitle,
        titleStatus: 'done',
        displayNameMode: 'default',
      });
      await this.syncChatName(chatId);
    } catch (error) {
      console.warn('[feishu-adapter] Failed to sync session title:', error);
    } finally {
      this.pendingTitleSyncs.delete(chatId);
    }
  }

  private shouldDecoratePlan(bindingId: string, mode: 'code' | 'plan' | 'ask'): boolean {
    if (mode === 'plan') return true;
    return !!this.getStore().getActivePlanWorkflowByBinding(bindingId);
  }

  private computeChatDisplayName(chatId: string): string | null {
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId);
    if (!binding) return null;
    const ext = store.getSessionExt(binding.codepilotSessionId);
    if ((ext?.displayNameMode === 'native_locked' || ext?.displayNameMode === 'manual_locked') && ext.title) {
      return ext.title;
    }
    const runtime = ext?.runtime || 'claude';
    const baseName = stripClaudeModeSuffix(ext?.title || defaultChatName(runtime));
    if (runtime === 'claude') {
      return `${baseName}${getClaudeModeSuffix(resolveClaudeBindingMode(binding))}`;
    }
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
    if (this.knownChatNames.get(chatId) === name) return;
    try {
      const response = await chatApi.update({
        path: { chat_id: chatId },
        data: { name },
      });
      assertLarkOk(response, 'im.chat.update');
      this.rememberObservedChatName(chatId, name);
      this.rememberSelfRename(chatId, name);
    } catch (error) {
      console.warn('[feishu-adapter] Failed to sync chat name:', error);
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
    const store = this.tryGetStore();
    const appId = this.options.profile.appId || store?.getSetting('bridge_feishu_app_id') || '';
    const appSecret = this.options.profile.appSecret || store?.getSetting('bridge_feishu_app_secret') || '';
    const domain = (this.options.profile.domain || store?.getSetting('bridge_feishu_domain') || '') === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;
    return { appId, appSecret, domain };
  }

  private tryGetStore(): JsonFileStore | null {
    try {
      return getBridgeContext().store as JsonFileStore;
    } catch {
      return null;
    }
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
    const response = await this.sendLarkMessage(this.withInstance(address), 'interactive', content, replyToMessageId);
    assertLarkOk(response, 'im.message.sendInteractive');
    return {
      ok: true,
      messageId: response.data?.message_id,
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private async sendAsPost(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult> {
    const content = buildPostContent(text);
    const response = await this.sendLarkMessage(this.withInstance(address), 'post', content, replyToMessageId);
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
    requestUuid?: string,
  ): Promise<{ messageId: string; openMessageId?: string }> {
    return this.larkClient.sendCard(
      this.withInstance(address),
      card,
      replyToMessageId,
      requestUuid,
    );
  }

  private async uploadImageFile(filePath: string): Promise<string> {
    return this.larkClient.uploadImage(filePath);
  }

  private async sendLarkMessage(
    address: ChannelAddress,
    msgType: 'interactive' | 'post' | 'image',
    content: string,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<{ code?: number; msg?: string; data?: { message_id?: string; open_message_id?: string; chat_id?: string } }> {
    return this.larkClient.sendMessage(address, msgType, content, replyToMessageId, requestUuid);
  }

  private async patchInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
    options?: { messageIdType?: 'message_id' | 'open_message_id' },
  ): Promise<void> {
    return this.larkClient.patchCard(messageId, card, options);
  }

  private async deleteMessageQuietly(messageId: string): Promise<void> {
    return this.larkClient.deleteMessageQuietly(messageId);
  }
}
