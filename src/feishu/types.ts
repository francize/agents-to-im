import type * as lark from '@larksuiteoapi/node-sdk';

import type {
  ActivityEvent,
  ChannelAddress,
  ChannelBinding,
  ChannelType,
  FileAttachment,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../bridge/types.js';
import type { StructuredInputRequestInfo, StructuredInputResponse } from '../bridge/host.js';
import type { FeishuProfileConfig } from '../config/config.js';
import type { NativeReplayItem } from '../infra/native-session-history.js';
import type { RecentWorkspaceOption } from '../infra/recent-workspaces.js';
import type { RuntimeName } from '../runtime/types.js';
import type { JsonFileStore } from '../infra/store.js';
import type { LarkClient } from './lark-client.js';
import type { ActivityService } from './services/activity-service.js';
import type { InboundImageService } from './services/inbound-image-service.js';
import type { PreviewService } from './services/preview-service.js';

export type MemberIdType = 'open_id' | 'user_id' | 'union_id';

export interface SenderIdentity {
  id: string;
  type: MemberIdType;
}

export interface FeishuMessageEventData {
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

export interface FeishuChatUpdatedEventData {
  chat_id: string;
  before_change?: {
    name?: string;
  };
  after_change?: {
    name?: string;
  };
}

export interface PreviewArtifact {
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

export interface ActivityArtifact {
  key: string;
  routeKey: string;
  activityId: string;
  messageId: string;
  openMessageId?: string;
  kind: ActivityEvent['kind'];
}

export interface PendingActivitySend {
  requestUuid: string;
  needsRecoveryPatch: boolean;
}

export interface PendingInboundImage {
  key: string;
  chatId: string;
  threadId?: string;
  senderId: string;
  messageId: string;
  createdAt: number;
  attachments?: FileAttachment[];
  errorMessage?: string;
}

export interface FeishuAdapterOptions {
  profile: FeishuProfileConfig;
}

export type StructuredActionEvent = lark.InteractiveCardActionEvent & {
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

export interface LarkMessageResponse {
  code?: number;
  msg?: string;
  data?: {
    message_id?: string;
    open_message_id?: string;
    chat_id?: string;
  };
}

export interface PatchCardOptions {
  messageIdType?: 'message_id' | 'open_message_id';
}

export interface CardActionResult {
  toast: {
    type: string;
    content: string;
  };
}

export interface StructuredInputCardOptions {
  resolved?: boolean;
  note?: string;
  answers?: StructuredInputResponse['answers'];
}

export interface StructuredInputCardRequest extends StructuredInputRequestInfo {}

export interface RouteAddress extends Pick<ChannelAddress, 'chatId' | 'threadId'> {}

export interface AdapterContext {
  readonly channelType: ChannelType;
  readonly profileId: string;
  readonly label: string;
  getStore(): JsonFileStore;
  getLarkClient(): LarkClient;
  getPreviewService(): PreviewService;
  getActivityService(): ActivityService;
  getInboundImageService(): InboundImageService;
  withInstance(address: ChannelAddress): ChannelAddress;
  isAuthorized(userId: string, chatId: string): boolean;
  setLastIncomingMessageId(routeKey: string, messageId: string): void;
  markSeenMessage(messageId: string): boolean;
  enqueue(msg: InboundMessage): void;
  enqueueChatTask(chatId: string, task: () => Promise<void>): Promise<void>;
  sendAsPost(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult>;
  sendAsInteractiveCard(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult>;
  sendInteractiveCard(
    address: ChannelAddress,
    card: Record<string, unknown> | lark.InteractiveCard,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<{ messageId: string; openMessageId?: string }>;
  patchInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
    options?: PatchCardOptions,
  ): Promise<void>;
  patchActionCardSafely(
    messageId: string | undefined,
    card: Record<string, unknown>,
    kind: string,
    openMessageId?: string,
  ): Promise<void>;
  handleCreateSessionCommand(
    sender: SenderIdentity,
    inbound: InboundMessage,
    runtime: RuntimeName,
  ): Promise<void>;
  handleNewSessionCardAction(event: StructuredActionEvent, callbackData: string): Promise<CardActionResult>;
  handleClaudeModeCardAction(event: StructuredActionEvent, callbackData: string): Promise<CardActionResult>;
  handleResumeSessionCommand(
    sender: SenderIdentity,
    inbound: InboundMessage,
    runtime: RuntimeName,
  ): Promise<void>;
  handleResumeCardAction(event: StructuredActionEvent, callbackData: string): Promise<CardActionResult>;
  handleResetCommand(address: ChannelAddress, replyToMessageId?: string): Promise<void>;
  handleModeCommand(bindingId: string, text: string, address: ChannelAddress, replyToMessageId?: string): Promise<void>;
  handlePlanCommand(bindingId: string, inbound: InboundMessage): Promise<void>;
  handlePlanWorkflowMessage(bindingId: string, workflowId: string, inbound: InboundMessage): Promise<boolean>;
  handlePlanCardAction(event: lark.InteractiveCardActionEvent, callbackData: string): Promise<CardActionResult>;
  handleClaudePlanExitCardAction(event: lark.InteractiveCardActionEvent, callbackData: string): Promise<CardActionResult>;
  handleStructuredInputCardAction(event: StructuredActionEvent, callbackData: string): Promise<CardActionResult>;
  resolveStructuredInputRequest(requestId: string): Promise<void>;
  getRecentWorkspaceOptions(): RecentWorkspaceOption[];
  resolveSelectedWorkdir(formValue?: Record<string, unknown>): string;
  createBoundSession(
    runtime: RuntimeName,
    sender: SenderIdentity,
    options?: {
      claudePermissionMode?: import('../runtime/claude-mode.js').ClaudePermissionMode;
      cwd?: string;
      bindingMode?: 'code' | 'plan' | 'ask';
      skipReadyMessage?: boolean;
    },
  ): Promise<{ chatId: string; binding: ChannelBinding }>;
  ensureRuntimeAvailable(runtime: RuntimeName): Promise<void>;
  sendNewSessionCard(address: ChannelAddress, runtime: RuntimeName, replyToMessageId?: string): Promise<SendResult>;
  sendClaudeModeCard(
    address: ChannelAddress,
    scope: 'new' | 'switch',
    replyToMessageId?: string,
    options?: {
      selectedMode?: import('../runtime/claude-mode.js').ClaudePermissionMode;
      bindingId?: string;
      note?: string;
    },
  ): Promise<SendResult>;
  appendBindingCommandExchange(binding: ChannelBinding | null, commandText: string, replyText: string): void;
  syncChatName(chatId: string): Promise<void>;
  findBindingById(bindingId: string): ChannelBinding | null;
  extractActionSenderIdentity(event: StructuredActionEvent): SenderIdentity | null;
  replayNativeSessionHistory(address: ChannelAddress, runtime: RuntimeName, items: NativeReplayItem[]): Promise<void>;
  buildPlanRequestInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      promptText?: string;
      attachments?: FileAttachment[];
    },
  ): InboundMessage;
  buildNativePlanRequestInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      attachments?: FileAttachment[];
    },
  ): InboundMessage;
  buildPlanExecutionInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
      planText?: string;
    },
  ): InboundMessage;
  prunePendingInboundImages(now?: number): void;
  setPendingInboundImage(entry: PendingInboundImage): void;
  downloadInboundImageAttachment(messageId: string, imageKey: string): Promise<FileAttachment>;
  resolveReferencedInboundImages(
    chatId: string,
    senderId: string,
    threadId: string | undefined,
    referenceIds: Array<string | undefined>,
  ): { attachments?: FileAttachment[]; errorMessage?: string };
}
