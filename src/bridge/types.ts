import type { ClaudePermissionMode } from '../runtime/claude-mode.js';

/**
 * Bridge system types — shared across all bridge modules.
 *
 * The bridge connects Feishu/Lark chats to local Claude/Codex sessions.
 */

// Re-export bridge-local types from host.ts so consumers can import from one place
export type { ActivityEvent, FileAttachment } from './host.js';

// ── Channel Types ──────────────────────────────────────────────

/**
 * Channel type identifier.
 * Extensible — any string is valid so new adapters can register without
 * modifying this definition. The built-in adapter uses `feishu`.
 */
export type ChannelType = string;
export const DEFAULT_CHANNEL_INSTANCE_ID = 'default';

export function resolveChannelInstanceId(
  addressLike: { channelInstanceId?: string } | null | undefined,
): string {
  return addressLike?.channelInstanceId || DEFAULT_CHANNEL_INSTANCE_ID;
}

/** Unique address of a user within a channel */
export interface ChannelAddress {
  channelType: ChannelType;
  channelInstanceId?: string;
  chatId: string;        // Platform-specific chat/channel identifier
  userId?: string;       // Platform-specific user identifier (optional for group chats)
  displayName?: string;  // Human-readable name for audit logs
  threadId?: string;     // Optional thread/reply-chain identifier within the chat
}

/** Composite key for routing: channelType + chatId */
export interface SessionKey {
  channelType: ChannelType;
  channelInstanceId?: string;
  chatId: string;
}

// ── Messages ───────────────────────────────────────────────────

/** Inbound message from an IM channel */
export interface InboundMessage {
  /** Platform-specific message ID (for dedup and reference) */
  messageId: string;
  /** Address of the sender */
  address: ChannelAddress;
  /** Plain text content of the message */
  text: string;
  /** Timestamp of the message (ISO string or unix epoch ms) */
  timestamp: number;
  /** If this is a callback query (inline button press), the callback data */
  callbackData?: string;
  /** For callback queries: the message ID of the original message that triggered the callback */
  callbackMessageId?: string;
  /** Platform-specific raw update object (for adapter-specific handling) */
  raw?: unknown;
  /** Adapter-specific update ID for deferred offset acknowledgement */
  updateId?: number;
  /** File attachments (images, documents) from the IM channel */
  attachments?: import('./host.js').FileAttachment[];
  /** Bridge-internal routing metadata */
  bridgeMeta?: BridgeMessageMeta;
}

/** Outbound message to send to an IM channel */
export interface OutboundMessage {
  /** Target address */
  address: ChannelAddress;
  /** Message text for the target adapter */
  text: string;
  /** Parse mode for the text */
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  /** Inline keyboard buttons */
  inlineButtons?: InlineButton[][];
  /** If replying to a specific message */
  replyToMessageId?: string;
  /** Optional card header metadata for adapters that support interactive cards */
  cardHeader?: CardHeader;
  /** Optional adapter-specific raw card payload */
  rawCard?: Record<string, unknown>;
}

/** Outbound image to send to an IM channel */
export interface OutboundImage {
  /** Target address */
  address: ChannelAddress;
  /** Absolute path to a local image file */
  filePath: string;
  /** If replying to a specific message */
  replyToMessageId?: string;
}

/** Inline keyboard button for permission prompts */
export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface CardHeader {
  title: string;
  template?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey';
}

export interface BridgeMessageMeta {
  planWorkflow?: {
    kind: 'plan_request' | 'plan_execute' | 'native_plan_request';
    workflowId: string;
    attemptId?: string;
    promptText: string;
    storedUserText?: string;
    permissionMode?: ClaudePermissionMode;
    collaborationMode?: 'plan' | 'default';
  };
}

/** Result of sending a message via an adapter */
export interface SendResult {
  ok: boolean;
  /** Platform-specific message ID of the sent message */
  messageId?: string;
  openMessageId?: string;
  error?: string;
}

// ── Bindings ───────────────────────────────────────────────────

/** Links an IM chat to a CodePilot session */
export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  channelInstanceId: string;
  chatId: string;
  /** CodePilot session ID this chat is bound to */
  codepilotSessionId: string;
  /** SDK session ID for resume (cached from last conversation) */
  sdkSessionId: string;
  /** Working directory for this binding */
  workingDirectory: string;
  /** Model override for this binding */
  model: string;
  /** Chat mode */
  mode: 'code' | 'plan' | 'ask';
  /** Persistent Claude SDK permission mode for Claude runtime chats */
  claudePermissionMode?: ClaudePermissionMode;
  /** Whether this binding is currently active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Bridge Status ──────────────────────────────────────────────

/** Overall bridge system status */
export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

/** Status of a single channel adapter */
export interface AdapterStatus {
  adapterId: string;
  channelType: ChannelType;
  profileId?: string;
  label?: string;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

// ── Audit & Dedup ──────────────────────────────────────────────

/** Audit log entry */
export interface AuditLogEntry {
  id: string;
  channelType: ChannelType;
  channelInstanceId?: string;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}

/** Permission link: maps permissionRequestId to an IM message for callback handling */
export interface PermissionLink {
  id: string;
  permissionRequestId: string;
  channelType: ChannelType;
  channelInstanceId?: string;
  chatId: string;
  messageId: string;
  createdAt: string;
}

// ── Streaming Preview ─────────────────────────────────────────

/** Capabilities of a channel adapter's streaming preview support */
export interface PreviewCapabilities {
  supported: boolean;
  privateOnly: boolean;
  /** How the preview should turn into the final visible reply. */
  finalDelivery?: 'separate_message' | 'replace_preview' | 'segment_replace_preview';
}

/** Mutable state for an in-flight streaming preview */
export interface StreamingPreviewState {
  draftId: number;           // non-zero 31-bit random integer, reused within one answer cycle
  address: ChannelAddress;
  placeholderPrimed: boolean;// preview artifact exists, but no real text has been streamed into it yet
  primeTimer: ReturnType<typeof setTimeout> | null;
  lastSentText: string;      // last text actually sent as draft
  lastSentAt: number;        // timestamp (ms) of last sent draft
  degraded: boolean;         // set true after API failure → skip further previews
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;       // latest accumulated text (may not yet be sent due to throttle)
  inFlightSend: Promise<void> | null;
}

// ── Config ─────────────────────────────────────────────────────

/** Platform-specific message length limits */
export const PLATFORM_LIMITS: Record<string, number> = {
  feishu: 30000,
};
