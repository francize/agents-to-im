import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexAppServerClient, type CodexServerMessage } from './codex-app-server-client.js';
import type { LLMProvider, StreamChatParams, StructuredInputRequestInfo } from './bridge/host.js';
import {
  PendingApprovals,
  PendingStructuredInputs,
  type PermissionResolution,
} from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

type JsonRecord = Record<string, unknown>;

interface ThreadBootstrap {
  threadId: string;
  model?: string;
}

interface TokenUsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function parseTomlStringLiteral(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
    return trimmed.slice(1, -1);
  }
  return null;
}

export function parseTrustedProjectsFromCodexConfig(content: string): string[] {
  const trustedProjects: string[] = [];
  let currentProject: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sectionMatch = trimmed.match(/^\[projects\.(.+)\]$/);
    if (sectionMatch) {
      currentProject = parseTomlStringLiteral(sectionMatch[1] || '');
      continue;
    }

    if (!currentProject) continue;

    const trustMatch = trimmed.match(/^trust_level\s*=\s*(.+)$/);
    if (!trustMatch) continue;

    if (parseTomlStringLiteral(trustMatch[1] || '') === 'trusted') {
      trustedProjects.push(currentProject);
    }
  }

  return trustedProjects;
}

function isPathWithin(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (normalizedRoot === normalizedTarget) return true;
  if (normalizedRoot === path.parse(normalizedRoot).root) {
    return normalizedTarget.startsWith(normalizedRoot);
  }
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

export function isTrustedCodexWorkingDirectory(workingDirectory: string | undefined, trustedRoots: string[]): boolean {
  if (!workingDirectory) return false;
  return trustedRoots.some((root) => isPathWithin(root, workingDirectory));
}

function hasLocalCodexConfig(): boolean {
  return fs.existsSync(path.join(resolveCodexHome(), 'config.toml'));
}

function looksLikeClaudeModel(model?: string): boolean {
  return !!model && /^claude[-_]/i.test(model);
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

function toApprovalPolicy(permissionMode?: string): 'on-request' | 'on-failure' {
  switch (permissionMode) {
    case 'acceptEdits':
      return 'on-failure';
    case 'plan':
    case 'default':
    default:
      return 'on-request';
  }
}

function toTextInput(text: string): { type: 'text'; text: string; text_elements: [] } {
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

function mapRuntimeStatus(status: unknown): string {
  const type = typeof status === 'object' && status && typeof (status as JsonRecord).type === 'string'
    ? String((status as JsonRecord).type)
    : '';
  switch (type) {
    case 'active':
      return 'running';
    case 'idle':
      return 'idle';
    case 'systemError':
      return 'error';
    default:
      return type || 'unknown';
  }
}

function mapTokenUsage(breakdown: TokenUsageBreakdown | undefined): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
} | undefined {
  if (!breakdown) return undefined;
  return {
    input_tokens: breakdown.inputTokens || 0,
    output_tokens: breakdown.outputTokens || 0,
    cache_read_input_tokens: breakdown.cachedInputTokens || 0,
  };
}

function buildCollaborationMode(model: string): { mode: 'plan' | 'default'; settings: { model: string; reasoning_effort: null; developer_instructions: null } } {
  return {
    mode: 'plan',
    settings: {
      model,
      reasoning_effort: null,
      developer_instructions: null,
    },
  };
}

function buildUnsupportedRequestError(method: string): Error {
  return new Error(`[codex-provider] Unsupported server request: ${method}`);
}

function normalizeItemType(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function approvalToolPayload(method: string, params: JsonRecord): { toolName: string; toolInput: JsonRecord } {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return {
        toolName: 'Bash',
        toolInput: {
          command: params.command,
          cwd: params.cwd,
          reason: params.reason,
          commandActions: params.commandActions,
          additionalPermissions: params.additionalPermissions,
        },
      };
    case 'item/fileChange/requestApproval':
      return {
        toolName: 'Edit',
        toolInput: {
          reason: params.reason,
          grantRoot: params.grantRoot,
        },
      };
    case 'item/permissions/requestApproval':
      return {
        toolName: 'Permissions',
        toolInput: {
          reason: params.reason,
          permissions: params.permissions,
        },
      };
    default:
      return {
        toolName: method,
        toolInput: params,
      };
  }
}

function approvalResponseFor(method: string, params: JsonRecord, resolution: PermissionResolution): unknown {
  if (method === 'item/fileChange/requestApproval') {
    return {
      decision: resolution.behavior === 'deny'
        ? 'decline'
        : resolution.scope === 'session'
          ? 'acceptForSession'
          : 'accept',
    };
  }
  if (method === 'item/permissions/requestApproval') {
    return {
      permissions: resolution.behavior === 'deny' ? {} : (params.permissions || {}),
      scope: resolution.scope === 'session' ? 'session' : 'turn',
    };
  }
  return {
    decision: resolution.behavior === 'deny'
      ? 'decline'
      : resolution.scope === 'session'
        ? 'acceptForSession'
        : 'accept',
  };
}

function parseStructuredInputRequest(requestId: string, params: JsonRecord): StructuredInputRequestInfo {
  return {
    requestId,
    threadId: String(params.threadId || ''),
    turnId: String(params.turnId || ''),
    itemId: String(params.itemId || ''),
    questions: Array.isArray(params.questions) ? params.questions as StructuredInputRequestInfo['questions'] : [],
  };
}

function extractThreadId(message: CodexServerMessage): string {
  const params = typeof message.params === 'object' && message.params ? message.params as JsonRecord : {};
  return typeof params.threadId === 'string' ? params.threadId : '';
}

function extractTurnId(message: CodexServerMessage): string {
  const params = typeof message.params === 'object' && message.params ? message.params as JsonRecord : {};
  return typeof params.turnId === 'string' ? params.turnId : '';
}

async function buildUserInput(
  prompt: string,
  files: StreamChatParams['files'],
): Promise<{ input: Array<Record<string, unknown>>; tempFiles: string[] }> {
  const tempFiles: string[] = [];
  const input: Array<Record<string, unknown>> = [toTextInput(prompt)];

  for (const file of files ?? []) {
    if (!file.type.startsWith('image/')) continue;
    const ext = MIME_EXT[file.type] || '.png';
    const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
    tempFiles.push(tmpPath);
    input.push({ type: 'localImage', path: tmpPath });
  }

  return { input, tempFiles };
}

export class CodexProvider implements LLMProvider {
  private client: CodexAppServerClient | null = null;
  private readonly pendingApprovals: PendingApprovals;
  private readonly pendingStructuredInputs: PendingStructuredInputs;

  constructor(
    pendingApprovals?: unknown,
    pendingStructuredInputs?: unknown,
  ) {
    this.pendingApprovals = pendingApprovals instanceof PendingApprovals
      ? pendingApprovals
      : new PendingApprovals();
    this.pendingStructuredInputs = pendingStructuredInputs instanceof PendingStructuredInputs
      ? pendingStructuredInputs
      : new PendingStructuredInputs();
  }

  private async ensureClient(): Promise<CodexAppServerClient> {
    if (this.client) {
      await this.client.prepare();
      return this.client;
    }
    const client = new CodexAppServerClient();
    await client.prepare();
    this.client = client;
    return client;
  }

  async prepare(): Promise<void> {
    await this.ensureClient();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async supportsNativePlan(): Promise<boolean> {
    const client = await this.ensureClient();
    return client.supportsCollaborationMode('plan');
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        void self.run(controller, params);
      },
    });
  }

  private async run(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
  ): Promise<void> {
    const client = await this.ensureClient();
    const tempFiles: string[] = [];
    let unsubscribe: (() => void) | null = null;

    try {
      const bootstrap = await this.bootstrapThread(client, params);
      const threadId = bootstrap.threadId;
      const queue: CodexServerMessage[] = [];
      let wakeQueue: (() => void) | null = null;
      let tokenUsage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } | undefined;

      unsubscribe = client.subscribe((message) => {
        if (extractThreadId(message) !== threadId) return;
        queue.push(message);
        wakeQueue?.();
        wakeQueue = null;
      });

      controller.enqueue(sseEvent('status', {
        session_id: threadId,
        ...(bootstrap.model ? { model: bootstrap.model } : {}),
      }));

      const { input, tempFiles: createdTemps } = await buildUserInput(params.prompt, params.files);
      tempFiles.push(...createdTemps);

      const turnParams: JsonRecord = {
        threadId,
        input,
      };
      if (params.workingDirectory) {
        turnParams.cwd = params.workingDirectory;
      }
      if (params.model) {
        turnParams.model = params.model;
        turnParams.effort = null;
      }
      if (!hasLocalCodexConfig() && params.permissionMode) {
        turnParams.approvalPolicy = toApprovalPolicy(params.permissionMode);
      }
      if (params.collaborationMode === 'plan') {
        if (!client.supportsCollaborationMode('plan')) {
          throw new Error('Local Codex does not support native plan mode');
        }
        turnParams.collaborationMode = buildCollaborationMode(params.model || bootstrap.model || 'gpt-5.4');
      }

      const turnStart = await client.call<{ turn?: { id?: string } }>('turn/start', turnParams);
      let activeTurnId = typeof turnStart?.turn?.id === 'string' ? turnStart.turn.id : '';

      while (true) {
        if (params.abortController?.signal.aborted) {
          break;
        }

        const message = await this.readNext(queue, () => {
          if (wakeQueue) return;
          wakeQueue = () => {};
        }, () => {
          if (queue.length > 0) return;
          return new Promise<void>((resolve) => {
            wakeQueue = resolve;
          });
        });
        if (!message) continue;

        if (message.kind === 'request') {
          await this.handleServerRequest(client, controller, message);
          continue;
        }

        const paramsRecord = (typeof message.params === 'object' && message.params ? message.params as JsonRecord : {});
        switch (message.method) {
          case 'thread/status/changed':
            params.onRuntimeStatusChange?.(mapRuntimeStatus(paramsRecord.status));
            break;
          case 'thread/tokenUsage/updated':
            tokenUsage = mapTokenUsage((paramsRecord.tokenUsage as JsonRecord | undefined)?.last as TokenUsageBreakdown | undefined);
            break;
          case 'turn/started':
            activeTurnId = typeof (paramsRecord.turn as JsonRecord | undefined)?.id === 'string'
              ? String((paramsRecord.turn as JsonRecord).id)
              : activeTurnId;
            break;
          case 'item/agentMessage/delta':
            if (typeof paramsRecord.delta === 'string') {
              controller.enqueue(sseEvent('text', paramsRecord.delta));
            }
            break;
          case 'item/reasoning/textDelta':
          case 'item/reasoning/summaryTextDelta':
            if (typeof paramsRecord.delta === 'string') {
              controller.enqueue(sseEvent('status', { reasoning: paramsRecord.delta }));
            }
            break;
          case 'turn/plan/updated':
            controller.enqueue(sseEvent('plan_state', paramsRecord));
            break;
          case 'item/plan/delta':
            if (typeof paramsRecord.delta === 'string') {
              controller.enqueue(sseEvent('plan_delta', paramsRecord.delta));
            }
            break;
          case 'item/completed':
            if (activeTurnId && extractTurnId(message) && extractTurnId(message) !== activeTurnId) {
              break;
            }
            this.handleCompletedItem(controller, paramsRecord.item as JsonRecord);
            break;
          case 'serverRequest/resolved':
            controller.enqueue(sseEvent('server_request_resolved', paramsRecord));
            break;
          case 'error':
            controller.enqueue(sseEvent('error', String((paramsRecord.error as JsonRecord | undefined)?.message || 'Turn failed')));
            break;
          case 'turn/completed':
            controller.enqueue(sseEvent('result', {
              ...(tokenUsage ? { usage: tokenUsage } : {}),
              session_id: threadId,
              is_error: !!(paramsRecord.turn as JsonRecord | undefined)?.error,
            }));
            controller.close();
            return;
        }
      }

      controller.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[codex-provider] Error:', error instanceof Error ? error.stack || error.message : error);
      try {
        controller.enqueue(sseEvent('error', message));
        controller.close();
      } catch {
        // no-op
      }
    } finally {
      unsubscribe?.();
      for (const tmp of tempFiles) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
    }
  }

  private async bootstrapThread(client: CodexAppServerClient, params: StreamChatParams): Promise<ThreadBootstrap> {
    let savedThreadId = params.sdkSessionId || undefined;
    if (savedThreadId && looksLikeClaudeModel(params.model)) {
      savedThreadId = undefined;
    }

    const threadParams: JsonRecord = {
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    };
    if (params.workingDirectory) {
      threadParams.cwd = params.workingDirectory;
    }
    if (!hasLocalCodexConfig() && params.permissionMode) {
      threadParams.approvalPolicy = toApprovalPolicy(params.permissionMode);
    }

    let retriedFresh = false;
    while (true) {
      try {
        if (savedThreadId) {
          const resumed = await client.call<{ thread?: { id?: string }; model?: string }>('thread/resume', {
            ...threadParams,
            threadId: savedThreadId,
          });
          return {
            threadId: String(resumed.thread?.id || savedThreadId),
            model: typeof resumed.model === 'string' ? resumed.model : undefined,
          };
        }

        const started = await client.call<{ thread?: { id?: string }; model?: string }>('thread/start', threadParams);
        const threadId = started.thread?.id;
        if (typeof threadId !== 'string' || !threadId) {
          throw new Error('thread/start succeeded without thread id');
        }
        return {
          threadId,
          model: typeof started.model === 'string' ? started.model : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (savedThreadId && !retriedFresh && shouldRetryFreshThread(message)) {
          savedThreadId = undefined;
          retriedFresh = true;
          continue;
        }
        throw error;
      }
    }
  }

  private async handleServerRequest(
    client: CodexAppServerClient,
    controller: ReadableStreamDefaultController<string>,
    message: Extract<CodexServerMessage, { kind: 'request' }>,
  ): Promise<void> {
    const params = typeof message.params === 'object' && message.params ? message.params as JsonRecord : {};

    if (message.method === 'item/tool/requestUserInput') {
      const request = parseStructuredInputRequest(String(message.id), params);
      controller.enqueue(sseEvent('structured_input_request', request));
      const response = await this.pendingStructuredInputs.waitFor(request.requestId);
      await client.respond(message.id, response);
      return;
    }

    if (
      message.method === 'item/commandExecution/requestApproval' ||
      message.method === 'item/fileChange/requestApproval' ||
      message.method === 'item/permissions/requestApproval'
    ) {
      const requestId = String(message.id);
      const { toolName, toolInput } = approvalToolPayload(message.method, params);
      controller.enqueue(sseEvent('approval_request', {
        permissionRequestId: requestId,
        toolName,
        toolInput,
        suggestions: [],
      }));
      const resolution = await this.pendingApprovals.waitFor(requestId);
      await client.respond(message.id, approvalResponseFor(message.method, params, resolution));
      return;
    }

    await client.respondError(message.id, -32601, buildUnsupportedRequestError(message.method).message);
  }

  private async readNext(
    queue: CodexServerMessage[],
    _arm: () => void,
    wait: () => Promise<void> | undefined,
  ): Promise<CodexServerMessage | null> {
    if (queue.length > 0) {
      return queue.shift() || null;
    }
    const waiter = wait();
    if (waiter) {
      await waiter;
    }
    return queue.shift() || null;
  }

  private handleCompletedItem(
    controller: ReadableStreamDefaultController<string>,
    item: JsonRecord | undefined,
  ): void {
    if (!item) return;
    const itemType = normalizeItemType(item.type);

    switch (itemType) {
      case 'agentMessage': {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) {
          controller.enqueue(sseEvent('text_segment', text));
        }
        break;
      }
      case 'plan': {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) {
          controller.enqueue(sseEvent('plan_result', text));
        }
        break;
      }
      case 'commandExecution': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const command = typeof item.command === 'string' ? item.command : '';
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
        const isError = exitCode !== null && exitCode !== 0;
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command, cwd: item.cwd },
        }));
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: output || (isError ? `Exit code: ${exitCode}` : 'Done'),
          is_error: isError,
        }));
        break;
      }
      case 'fileChange': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const summary = changes
          .map((change) => {
            const record = change as JsonRecord;
            return `${String(record.kind || 'update')}: ${String(record.path || '')}`;
          })
          .join('\n');
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        break;
      }
      case 'mcpToolCall': {
        const toolId = typeof item.id === 'string' ? item.id : `tool-${Date.now()}`;
        const server = typeof item.server === 'string' ? item.server : '';
        const tool = typeof item.tool === 'string' ? item.tool : '';
        const result = item.result as JsonRecord | null | undefined;
        const error = item.error as JsonRecord | null | undefined;
        const content = result?.content ?? result?.structuredContent ?? result?.structured_content;
        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: item.arguments,
        }));
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: typeof content === 'string' ? content : content ? JSON.stringify(content) : String(error?.message || 'Done'),
          is_error: !!error,
        }));
        break;
      }
      case 'reasoning': {
        const parts = Array.isArray(item.content) ? item.content.filter((part): part is string => typeof part === 'string') : [];
        const text = parts.join('\n').trim();
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}
