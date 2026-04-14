/**
 * LLM Provider using @anthropic-ai/claude-agent-sdk query() function.
 *
 * Converts SDK stream events into the SSE format expected by
 * the upstream bridge conversation engine.
 */

import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  PermissionResult as ClaudePermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ActivityEvent,
  FileAttachment,
  LLMProvider,
  StreamChatParams,
  StructuredInputRequestInfo,
  StructuredInputResponse,
} from '../../bridge/host.js';
import { normalizeClaudePermissionMode } from '../../runtime/claude-mode.js';
import { buildSubprocessEnv } from './cli-support.js';
import type { PendingPermissions, PendingStructuredInputs } from './permission-gateway.js';

import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

// ── Auth/credential-error detection ──

/** Patterns indicating the local CLI is not logged in (fixable via `claude auth login`). */
const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /loggedIn['":\s]*false/i,
];

/**
 * Patterns indicating an API-level credential failure (wrong key, expired token, org restriction).
 * Must be specific to API/auth context — avoid matching local file permissions, tool denials,
 * or generic HTTP 403s that may have non-auth causes.
 */
const API_AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
];

export type AuthErrorKind = 'cli' | 'api' | false;

/**
 * Classify an error message as a CLI login issue, an API credential issue, or neither.
 * Returns 'cli' for local auth problems, 'api' for remote credential problems, false otherwise.
 */
export function classifyAuthError(text: string): AuthErrorKind {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}

/** Backwards-compatible: returns true for any auth/credential error. */
export function isAuthError(text: string): boolean {
  return classifyAuthError(text) !== false;
}

const CLI_AUTH_USER_MESSAGE =
  'Claude CLI is not logged in. Run `claude auth login`, then restart the bridge.';

const API_AUTH_USER_MESSAGE =
  'API credential error. Check your ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config.env, ' +
  'or verify your organization has access to the requested model.';

/**
 * Claude CLI-managed local config (for example `~/.claude.json` project-local
 * MCP registrations shown in `/mcp`) is only visible to the SDK when the
 * `local` source is enabled.
 */
export const CLAUDE_SETTING_SOURCES = ['local', 'user', 'project'] as const;

// ── Cross-runtime model guard ──

const NON_CLAUDE_MODEL_RE = /^(gpt-|o[1-9][-_]|codex[-_]|davinci|text-|openai\/)/i;

/** Return true if a model name clearly belongs to a non-Claude provider. */
export function isNonClaudeModel(model?: string): boolean {
  return !!model && NON_CLAUDE_MODEL_RE.test(model);
}

import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

/**
 * Build a prompt for query(). When files are present, returns an async
 * iterable that yields a single SDKUserMessage with multi-modal content
 * (image blocks + text). Otherwise returns the plain text string.
 */
function buildPrompt(
  text: string,
  files?: FileAttachment[],
): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
  const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) return text;

  const contentBlocks: unknown[] = [];

  for (const file of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
        data: file.data,
      },
    });
  }

  if (text.trim()) {
    contentBlocks.push({ type: 'text', text });
  }

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };

  return (async function* () { yield msg; })();
}

/**
 * Mutable state shared between the streaming loop and catch block.
 *
 * Key distinction:
 *   hasReceivedResult — set when the SDK delivers a `result` message
 *     (success OR structured error). This means the CLI completed its
 *     business logic; any subsequent "process exited with code 1" is
 *     just the transport tearing down and should be suppressed.
 *
 *   hasStreamedText — set when at least one text_delta was emitted.
 *     Used to distinguish "partial output + crash" (real failure, must
 *     emit error) from "business error only in assistant block" (use
 *     lastAssistantText instead of generic error).
 */
export interface StreamState {
  /** True once a `result` message (success or error subtype) has been processed. */
  hasReceivedResult: boolean;
  /** True once any text_delta has been emitted via stream_event. */
  hasStreamedText: boolean;
  /**
   * Full text captured from the final `assistant` message.
   * NOT emitted during normal flow (stream_event deltas handle that).
   * Used by the catch block to surface business errors that arrived
   * as assistant text but were followed by a CLI crash.
   */
  lastAssistantText: string;
  /** Stable tool name lookup for later tool_result updates. */
  toolNamesByUseId: Map<string, string>;
}

interface ClaudeAskUserQuestionOptionLike {
  label: string;
  description: string;
  preview?: string;
}

interface ClaudeAskUserQuestionQuestionLike {
  question: string;
  header: string;
  options?: ClaudeAskUserQuestionOptionLike[];
  multiSelect?: boolean;
}

interface ClaudeAskUserQuestionInputLike {
  questions?: ClaudeAskUserQuestionQuestionLike[];
}

function parseAskUserQuestionOptions(
  value: unknown,
): StructuredInputRequestInfo['questions'][number]['options'] {
  if (!Array.isArray(value)) return null;
  const options = value
    .filter((option): option is ClaudeAskUserQuestionOptionLike => !!option && typeof option === 'object')
    .map((option) => ({
      label: typeof option.label === 'string' ? option.label.trim() : '',
      description: typeof option.description === 'string' ? option.description.trim() : '',
      ...(typeof option.preview === 'string' && option.preview.trim()
        ? { preview: option.preview }
        : {}),
    }))
    .filter((option) => option.label.length > 0);
  return options.length > 0 ? options : null;
}

export function parseAskUserQuestionRequest(
  requestId: string,
  input: Record<string, unknown>,
): StructuredInputRequestInfo | null {
  const payload = input as ClaudeAskUserQuestionInputLike;
  if (!Array.isArray(payload.questions) || payload.questions.length === 0) {
    return null;
  }

  const questions = payload.questions
    .filter((question): question is ClaudeAskUserQuestionQuestionLike => !!question && typeof question === 'object')
    .map((question, index) => {
      const prompt = typeof question.question === 'string' ? question.question.trim() : '';
      if (!prompt) return null;
      return {
        id: `q${index + 1}`,
        header: typeof question.header === 'string' && question.header.trim()
          ? question.header.trim()
          : `问题 ${index + 1}`,
        question: prompt,
        isOther: true,
        isSecret: false,
        multiSelect: question.multiSelect === true,
        responseKey: prompt,
        options: parseAskUserQuestionOptions(question.options),
      };
    })
    .filter((question): question is NonNullable<typeof question> => question !== null);

  if (questions.length === 0) {
    return null;
  }

  return {
    requestId,
    threadId: '',
    turnId: '',
    itemId: '',
    questions,
  };
}

function normalizeStructuredAnswer(
  question: StructuredInputRequestInfo['questions'][number],
  values: string[] | undefined,
): string | null {
  const normalized = (values || [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (normalized.length === 0) return null;
  if (question.multiSelect) {
    return normalized.join(', ');
  }
  return normalized[0] || null;
}

export function buildAskUserQuestionResponse(
  request: StructuredInputRequestInfo,
  resolution: StructuredInputResponse,
): Record<string, unknown> | null {
  const answers: Record<string, string> = {};
  for (const question of request.questions) {
    const answer = normalizeStructuredAnswer(question, resolution.answers[question.id]?.answers);
    if (!answer) continue;
    answers[question.responseKey || question.question] = answer;
  }

  if (Object.keys(answers).length === 0) {
    return null;
  }

  return {
    questions: request.questions.map((question) => ({
      question: question.responseKey || question.question,
      header: question.header,
      options: (question.options || []).map((option) => ({
        label: option.label,
        description: option.description,
        ...(option.preview ? { preview: option.preview } : {}),
      })),
      multiSelect: question.multiSelect === true,
    })),
    answers,
  };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncatePreview(text: string, maxChars = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function formatMcpToolName(toolName: string): string {
  const withoutPrefix = toolName.replace(/^mcp__/, '');
  const parts = withoutPrefix.split('__');
  if (parts.length >= 2) {
    return `MCP: ${(parts[0] || '').trim()} ${parts.slice(1).join('__').trim()}`.trim();
  }
  return `MCP: ${withoutPrefix.trim()}`.trim();
}

function buildToolInputPreview(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return truncatePreview(stringifyUnknown(input));
  const record = input as Record<string, unknown>;

  if (toolName === 'Bash') {
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (command) return truncatePreview(command);
  }

  const filePath = typeof record.file_path === 'string'
    ? record.file_path.trim()
    : typeof record.filePath === 'string'
      ? record.filePath.trim()
      : '';
  if (filePath) return truncatePreview(filePath);

  const query = typeof record.query === 'string' ? record.query.trim() : '';
  if (query) return truncatePreview(query);

  return truncatePreview(stringifyUnknown(input));
}

function buildToolResultPreview(content: unknown): string {
  if (Array.isArray(content)) {
    const imageCount = content.filter((item) => {
      if (!item || typeof item !== 'object') return false;
      const record = item as Record<string, unknown>;
      const source = record.source;
      return record.type === 'image'
        && !!source
        && typeof source === 'object'
        && (source as Record<string, unknown>).type === 'base64';
    }).length;
    if (imageCount > 0) {
      return imageCount === 1 ? '返回了 1 张图片' : `返回了 ${imageCount} 张图片`;
    }
  }
  return truncatePreview(stringifyUnknown(content));
}

function buildToolActivityEvent(
  toolUseId: string,
  toolName: string,
  options: {
    status: 'pending' | 'running' | 'completed' | 'failed';
    input?: unknown;
    result?: unknown;
    parentToolUseId?: string | null;
    taskId?: string;
    elapsedSeconds?: number;
    source?: string;
  },
): ActivityEvent {
  return {
    kind: 'tool_activity',
    toolUseId,
    parentToolUseId: options.parentToolUseId,
    toolName: toolName.startsWith('mcp__') ? formatMcpToolName(toolName) : toolName,
    status: options.status,
    ...(options.input !== undefined ? { inputPreview: buildToolInputPreview(toolName, options.input) } : {}),
    ...(options.result !== undefined ? { resultPreview: buildToolResultPreview(options.result) } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(typeof options.elapsedSeconds === 'number' ? { elapsedSeconds: options.elapsedSeconds } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
}

export function mapSdkMessageToActivityEvent(msg: SDKMessage): ActivityEvent | null {
  if (msg.type === 'system') {
    switch (msg.subtype) {
      case 'status':
        if (msg.status === 'compacting') {
          return {
            kind: 'reasoning_activity',
            status: 'running',
            text: '正在压缩上下文…',
            source: 'compacting',
          };
        }
        return null;
      case 'task_started':
        return {
          kind: 'reasoning_activity',
          taskId: msg.task_id,
          status: 'running',
          text: msg.description,
          source: msg.task_type || 'task_started',
        };
      case 'task_progress':
        return {
          kind: 'reasoning_activity',
          taskId: msg.task_id,
          status: 'running',
          text: msg.last_tool_name
            ? `${msg.description} · ${msg.last_tool_name}`
            : msg.description,
          source: 'task_progress',
        };
      case 'task_notification':
        return {
          kind: 'reasoning_activity',
          taskId: msg.task_id,
          status: msg.status === 'failed' ? 'failed' : 'completed',
          text: msg.summary,
          source: msg.status,
        };
      case 'elicitation_complete':
        return {
          kind: 'reasoning_activity',
          status: 'completed',
          text: `MCP 输入请求已完成：${msg.mcp_server_name}`,
          source: 'elicitation_complete',
        };
      default:
        return null;
    }
  }

  switch (msg.type) {
    case 'tool_progress':
      return buildToolActivityEvent(msg.tool_use_id, msg.tool_name, {
        status: 'running',
        parentToolUseId: msg.parent_tool_use_id,
        taskId: msg.task_id,
        elapsedSeconds: msg.elapsed_time_seconds,
        source: 'tool_progress',
      });
    case 'tool_use_summary':
      return {
        kind: 'reasoning_activity',
        status: 'completed',
        text: msg.summary,
        source: 'tool_use_summary',
      };
    default:
      return null;
  }
}

function enqueueActivityEvent(
  controller: ReadableStreamDefaultController<string>,
  event: ActivityEvent,
): void {
  emitCanonicalTurnEvent(controller, { type: 'activity_event', data: event });
}

export class SDKLLMProvider implements LLMProvider {
  private cliPath: string | undefined;

  constructor(
    private pendingPerms: PendingPermissions,
    private pendingStructuredInputs: PendingStructuredInputs,
    cliPath?: string,
  ) {
    this.cliPath = cliPath;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const pendingStructuredInputs = this.pendingStructuredInputs;
    const cliPath = this.cliPath;

    return new ReadableStream({
      start(controller) {
        (async () => {
          // Ring-buffer for recent stderr output (max 4 KB)
          const MAX_STDERR = 4096;
          let stderrBuf = '';
          const state: StreamState = {
            hasReceivedResult: false,
            hasStreamedText: false,
            lastAssistantText: '',
            toolNamesByUseId: new Map<string, string>(),
          };

          try {
            const cleanEnv = buildSubprocessEnv();

            // Cross-runtime migration safety: drop non-Claude model names
            // that may linger in session data from a previous Codex runtime.
            let model = params.model;
            if (isNonClaudeModel(model)) {
              console.warn(`[llm-provider] Ignoring non-Claude model "${model}", using CLI default`);
              model = undefined;
            }

            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode: (params.permissionMode as 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan') || undefined,
              allowDangerouslySkipPermissions: true,
              includePartialMessages: true,
              // Keep local CLI-managed config (for MCPs in `~/.claude.json`),
              // user auth/billing settings, and project overrides aligned with
              // native Claude Code behavior.
              settingSources: [...CLAUDE_SETTING_SOURCES],
              toolConfig: {
                askUserQuestion: {
                  previewFormat: 'markdown',
                },
              },
              env: cleanEnv,
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > MAX_STDERR) {
                  stderrBuf = stderrBuf.slice(-MAX_STDERR);
                }
              },
              onElicitation: async (request: { serverName: string; mode?: 'form' | 'url'; message: string }) => {
                const detail = request.mode === 'url'
                  ? '当前飞书桥暂不支持 URL 授权输入，请转到本地 Claude Code 继续。'
                  : '当前飞书桥暂不支持 MCP 结构化输入，请转到本地 Claude Code 继续。';
                enqueueActivityEvent(controller, {
                  kind: 'lightweight_activity',
                  id: `claude-elicitation-declined:${request.serverName}:${Date.now()}`,
                  status: 'failed',
                  text: `${request.message} ${detail}`.trim(),
                  source: 'mcp_elicitation',
                });
                return { action: 'decline' as const };
              },
              canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: string[] },
                ): Promise<ClaudePermissionResult> => {
                  if (toolName === 'AskUserQuestion') {
                    const request = parseAskUserQuestionRequest(opts.toolUseID, input);
                    if (!request) {
                      enqueueActivityEvent(controller, {
                        kind: 'reasoning_activity',
                        status: 'failed',
                        text: '收到了无法识别的 AskUserQuestion 请求，已拒绝本轮澄清输入。',
                        source: 'ask_user_question',
                      });
                      return {
                        behavior: 'deny' as const,
                        message: 'Unsupported AskUserQuestion payload',
                      };
                    }

                    emitCanonicalTurnEvent(controller, { type: 'structured_input_request', data: request });
                    const resolution = await pendingStructuredInputs.waitFor(request.requestId);
                    const updatedInput = buildAskUserQuestionResponse(request, resolution);
                    if (updatedInput) {
                      return {
                        behavior: 'allow' as const,
                        updatedInput,
                      };
                    }
                    return {
                      behavior: 'deny' as const,
                      message: 'User input request timed out',
                    };
                  }

                  enqueueActivityEvent(controller, buildToolActivityEvent(opts.toolUseID, toolName, {
                    status: 'pending',
                    input,
                    source: 'permission_request',
                  }));
                  state.toolNamesByUseId.set(opts.toolUseID, toolName);

                  // Emit permission_request SSE event for the bridge
                  emitCanonicalTurnEvent(controller, {
                    type: 'permission_request',
                    data: {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    },
                  });

                  // Block until IM user responds
                  const result = await pendingPerms.waitFor(opts.toolUseID);

                  if (result.behavior === 'allow') {
                    return {
                      behavior: 'allow' as const,
                      updatedInput: input,
                      ...(Array.isArray(result.updatedPermissions)
                        ? { updatedPermissions: result.updatedPermissions as PermissionUpdate[] }
                        : {}),
                    };
                  }
                  enqueueActivityEvent(controller, buildToolActivityEvent(opts.toolUseID, toolName, {
                    status: 'failed',
                    input,
                    result: result.message || 'Denied by user',
                    source: result.interrupt ? 'permission_interrupt' : 'permission_deny',
                  }));
                  return {
                    behavior: 'deny' as const,
                    message: result.message || 'Denied by user',
                    ...(result.interrupt ? { interrupt: true } : {}),
                  };
                },
            };
            if (cliPath) {
              queryOptions.pathToClaudeCodeExecutable = cliPath;
            }

            const prompt = buildPrompt(params.prompt, params.files);
            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            for await (const msg of q) {
              handleMessage(msg, controller, state);
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[llm-provider] SDK query error:', err instanceof Error ? err.stack || err.message : err);
            if (stderrBuf) {
              console.error('[llm-provider] stderr from CLI:', stderrBuf.trim());
            }

            const isTransportExit = message.includes('process exited with code');

            // ── Case 1: Result already received ──
            // The SDK delivered a proper result (success or structured error).
            // A trailing "process exited with code 1" is transport teardown noise.
            if (state.hasReceivedResult && isTransportExit) {
              console.log('[llm-provider] Suppressing transport error — result already received');
              controller.close();
              return;
            }

            // ── Case 2: Recognised business error in assistant text ──
            // The CLI returned an assistant message with text that matches
            // a known auth/access error pattern (e.g. "Your organization
            // does not have access to Claude"). Forward it as-is — it's
            // more informative than the generic transport error.
            // Only activate when the text is a recognised error; otherwise
            // a normal response that crashed before result would be silently
            // presented as if it succeeded.
            if (state.lastAssistantText && classifyAuthError(state.lastAssistantText)) {
              emitCanonicalTurnEvent(controller, { type: 'text', data: state.lastAssistantText });
              controller.close();
              return;
            }

            // ── Case 3: Partial output + crash ──
            // Text was streamed but no result arrived — the response was
            // truncated by a real crash. Always emit an error so the user
            // knows the output is incomplete.

            // ── Build user-facing error message ──
            const authKind = classifyAuthError(message) || classifyAuthError(stderrBuf);
            let userMessage: string;
            if (authKind === 'cli') {
              userMessage = CLI_AUTH_USER_MESSAGE;
            } else if (authKind === 'api') {
              userMessage = API_AUTH_USER_MESSAGE;
            } else if (isTransportExit) {
              const stderrSummary = stderrBuf.trim();
              const lines = [message];
              if (stderrSummary) {
                lines.push('', 'CLI stderr:', stderrSummary.slice(-1024));
              }
              lines.push(
                '',
                'Possible causes:',
                '• Claude CLI not authenticated — run: claude auth login',
                '• Claude CLI version too old (need >= 2.x) — run: claude --version',
                '• Missing ANTHROPIC_* env vars in daemon — check config.env',
                '',
                'Run `/agents-to-im doctor` to diagnose.',
              );
              userMessage = lines.join('\n');
            } else {
              userMessage = message;
            }

            emitCanonicalTurnEvent(controller, { type: 'error', data: userMessage });
            controller.close();
          }
        })();
      },
    });
  }
}

/** @internal Exported for testing. */
export function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
): void {
  const maybeModeChange = msg as SDKMessage & Record<string, unknown>;
  const nextMode = normalizeClaudePermissionMode(
    typeof maybeModeChange.mode === 'string'
      ? maybeModeChange.mode
      : typeof maybeModeChange.permissionMode === 'string'
        ? maybeModeChange.permissionMode
        : typeof maybeModeChange.permission_mode === 'string'
          ? maybeModeChange.permission_mode
          : undefined,
  );
  const maybeSubtype = typeof maybeModeChange.subtype === 'string' ? maybeModeChange.subtype : '';
  if (
    nextMode
    && (maybeSubtype === 'mode_changed'
      || maybeSubtype === 'permission_mode_changed'
      || maybeSubtype === 'set_permission_mode')
  ) {
    emitCanonicalTurnEvent(controller, { type: 'mode_changed', data: { mode: nextMode } });
  }

  const activity = mapSdkMessageToActivityEvent(msg);
  if (activity) {
    enqueueActivityEvent(controller, activity);
  }

  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        // Emit delta text — the bridge accumulates on its side
        emitCanonicalTurnEvent(controller, { type: 'text', data: event.delta.text });
        state.hasStreamedText = true;
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        state.toolNamesByUseId.set(event.content_block.id, event.content_block.name);
        enqueueActivityEvent(controller, buildToolActivityEvent(event.content_block.id, event.content_block.name, {
          status: 'running',
          input: 'input' in event.content_block ? event.content_block.input : {},
          source: 'stream_tool_use',
        }));
        emitCanonicalTurnEvent(controller, {
          type: 'tool_use',
          data: {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          },
        });
      }
      break;
    }

    case 'assistant': {
      // Full assistant message — capture text but do NOT emit it.
      // Text deltas are already streamed via stream_event above; emitting
      // the full text block here would duplicate the entire response.
      //
      // The captured text is used by the catch block to surface business
      // errors (e.g. "Your organization does not have access") that the
      // CLI returned as assistant text without prior streaming deltas.
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            state.toolNamesByUseId.set(block.id, block.name);
            enqueueActivityEvent(controller, buildToolActivityEvent(block.id, block.name, {
              status: 'running',
              input: block.input,
              parentToolUseId: msg.parent_tool_use_id,
              source: 'assistant_tool_use',
            }));
            emitCanonicalTurnEvent(controller, {
              type: 'tool_use',
              data: {
                id: block.id,
                name: block.name,
                input: block.input,
              },
            });
          }
        }
      }
      break;
    }

    case 'user': {
      // User messages contain tool_result blocks from completed tool calls
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            const text = typeof rb.content === 'string'
              ? rb.content
              : JSON.stringify(rb.content ?? '');
            enqueueActivityEvent(controller, buildToolActivityEvent(
              rb.tool_use_id,
              state.toolNamesByUseId.get(rb.tool_use_id) || 'Tool',
              {
              status: rb.is_error ? 'failed' : 'completed',
              result: rb.content,
              parentToolUseId: msg.parent_tool_use_id,
              source: 'tool_result',
              },
            ));
            emitCanonicalTurnEvent(controller, {
              type: 'tool_result',
              data: {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              },
            });
          }
        }
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      if (msg.subtype === 'success') {
        if (msg.is_error) {
          const errorText = [
            typeof msg.result === 'string' ? msg.result.trim() : '',
            state.lastAssistantText.trim(),
          ].find((value) => value.length > 0) || 'Unknown error';
          emitCanonicalTurnEvent(controller, { type: 'error', data: errorText });
        }
        emitCanonicalTurnEvent(controller, {
          type: 'result',
          data: {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          },
        });
      } else {
        // Error result from SDK (distinct from transport errors in catch)
        const errors = (
          'errors' in msg && Array.isArray(msg.errors)
            ? msg.errors
            : []
        )
          .map((error) => (typeof error === 'string' ? error.trim() : ''))
          .filter(Boolean)
          .join('; ');
        emitCanonicalTurnEvent(controller, { type: 'error', data: errors || 'Unknown error' });
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        emitCanonicalTurnEvent(controller, {
          type: 'status',
          data: {
            session_id: msg.session_id,
            model: msg.model,
          },
        });
      }
      break;
    }

    default:
      // Ignore other message types (auth_status, task_notification, etc.)
      break;
  }
}
