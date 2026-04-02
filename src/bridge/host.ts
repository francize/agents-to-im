/**
 * Host Interfaces — abstractions for host-application dependencies.
 *
 * These interfaces decouple the bridge system from any specific host
 * (e.g., CodePilot). A host must provide implementations of these
 * interfaces to use the bridge.
 */

import type { SessionExt } from '../runtime/types.js';
import type { ClaudePlanAllowedPrompt } from '../runtime/claude-plan-exit.js';
import type { ClaudePermissionMode } from '../runtime/claude-mode.js';
import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';

// ── Bridge-local types (replacing @/types imports) ────────────

/** File attachment from an IM channel (images, documents). */
export interface FileAttachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  data: string; // base64 encoded content
  filePath?: string;
}

/** Server-Sent Event from the LLM stream. */
export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

export type SSEEventType =
  | 'text'
  | 'text_segment'
  | 'activity_event'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_timeout'
  | 'status'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'approval_request'
  | 'structured_input_request'
  | 'server_request_resolved'
  | 'plan_state'
  | 'plan_delta'
  | 'plan_result'
  | 'mode_changed'
  | 'task_update'
  | 'keep_alive'
  | 'done';

/** Content block in an LLM response message. */
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'code'; language: string; code: string };

export interface ActivityFileChangeEntry {
  kind: string;
  path: string;
}

export type ActivityRunStatus = 'running' | 'completed' | 'failed';
export type ToolActivityStatus = 'pending' | ActivityRunStatus;

export type ActivityEvent =
  | {
      kind: 'lightweight_activity';
      id: string;
      turnId?: string;
      status: ActivityRunStatus;
      text: string;
      source?: string;
    }
  | {
      kind: 'reasoning_activity';
      turnId?: string;
      taskId?: string;
      status: ActivityRunStatus;
      text: string;
      source?: string;
    }
  | {
      kind: 'tool_activity';
      turnId?: string;
      toolUseId: string;
      parentToolUseId?: string | null;
      toolName: string;
      status: ToolActivityStatus;
      inputPreview?: string;
      resultPreview?: string;
      taskId?: string;
      elapsedSeconds?: number;
      source?: string;
    }
  | {
      kind: 'command_execution';
      id: string;
      turnId?: string;
      status: ActivityRunStatus;
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | {
      kind: 'file_change';
      id: string;
      turnId?: string;
      status: ActivityRunStatus;
      summary?: string;
      changes: ActivityFileChangeEntry[];
    }
  | {
      kind: 'context_usage';
      id: string;
      turnId?: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
    };

/** Token usage statistics from an LLM response. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

/** API provider configuration (opaque to the bridge). */
export interface BridgeApiProvider {
  id: string;
  [key: string]: unknown;
}

// ── Session & Message types ──────────────────────────────────

/** Minimal session object returned by the store. */
export interface BridgeSession {
  id: string;
  working_directory: string;
  model: string;
  system_prompt?: string;
  provider_id?: string;
}

/** Minimal message object returned by the store. */
export interface BridgeMessage {
  role: string;
  content: string;
}

// ── Host Interface: Settings ─────────────────────────────────

export interface SettingsProvider {
  getSetting(key: string): string | null;
}

// ── Host Interface: Store ────────────────────────────────────

/** Input for creating an audit log entry. */
export interface AuditLogInput {
  channelType: string;
  channelInstanceId?: string;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
}

/** Input for inserting a permission link. */
export interface PermissionLinkInput {
  permissionRequestId: string;
  channelType: string;
  channelInstanceId?: string;
  chatId: string;
  messageId: string;
  openMessageId?: string;
  toolName: string;
  suggestions: string;
}

/** Stored permission link record. */
export interface PermissionLinkRecord {
  channelType: string;
  channelInstanceId: string;
  permissionRequestId: string;
  chatId: string;
  messageId: string;
  openMessageId?: string;
  resolved: boolean;
  suggestions: string;
}

export type PlanWorkflowStatus = 'awaiting_input' | 'planning' | 'interrupting' | 'awaiting_confirmation';

export interface PlanWorkflowInput {
  workflowId?: string;
  bindingId: string;
  channelType: string;
  channelInstanceId?: string;
  chatId: string;
  codepilotSessionId: string;
  status: PlanWorkflowStatus;
  previousMode: 'code' | 'plan' | 'ask';
  requestText: string;
  address: ChannelAddress;
  routeKey: string;
  requestMessageId?: string;
  planMessageId?: string;
  actionCardMessageId?: string;
  actionCardOpenMessageId?: string;
  approvalRequestId?: string;
  planText?: string;
  planFilePath?: string;
  allowedPrompts?: ClaudePlanAllowedPrompt[] | null;
  activeAttemptId?: string;
  pendingFollowUpText?: string;
  pendingFollowUpAttachments?: FileAttachment[];
  pendingRequestMessageId?: string;
  pendingAddress?: ChannelAddress;
  pendingRouteKey?: string;
  resolved?: boolean;
}

export interface PlanWorkflowRecord extends Omit<PlanWorkflowInput, 'workflowId'> {
  workflowId: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StructuredInputOption {
  label: string;
  description: string;
  preview?: string;
}

export interface StructuredInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  multiSelect?: boolean;
  responseKey?: string;
  options: StructuredInputOption[] | null;
}

export interface StructuredInputAnswer {
  answers: string[];
}

export interface StructuredInputResponse {
  answers: Record<string, StructuredInputAnswer>;
}

export interface StructuredInputRequestInfo {
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: StructuredInputQuestion[];
}

export interface StructuredInputRequestInput {
  requestId: string;
  channelType: string;
  channelInstanceId?: string;
  chatId: string;
  codepilotSessionId: string;
  address: ChannelAddress;
  routeKey: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: StructuredInputQuestion[];
  draftAnswers?: StructuredInputResponse['answers'];
  messageId?: string;
  openMessageId?: string;
  resolved?: boolean;
}

export interface StructuredInputRequestRecord extends Omit<StructuredInputRequestInput, 'resolved'> {
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Input for inserting an outbound reference. */
export interface OutboundRefInput {
  channelType: string;
  channelInstanceId?: string;
  chatId: string;
  codepilotSessionId: string;
  platformMessageId: string;
  purpose: string;
}

/** Input for upserting a channel binding. */
export interface UpsertChannelBindingInput {
  channelType: string;
  channelInstanceId?: string;
  chatId: string;
  codepilotSessionId: string;
  workingDirectory: string;
  model: string;
  claudePermissionMode?: ClaudePermissionMode;
}

/**
 * Persistence layer for the bridge system.
 * All database operations are abstracted through this interface.
 */
export interface BridgeStore {
  // ── Settings ──
  getSetting(key: string): string | null;

  // ── Channel bindings ──
  getChannelBinding(channelType: string, chatId: string, channelInstanceId?: string): ChannelBinding | null;
  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding;
  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void;
  listChannelBindings(channelType?: ChannelType): ChannelBinding[];

  // ── Sessions ──
  getSession(id: string): BridgeSession | null;
  createSession(
    name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    mode?: string,
  ): BridgeSession;
  updateSessionProviderId(sessionId: string, providerId: string): void;

  // ── Messages ──
  addMessage(sessionId: string, role: string, content: string, usage?: string | null): void;
  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] };

  // ── Session locking ──
  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean;
  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void;
  releaseSessionLock(sessionId: string, lockId: string): void;
  setSessionRuntimeStatus(sessionId: string, status: string): void;

  // ── SDK session ──
  updateSdkSessionId(sessionId: string, sdkSessionId: string): void;
  getSessionSdkSessionId(sessionId: string): string;
  getCodexThreadId(sessionId: string): string;
  updateCodexThreadId(sessionId: string, threadId: string): void;
  getSessionExt(sessionId: string): SessionExt | null;
  updateSessionExt(sessionId: string, updates: Partial<SessionExt>): SessionExt | null;
  updateSessionModel(sessionId: string, model: string): void;
  syncSdkTasks(sessionId: string, todos: unknown): void;

  // ── Provider ──
  getProvider(id: string): BridgeApiProvider | undefined;
  getDefaultProviderId(): string | null;

  // ── Audit & dedup ──
  insertAuditLog(entry: AuditLogInput): void;
  checkDedup(key: string): boolean;
  insertDedup(key: string): void;
  cleanupExpiredDedup(): void;
  insertOutboundRef(ref: OutboundRefInput): void;

  // ── Permission links ──
  insertPermissionLink(link: PermissionLinkInput): void;
  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null;
  markPermissionLinkResolved(permissionRequestId: string): boolean;
  /** List unresolved permission links for a given chat. */
  listPendingPermissionLinksByChat(
    chatId: string,
    channelType?: string,
    channelInstanceId?: string,
  ): PermissionLinkRecord[];

  // ── Plan workflows ──
  upsertPlanWorkflow(workflow: PlanWorkflowInput): PlanWorkflowRecord;
  getPlanWorkflow(workflowId: string): PlanWorkflowRecord | null;
  getActivePlanWorkflowByBinding(bindingId: string): PlanWorkflowRecord | null;
  getActivePlanWorkflowByChat(
    channelType: string,
    chatId: string,
    channelInstanceId?: string,
  ): PlanWorkflowRecord | null;
  updatePlanWorkflow(workflowId: string, updates: Partial<Omit<PlanWorkflowRecord, 'workflowId' | 'bindingId' | 'channelType' | 'chatId' | 'codepilotSessionId' | 'createdAt'>>): PlanWorkflowRecord | null;
  markPlanWorkflowResolved(workflowId: string): boolean;
  deletePlanWorkflow(workflowId: string): boolean;

  // ── Structured input requests ──
  upsertStructuredInputRequest(request: StructuredInputRequestInput): StructuredInputRequestRecord;
  getStructuredInputRequest(requestId: string): StructuredInputRequestRecord | null;
  updateStructuredInputRequest(
    requestId: string,
    updates: Partial<Omit<StructuredInputRequestRecord, 'requestId' | 'channelType' | 'chatId' | 'codepilotSessionId' | 'createdAt'>>,
  ): StructuredInputRequestRecord | null;
  markStructuredInputRequestResolved(requestId: string): boolean;
  deleteStructuredInputRequest(requestId: string): boolean;

  // ── Channel offsets (adapter watermarks) ──
  getChannelOffset(key: string): string;
  setChannelOffset(key: string, offset: string): void;
}

// ── Host Interface: LLM Provider ─────────────────────────────

/** Parameters for starting an LLM stream. */
export interface StreamChatParams {
  prompt: string;
  sessionId: string;
  sdkSessionId?: string;
  model?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  permissionMode?: string;
  provider?: BridgeApiProvider;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  files?: FileAttachment[];
  onRuntimeStatusChange?: (status: string) => void;
  onModeChanged?: (mode: ClaudePermissionMode) => void;
  collaborationMode?: 'plan' | 'default';
}

export interface LLMProvider {
  /**
   * Start a streaming chat with the LLM.
   * Returns a ReadableStream of SSE-formatted strings.
   */
  streamChat(params: StreamChatParams): ReadableStream<string>;
}

// ── Host Interface: Permission Gateway ───────────────────────

/** Resolution result for a pending permission. */
export interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;
  updatedPermissions?: unknown[];
  scope?: 'turn' | 'session';
  interrupt?: boolean;
}

export interface PermissionGateway {
  /**
   * Resolve a pending permission request.
   * Returns true if the permission was found and resolved.
   */
  resolvePendingPermission(permissionRequestId: string, resolution: PermissionResolution): boolean;
  resolvePendingStructuredInput?(requestId: string, resolution: StructuredInputResponse): boolean;
}

// ── Host Interface: Lifecycle Hooks ──────────────────────────

export interface LifecycleHooks {
  /** Called when the bridge system starts (e.g., to suppress competing polling). */
  onBridgeStart?(): void;
  /** Called when the bridge system stops. */
  onBridgeStop?(): void;
}
