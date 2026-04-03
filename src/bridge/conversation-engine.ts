/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ClaudePermissionMode } from '../runtime/claude-mode.js';
import { normalizeClaudePermissionMode } from '../runtime/claude-mode.js';
import type { ChannelBinding } from './types.js';
import type {
  ActivityEvent,
  FileAttachment,
  SSEEvent,
  StructuredInputRequestInfo,
  TokenUsage,
  MessageContentBlock,
} from './host.js';
import { getBridgeContext } from './context.js';
import crypto from 'crypto';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
  method?: string;
  threadId?: string;
  turnId?: string;
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

export type OnStructuredInputRequest = (request: StructuredInputRequestInfo) => Promise<void>;

export type OnServerRequestResolved = (requestId: string) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the current in-flight segment text.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

export type OnResponseSegment = (segmentText: string) => Promise<void> | void;

export type OnActivityEvent = (event: ActivityEvent) => Promise<void> | void;

export type OnModeChanged = (mode: ClaudePermissionMode) => Promise<void> | void;

export interface ConversationResult {
  responseText: string;
  responseSegments: string[];
  contentBlocks: MessageContentBlock[];
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
}

export interface ProcessMessageOptions {
  storedUserText?: string;
  permissionModeOverride?: string;
  collaborationModeOverride?: 'plan' | 'default';
  onModeChanged?: OnModeChanged;
}

interface PlanStepState {
  label?: string;
  title?: string;
  text?: string;
  description?: string;
  status?: string;
}

function normalizePlanField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePlanStep(step: unknown): PlanStepState {
  if (typeof step === 'string') {
    return { text: normalizePlanField(step) };
  }
  const record = step as Record<string, unknown>;
  return {
    label: normalizePlanField(record.label),
    title: normalizePlanField(record.title) ?? normalizePlanField(record.step),
    text: normalizePlanField(record.text),
    description: normalizePlanField(record.description),
    status: normalizePlanField(record.status),
  };
}

function renderPlanMarkdown(explanation: string, steps: unknown[], body: string): string {
  const lines: string[] = [];
  if (explanation.trim()) {
    lines.push(explanation.trim(), '');
  }
  const normalizedSteps = steps
    .map(normalizePlanStep)
    .filter((step) => step.label || step.title || step.text || step.description);
  if (normalizedSteps.length > 0) {
    lines.push('计划步骤');
    normalizedSteps.forEach((step, index) => {
      const summary = step.label || step.title || step.text || step.description || '未命名步骤';
      const detail = step.description
        || (step.text && step.text !== summary ? step.text : undefined)
        || (step.title && step.label && step.title !== summary ? step.title : undefined);
      const status = step.status ? ` [${step.status}]` : '';
      lines.push(`${index + 1}. ${summary}${status}`);
      if (detail) {
        lines.push(`    ${detail}`);
      }
    });
    lines.push('');
  }
  if (body.trim()) {
    lines.push(body.trim());
  }
  return lines.join('\n').trim();
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isDuplicatePlanSegment(candidate: string, renderedPlan: string): boolean {
  const normalizedCandidate = normalizeComparableText(candidate);
  const normalizedPlan = normalizeComparableText(renderedPlan);
  if (!normalizedCandidate || !normalizedPlan) return false;
  if (normalizedCandidate === normalizedPlan) return true;
  if (normalizedCandidate.length >= 80 && normalizedPlan.includes(normalizedCandidate)) return true;
  if (normalizedPlan.length >= 80 && normalizedCandidate.includes(normalizedPlan)) return true;
  return false;
}

function dropTrailingDuplicatePlanText(
  responseSegments: string[],
  contentBlocks: MessageContentBlock[],
  renderedPlan: string,
): void {
  while (responseSegments.length > 0 && isDuplicatePlanSegment(responseSegments.at(-1) || '', renderedPlan)) {
    responseSegments.pop();
    for (let index = contentBlocks.length - 1; index >= 0; index -= 1) {
      if (contentBlocks[index]?.type === 'text') {
        contentBlocks.splice(index, 1);
        break;
      }
    }
  }
}

function resolveLegacyPermissionMode(binding: ChannelBinding): ClaudePermissionMode {
  switch (binding.mode) {
    case 'plan':
      return 'plan';
    case 'ask':
      return 'default';
    default:
      return 'acceptEdits';
  }
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  options?: ProcessMessageOptions,
  onStructuredInputRequest?: OnStructuredInputRequest,
  onServerRequestResolved?: OnServerRequestResolved,
  onResponseSegment?: OnResponseSegment,
  onActivityEvent?: OnActivityEvent,
): Promise<ConversationResult> {
  const { store, llm } = getBridgeContext();
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      responseSegments: [],
      contentBlocks: [],
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');

  // Lock renewal interval
  const renewalInterval = setInterval(() => {
    try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    // Resolve session early — needed for workingDirectory and provider resolution
    const session = store.getSession(sessionId);
    const runtime = store.getSessionExt(sessionId)?.runtime || 'claude';

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    const storedUserText = options?.storedUserText ?? text;
    let savedContent = storedUserText;
    if (files && files.length > 0) {
      const workDir = binding.workingDirectory || session?.working_directory || '';
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }
          const fileMeta = files.map((f) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(uploadDir, `${Date.now()}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(fileMeta)}-->${storedUserText}`;
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} image(s) attached] ${storedUserText}`;
        }
      } else {
        savedContent = `[${files.length} image(s) attached] ${storedUserText}`;
      }
    }
    store.addMessage(sessionId, 'user', savedContent);

    // Resolve provider
    let resolvedProvider: import('./host.js').BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = store.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = store.getDefaultProviderId();
      if (defaultId) resolvedProvider = store.getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = binding.model || session?.model || undefined;

    // Permission mode from binding mode
    let permissionMode = options?.permissionModeOverride;
    if (!permissionMode) {
      permissionMode = runtime === 'claude'
        ? (binding.claudePermissionMode || resolveLegacyPermissionMode(binding))
        : resolveLegacyPermissionMode(binding);
    }

    // Load conversation history for context
    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const stream = llm.streamChat({
      prompt: text,
      sessionId,
      sdkSessionId: runtime === 'codex'
        ? store.getCodexThreadId(sessionId) || undefined
        : binding.sdkSessionId || undefined,
      model: effectiveModel,
      systemPrompt: session?.system_prompt || undefined,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      conversationHistory: historyMsgs,
      files,
      onRuntimeStatusChange: (status: string) => {
        try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
      collaborationMode: options?.collaborationModeOverride,
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(
      stream,
      sessionId,
      runtime,
      options?.collaborationModeOverride,
      onPermissionRequest,
      onPartialText,
      onStructuredInputRequest,
      onServerRequestResolved,
      onResponseSegment,
      onActivityEvent,
      options?.onModeChanged,
    );
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  runtime: 'claude' | 'codex',
  collaborationModeOverride?: ProcessMessageOptions['collaborationModeOverride'],
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onStructuredInputRequest?: OnStructuredInputRequest,
  onServerRequestResolved?: OnServerRequestResolved,
  onResponseSegment?: OnResponseSegment,
  onActivityEvent?: OnActivityEvent,
  onModeChanged?: OnModeChanged,
): Promise<ConversationResult> {
  const { store } = getBridgeContext();
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  const responseSegments: string[] = [];
  let currentText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;
  let planExplanation = '';
  let planSteps: unknown[] = [];
  let planBody = '';
  let bufferedLeadingSegment = '';

  const mergeBufferedLeadingSegment = (text: string): string => {
    const normalized = text.trim();
    if (!bufferedLeadingSegment) return normalized;
    return normalized.startsWith(bufferedLeadingSegment)
      ? normalized
      : `${bufferedLeadingSegment}${normalized}`.trim();
  };

  const shouldBufferLeadingSegment = (text: string): boolean => {
    const compact = text.replace(/\s+/g, '');
    return !bufferedLeadingSegment && responseSegments.length === 0 && compact.length > 0 && compact.length <= 2;
  };

  const currentPreviewText = (): string => {
    const merged = mergeBufferedLeadingSegment(currentText);
    if (!bufferedLeadingSegment && shouldBufferLeadingSegment(currentText)) {
      return '';
    }
    return merged;
  };

  const appendTextSegment = async (text: string): Promise<void> => {
    const normalized = text.trim();
    if (!normalized) return;
    const merged = mergeBufferedLeadingSegment(normalized);
    bufferedLeadingSegment = '';
    contentBlocks.push({ type: 'text', text: merged });
    responseSegments.push(merged);
    if (onResponseSegment) {
      await onResponseSegment(merged);
    }
  };

  const flushBufferedLeadingSegment = async (): Promise<void> => {
    if (!bufferedLeadingSegment) return;
    const carry = bufferedLeadingSegment;
    bufferedLeadingSegment = '';
    await appendTextSegment(carry);
  };

  const finalizeTextSegment = async (preferredText?: string): Promise<void> => {
    const segment = typeof preferredText === 'string' && preferredText.length > 0
      ? preferredText
      : currentText;
    currentText = '';
    const normalized = segment.trim();
    if (!normalized) return;
    if (shouldBufferLeadingSegment(normalized)) {
      bufferedLeadingSegment = normalized;
      return;
    }
    // Codex app-server can emit tool events before the corresponding
    // agentMessage item completes. We may flush `currentText` at the tool
    // boundary and later receive a `text_segment` completion for the same
    // exact text. Avoid double-emitting identical consecutive segments.
    if (typeof preferredText === 'string') {
      const merged = mergeBufferedLeadingSegment(normalized);
      if (merged && responseSegments.at(-1) === merged) {
        bufferedLeadingSegment = '';
        return;
      }
    }
    await appendTextSegment(normalized);
  };

  const flushTextBoundary = async (flushBuffered = false): Promise<void> => {
    if (currentText.trim()) {
      await finalizeTextSegment();
    }
    if (flushBuffered && bufferedLeadingSegment) {
      await flushBufferedLeadingSegment();
    }
  };

  const emitPlanPreview = () => {
    if (!onPartialText) return;
    const rendered = renderPlanMarkdown(planExplanation, planSteps, planBody);
    if (rendered) {
      try { onPartialText(rendered); } catch { /* non-critical */ }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              try { onPartialText(currentPreviewText()); } catch { /* non-critical */ }
            }
            break;

          case 'text_segment':
            await finalizeTextSegment(event.data);
            break;

          case 'tool_use': {
            await flushTextBoundary();
            try {
              const toolData = JSON.parse(event.data);
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request':
          case 'approval_request': {
            await flushTextBoundary();
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
                method: typeof permData.method === 'string' ? permData.method : undefined,
                threadId: typeof permData.threadId === 'string' ? permData.threadId : undefined,
                turnId: typeof permData.turnId === 'string' ? permData.turnId : undefined,
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'structured_input_request': {
            await flushTextBoundary();
            try {
              const request = JSON.parse(event.data) as StructuredInputRequestInfo;
              if (onStructuredInputRequest) {
                onStructuredInputRequest(request).catch((err) => {
                  console.error('[conversation-engine] Failed to forward structured input request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'server_request_resolved': {
            await flushTextBoundary();
            try {
              const payload = JSON.parse(event.data) as { requestId?: string };
              if (payload.requestId && onServerRequestResolved) {
                onServerRequestResolved(payload.requestId).catch((err) => {
                  console.error('[conversation-engine] Failed to forward resolved server request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'plan_state': {
            await flushTextBoundary();
            try {
              const planData = JSON.parse(event.data) as { explanation?: string | null; plan?: unknown[] };
              planExplanation = planData.explanation || '';
              planSteps = Array.isArray(planData.plan) ? planData.plan : [];
              emitPlanPreview();
            } catch { /* skip */ }
            break;
          }

          case 'plan_delta':
            planBody += event.data;
            emitPlanPreview();
            break;

          case 'plan_result':
            await flushTextBoundary();
            planBody = event.data;
            emitPlanPreview();
            break;

          case 'activity_event': {
            try {
              const activity = JSON.parse(event.data) as ActivityEvent;
              if (onActivityEvent) {
                await onActivityEvent(activity);
              }
            } catch { /* skip */ }
            break;
          }

          case 'status': {
            try {
              const statusData = JSON.parse(event.data);
              if (statusData.session_id) {
                capturedSdkSessionId = statusData.session_id;
                if (runtime === 'codex') {
                  store.updateCodexThreadId(sessionId, statusData.session_id);
                } else {
                  store.updateSdkSessionId(sessionId, statusData.session_id);
                }
              }
              if (statusData.model) {
                store.updateSessionModel(sessionId, statusData.model);
              }
              if (statusData.reasoning && onActivityEvent) {
                await onActivityEvent({
                  kind: 'lightweight_activity',
                  id: `lightweight:${capturedSdkSessionId || sessionId}`,
                  turnId: typeof statusData.turn_id === 'string' ? statusData.turn_id : undefined,
                  status: 'running',
                  text: '正在思考…',
                  source: 'reasoning',
                });
              }
              if (statusData.context_usage && onActivityEvent) {
                const usage = statusData.context_usage as Record<string, unknown>;
                await onActivityEvent({
                  kind: 'context_usage',
                  id: `context:${capturedSdkSessionId || sessionId}`,
                  turnId: typeof statusData.turn_id === 'string' ? statusData.turn_id : undefined,
                  inputTokens: Number(usage.input_tokens || 0),
                  outputTokens: Number(usage.output_tokens || 0),
                  cacheReadInputTokens: Number(usage.cache_read_input_tokens || 0),
                });
              }
            } catch { /* skip */ }
            break;
          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                store.syncSdkTasks(taskData.session_id, taskData.todos);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error':
            hasError = true;
            errorMessage = event.data || 'Unknown error';
            break;

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error) hasError = true;
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                if (runtime === 'codex') {
                  store.updateCodexThreadId(sessionId, resultData.session_id);
                } else {
                  store.updateSdkSessionId(sessionId, resultData.session_id);
                }
              }
            } catch { /* skip */ }
            break;
          }

          case 'mode_changed': {
            try {
              const modeData = JSON.parse(event.data);
              const nextMode = normalizeClaudePermissionMode(
                typeof modeData.mode === 'string'
                  ? modeData.mode
                  : typeof modeData.permissionMode === 'string'
                    ? modeData.permissionMode
                    : typeof modeData.permission_mode === 'string'
                      ? modeData.permission_mode
                      : undefined,
              );
              if (nextMode && onModeChanged) {
                await onModeChanged(nextMode);
              }
            } catch {
              // ignore malformed mode updates
            }
            break;
          }

          // tool_output, tool_timeout, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    await flushTextBoundary(true);
    const renderedPlan = renderPlanMarkdown(planExplanation, planSteps, planBody);
    if (runtime === 'codex' && collaborationModeOverride === 'plan' && renderedPlan) {
      dropTrailingDuplicatePlanText(responseSegments, contentBlocks, renderedPlan);
    }
    if (renderedPlan && responseSegments.at(-1) !== renderedPlan) {
      await appendTextSegment(renderedPlan);
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = responseSegments.join('\n\n').trim();

    return {
      responseText,
      responseSegments,
      contentBlocks: [...contentBlocks],
      tokenUsage,
      hasError,
      errorMessage,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    // Best-effort save on stream error
    await flushTextBoundary(true);
    const renderedPlan = renderPlanMarkdown(planExplanation, planSteps, planBody);
    if (runtime === 'codex' && collaborationModeOverride === 'plan' && renderedPlan) {
      dropTrailingDuplicatePlanText(responseSegments, contentBlocks, renderedPlan);
    }
    if (renderedPlan && responseSegments.at(-1) !== renderedPlan) {
      await appendTextSegment(renderedPlan);
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        store.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      responseSegments: [],
      contentBlocks: [...contentBlocks],
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}
