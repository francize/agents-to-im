import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CodexAppServerClient, type CodexServerMessage } from './app-server-client.js';
import type {
  ActivityEvent,
  ActivityFileChangeEntry,
  LLMProvider,
  StreamChatParams,
  StructuredInputRequestInfo,
} from '../../bridge/host.js';
import {
  PendingApprovals,
  PendingStructuredInputs,
  type PermissionResolution,
} from '../claude/permission-gateway.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

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

function buildCollaborationMode(
  mode: 'plan' | 'default',
  model: string,
): { mode: 'plan' | 'default'; settings: { model: string; reasoning_effort: null; developer_instructions: null } } {
  return {
    mode,
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

function normalizeRequestMethod(method: string): string {
  return method.trim().replace(/[_-]/g, '').toLowerCase();
}

function isApprovalRequestMethod(method: string): boolean {
  return normalizeRequestMethod(method).endsWith('requestapproval');
}

function inferApprovalToolName(method: string): string {
  const parts = method.split('/').filter(Boolean);
  const rawName = parts.length >= 2 ? parts[parts.length - 2] || method : method;
  const humanized = rawName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!humanized) return 'Approval';
  return humanized[0]!.toUpperCase() + humanized.slice(1);
}

function approvalToolPayload(method: string, params: JsonRecord): { toolName: string; toolInput: JsonRecord } {
  switch (normalizeRequestMethod(method)) {
    case 'item/commandexecution/requestapproval':
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
    case 'item/filechange/requestapproval':
      return {
        toolName: 'Edit',
        toolInput: {
          reason: params.reason,
          grantRoot: params.grantRoot,
        },
      };
    case 'item/permissions/requestapproval':
      return {
        toolName: 'Permissions',
        toolInput: {
          reason: params.reason,
          permissions: params.permissions,
        },
      };
    default:
      return {
        toolName: inferApprovalToolName(method),
        toolInput: params,
      };
  }
}

function approvalResponseFor(method: string, params: JsonRecord, resolution: PermissionResolution): unknown {
  if (normalizeRequestMethod(method) === 'item/filechange/requestapproval') {
    return {
      decision: resolution.behavior === 'deny'
        ? 'decline'
        : resolution.scope === 'session'
          ? 'acceptForSession'
          : 'accept',
    };
  }
  if (normalizeRequestMethod(method) === 'item/permissions/requestapproval') {
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

function isRunningTurnStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const normalized = status.trim().toLowerCase();
  return normalized === 'in_progress'
    || normalized === 'running'
    || normalized === 'active'
    || normalized === 'pending';
}

function extractInFlightTurnIdFromThreadRead(response: unknown): string {
  const root = typeof response === 'object' && response ? response as JsonRecord : {};
  const thread = typeof root.thread === 'object' && root.thread ? root.thread as JsonRecord : root;
  const turns = Array.isArray(thread.turns)
    ? thread.turns
    : Array.isArray(root.turns)
      ? root.turns
      : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index] as JsonRecord;
    if (!isRunningTurnStatus(turn.status)) continue;
    const id = firstString(turn.id, turn.turnId);
    if (id) return id;
  }
  return '';
}

function extractThreadNameFromThreadRead(response: unknown): string {
  const root = typeof response === 'object' && response ? response as JsonRecord : {};
  const thread = typeof root.thread === 'object' && root.thread ? root.thread as JsonRecord : root;
  return firstString(thread.name, root.name);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractFileChangeEntries(value: unknown): ActivityFileChangeEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const record = entry as JsonRecord;
      const path = firstString(record.path, record.filePath, record.file);
      if (!path) return null;
      return {
        kind: firstString(record.kind, record.type) || 'update',
        path,
      };
    })
    .filter((entry): entry is ActivityFileChangeEntry => !!entry);
}

function summarizeToolCall(name: string, input: unknown): string {
  const normalized = name.toLowerCase();
  const record = typeof input === 'object' && input ? input as JsonRecord : {};
  const target = firstString(
    record.url,
    record.uri,
    record.path,
    record.file,
    record.query,
    record.pattern,
    record.command,
  );

  if (normalized.includes('search')) {
    return target ? `正在搜索 ${target}…` : '正在搜索资料…';
  }
  if (normalized.includes('read') || normalized.includes('cat')) {
    return target ? `正在读取 ${target}…` : '正在读取文件…';
  }
  if (normalized.includes('list')) {
    return target ? `正在列出 ${target}…` : '正在查看目录结构…';
  }
  if (normalized.includes('bash')) {
    return target ? `正在执行命令 ${target}…` : '正在执行命令…';
  }
  return target ? `正在调用 ${name} (${target})…` : `正在调用 ${name}…`;
}

function truncatePreview(text: string, maxChars = 220): string {
  const normalized = normalizeLine(text);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function stringifyPreview(value: unknown): string {
  if (typeof value === 'string') return truncatePreview(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return truncatePreview(String(value));
  }
  if (Array.isArray(value)) {
    return truncatePreview(value.map((entry) => stringifyPreview(entry)).filter(Boolean).join(' '));
  }
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    const text = firstString(record.text, record.content, record.message, record.summary, record.detail);
    if (text) return truncatePreview(text);
    try {
      return truncatePreview(JSON.stringify(value));
    } catch {
      return '';
    }
  }
  return '';
}

function formatToolActivityName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) return '工具';
  if (trimmed.startsWith('MCP:')) return trimmed;
  if (trimmed.includes('/')) {
    const [server, ...rest] = trimmed.split('/');
    if (server && rest.length > 0) {
      return `MCP: ${server} ${rest.join('/')}`.trim();
    }
  }
  return trimmed;
}

function buildToolActivity(
  toolUseId: string,
  status: 'running' | 'completed' | 'failed',
  toolName: string,
  options?: {
    inputPreview?: string;
    resultPreview?: string;
    turnId?: string;
    source?: string;
  },
): ActivityEvent {
  return {
    kind: 'tool_activity',
    turnId: options?.turnId,
    toolUseId,
    toolName: formatToolActivityName(toolName),
    status,
    ...(options?.inputPreview ? { inputPreview: options.inputPreview } : {}),
    ...(options?.resultPreview ? { resultPreview: options.resultPreview } : {}),
    ...(options?.source ? { source: options.source } : {}),
  };
}

function buildLightweightActivity(
  scopeId: string,
  status: 'running' | 'completed' | 'failed',
  text: string,
  turnId?: string,
  source?: string,
): ActivityEvent | null {
  const normalized = normalizeLine(text);
  if (!normalized) return null;
  return {
    kind: 'lightweight_activity',
    id: `lightweight:${scopeId}`,
    turnId,
    status,
    text: normalized,
    source,
  };
}

function buildLegacyActivityEvent(
  method: string,
  params: JsonRecord,
  threadId: string,
  turnId: string,
): ActivityEvent | null {
  const scopeId = turnId || threadId || method;
  switch (method) {
    case 'codex/event/background_event': {
      const text = firstString(params.message, params.title, params.detail, params.event);
      return buildLightweightActivity(
        scopeId,
        'running',
        text || '正在自动压缩背景信息…',
        turnId || undefined,
        'background',
      );
    }
    case 'codex/event/read': {
      const target = firstString(params.path, params.file, params.target);
      return buildLightweightActivity(
        scopeId,
        'completed',
        target ? `已读取 ${target}` : '已读取文件',
        turnId || undefined,
        'read',
      );
    }
    case 'codex/event/search': {
      const target = firstString(params.query, params.pattern, params.url);
      return buildLightweightActivity(
        scopeId,
        'completed',
        target ? `已搜索 ${target}` : '已完成搜索',
        turnId || undefined,
        'search',
      );
    }
    case 'codex/event/list_files': {
      const target = firstString(params.path, params.target);
      return buildLightweightActivity(
        scopeId,
        'completed',
        target ? `已查看 ${target} 的文件列表` : '已查看文件列表',
        turnId || undefined,
        'list_files',
      );
    }
    case 'codex/event/exec_command_begin': {
      const command = firstString(params.command, params.cmd);
      return {
        kind: 'command_execution',
        id: firstString(params.itemId, params.commandId) || `command:${scopeId}`,
        turnId: turnId || undefined,
        status: 'running',
        command,
        cwd: firstString(params.cwd),
      };
    }
    case 'codex/event/exec_command_output_delta': {
      const command = firstString(params.command, params.cmd);
      return {
        kind: 'command_execution',
        id: firstString(params.itemId, params.commandId) || `command:${scopeId}`,
        turnId: turnId || undefined,
        status: 'running',
        command,
        cwd: firstString(params.cwd),
        output: firstString(params.delta, params.output),
      };
    }
    case 'codex/event/exec_command_end': {
      const command = firstString(params.command, params.cmd);
      const exitCode = typeof params.exitCode === 'number'
        ? params.exitCode
        : typeof params.exit_code === 'number'
          ? params.exit_code
          : null;
      return {
        kind: 'command_execution',
        id: firstString(params.itemId, params.commandId) || `command:${scopeId}`,
        turnId: turnId || undefined,
        status: exitCode === 0 || exitCode === null ? 'completed' : 'failed',
        command,
        cwd: firstString(params.cwd),
        output: firstString(params.output),
        exitCode,
      };
    }
    default:
      return null;
  }
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

  async readSessionTitle(threadId: string): Promise<string | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) return null;
    const client = await this.ensureClient();
    const response = await client.call('thread/read', { threadId: normalizedThreadId });
    const name = extractThreadNameFromThreadRead(response);
    return name || null;
  }

  async writeSessionTitle(threadId: string, title: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const normalizedTitle = normalizeLine(title);
    if (!normalizedThreadId || !normalizedTitle) return;
    const client = await this.ensureClient();
    await client.call('thread/name/set', {
      threadId: normalizedThreadId,
      name: normalizedTitle,
    });
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
    let abortListener: (() => void) | null = null;

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

      emitCanonicalTurnEvent(controller, {
        type: 'status',
        data: {
          session_id: threadId,
          ...(bootstrap.model ? { model: bootstrap.model } : {}),
        },
      });

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
      if (params.collaborationMode === 'plan' && !client.supportsCollaborationMode('plan')) {
        throw new Error('Local Codex does not support native plan mode');
      }
      if (params.collaborationMode) {
        turnParams.collaborationMode = buildCollaborationMode(
          params.collaborationMode,
          params.model || bootstrap.model || 'gpt-5.4',
        );
      }

      let turnStart;
      try {
        turnStart = await client.call<{ turn?: { id?: string } }>('turn/start', turnParams);
      } catch (error) {
        const canRetryWithoutMode = params.collaborationMode === 'default' && 'collaborationMode' in turnParams;
        if (!canRetryWithoutMode) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[codex-provider] collaborationMode=default rejected, retrying without explicit mode:', message);
        delete turnParams.collaborationMode;
        turnStart = await client.call<{ turn?: { id?: string } }>('turn/start', turnParams);
      }
      let activeTurnId = typeof turnStart?.turn?.id === 'string' ? turnStart.turn.id : '';
      let turnInterrupted = false;

      const interruptActiveTurn = async (): Promise<void> => {
        if (turnInterrupted || !threadId) return;
        let turnIdToInterrupt = activeTurnId;
        if (!turnIdToInterrupt) {
          try {
            const threadState = await client.call('thread/read', { threadId });
            turnIdToInterrupt = extractInFlightTurnIdFromThreadRead(threadState);
          } catch (error) {
            console.warn('[codex-provider] Failed to resolve in-flight turn before interrupt:', error);
          }
        }
        if (!turnIdToInterrupt) {
          turnInterrupted = true;
          return;
        }
        turnInterrupted = true;
        try {
          await client.call('turn/interrupt', {
            threadId,
            turnId: turnIdToInterrupt,
          });
        } catch (error) {
          console.warn('[codex-provider] Failed to interrupt active turn:', error);
        }
      };

      abortListener = (): void => {
        if (wakeQueue) {
          wakeQueue();
          wakeQueue = null;
        }
        void interruptActiveTurn();
      };
      params.abortController?.signal.addEventListener('abort', abortListener, { once: true });

      while (true) {
        if (params.abortController?.signal.aborted) {
          await interruptActiveTurn();
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
            if (tokenUsage) {
              emitCanonicalTurnEvent(controller, {
                type: 'activity_event',
                data: {
                  kind: 'context_usage',
                  id: `context:${activeTurnId || threadId}`,
                  turnId: activeTurnId || undefined,
                  inputTokens: tokenUsage.input_tokens,
                  outputTokens: tokenUsage.output_tokens,
                  cacheReadInputTokens: tokenUsage.cache_read_input_tokens,
                } satisfies ActivityEvent,
              });
            }
            break;
          case 'turn/started':
            activeTurnId = typeof (paramsRecord.turn as JsonRecord | undefined)?.id === 'string'
              ? String((paramsRecord.turn as JsonRecord).id)
              : activeTurnId;
            break;
          case 'item/started':
            this.handleStartedItem(controller, paramsRecord.item as JsonRecord | undefined, activeTurnId || extractTurnId(message));
            break;
          case 'item/agentMessage/delta':
            if (typeof paramsRecord.delta === 'string') {
              emitCanonicalTurnEvent(controller, { type: 'text', data: paramsRecord.delta });
            }
            break;
          case 'item/reasoning/textDelta':
          case 'item/reasoning/summaryTextDelta':
            if (typeof paramsRecord.delta === 'string') {
              emitCanonicalTurnEvent(controller, { type: 'status', data: { reasoning: paramsRecord.delta } });
            }
            break;
          case 'item/commandExecution/outputDelta':
          case 'item/command_execution/outputDelta':
            this.handleCommandExecutionDelta(controller, paramsRecord, activeTurnId || extractTurnId(message));
            break;
          case 'item/fileChange/outputDelta':
            this.handleFileChangeDelta(controller, paramsRecord, activeTurnId || extractTurnId(message));
            break;
          case 'item/toolCall/outputDelta':
          case 'item/toolCall/output_delta':
          case 'item/tool_call/outputDelta':
          case 'item/tool_call/output_delta':
            this.handleToolCallDelta(controller, paramsRecord, activeTurnId || extractTurnId(message));
            break;
          case 'turn/plan/updated':
            emitCanonicalTurnEvent(controller, { type: 'plan_state', data: paramsRecord });
            break;
          case 'item/plan/delta':
            if (typeof paramsRecord.delta === 'string') {
              emitCanonicalTurnEvent(controller, { type: 'plan_delta', data: paramsRecord.delta });
            }
            break;
          case 'item/completed':
            if (activeTurnId && extractTurnId(message) && extractTurnId(message) !== activeTurnId) {
              break;
            }
            this.handleCompletedItem(
              controller,
              paramsRecord.item as JsonRecord,
              activeTurnId || extractTurnId(message),
            );
            break;
          case 'serverRequest/resolved':
            emitCanonicalTurnEvent(controller, { type: 'server_request_resolved', data: paramsRecord });
            break;
          case 'codex/event/exec_command_begin':
          case 'codex/event/exec_command_output_delta':
          case 'codex/event/exec_command_end':
          case 'codex/event/background_event':
          case 'codex/event/read':
          case 'codex/event/search':
          case 'codex/event/list_files': {
            const legacyEvent = buildLegacyActivityEvent(
              message.method,
              paramsRecord,
              threadId,
              activeTurnId || extractTurnId(message),
            );
            if (legacyEvent) {
              emitCanonicalTurnEvent(controller, { type: 'activity_event', data: legacyEvent });
            }
            break;
          }
          case 'error':
            emitCanonicalTurnEvent(controller, {
              type: 'error',
              data: String((paramsRecord.error as JsonRecord | undefined)?.message || 'Turn failed'),
            });
            break;
          case 'turn/completed':
            emitCanonicalTurnEvent(controller, {
              type: 'result',
              data: {
                ...(tokenUsage ? { usage: tokenUsage } : {}),
                session_id: threadId,
                is_error: !!(paramsRecord.turn as JsonRecord | undefined)?.error,
              },
            });
            controller.close();
            return;
        }
      }

      controller.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[codex-provider] Error:', error instanceof Error ? error.stack || error.message : error);
      try {
        emitCanonicalTurnEvent(controller, { type: 'error', data: message });
        controller.close();
      } catch {
        // no-op
      }
    } finally {
      if (abortListener) {
        params.abortController?.signal.removeEventListener('abort', abortListener);
      }
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
      emitCanonicalTurnEvent(controller, { type: 'structured_input_request', data: request });
      const response = await this.pendingStructuredInputs.waitFor(request.requestId);
      await client.respond(message.id, response);
      return;
    }

    if (isApprovalRequestMethod(message.method)) {
      const requestId = String(message.id);
      const { toolName, toolInput } = approvalToolPayload(message.method, params);
      emitCanonicalTurnEvent(controller, {
        type: 'approval_request',
        data: {
          permissionRequestId: requestId,
          toolName,
          toolInput,
          suggestions: [],
          method: message.method,
          threadId: typeof params.threadId === 'string' ? params.threadId : '',
          turnId: typeof params.turnId === 'string' ? params.turnId : '',
        },
      });
      const resolution = await this.pendingApprovals.waitFor(requestId);
      await client.respond(message.id, approvalResponseFor(message.method, params, resolution));
      return;
    }

    console.warn('[codex-provider] Unsupported server request:', message.method);
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
    fallbackTurnId?: string,
  ): void {
    if (!item) return;
    const itemType = normalizeItemType(item.type);
    const resolvedTurnId = typeof item.turnId === 'string'
      ? item.turnId
      : fallbackTurnId || undefined;

    switch (itemType) {
      case 'agentMessage': {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) {
          emitCanonicalTurnEvent(controller, { type: 'text_segment', data: text });
        }
        break;
      }
      case 'plan': {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) {
          emitCanonicalTurnEvent(controller, { type: 'plan_result', data: text });
        }
        break;
      }
      case 'commandExecution': {
        const toolId = typeof item.id === 'string' ? item.id : `command:${resolvedTurnId || Date.now()}`;
        const command = typeof item.command === 'string' ? item.command : '';
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
        const isError = exitCode !== null && exitCode !== 0;
        emitCanonicalTurnEvent(controller, {
          type: 'activity_event',
          data: {
            kind: 'command_execution',
            id: toolId,
            turnId: resolvedTurnId,
            status: isError ? 'failed' : 'completed',
            command,
            cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
            output,
            exitCode,
            durationMs: typeof item.durationMs === 'number' ? item.durationMs : null,
          } satisfies ActivityEvent,
        });
        emitCanonicalTurnEvent(controller, {
          type: 'tool_use',
          data: {
            id: toolId,
            name: 'Bash',
            input: { command, cwd: item.cwd },
          },
        });
        emitCanonicalTurnEvent(controller, {
          type: 'tool_result',
          data: {
            tool_use_id: toolId,
            content: output || (isError ? `Exit code: ${exitCode}` : 'Done'),
            is_error: isError,
          },
        });
        break;
      }
      case 'fileChange': {
        const toolId = typeof item.id === 'string' ? item.id : `file-change:${resolvedTurnId || Date.now()}`;
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const entries = extractFileChangeEntries(changes);
        const summary = changes
          .map((change) => {
            const record = change as JsonRecord;
            return `${String(record.kind || 'update')}: ${String(record.path || '')}`;
          })
          .join('\n');
        emitCanonicalTurnEvent(controller, {
          type: 'activity_event',
          data: {
            kind: 'file_change',
            id: toolId,
            turnId: resolvedTurnId,
            status: 'completed',
            summary: summary || '已完成文件修改',
            changes: entries,
          } satisfies ActivityEvent,
        });
        emitCanonicalTurnEvent(controller, {
          type: 'tool_use',
          data: {
            id: toolId,
            name: 'Edit',
            input: { files: changes },
          },
        });
        emitCanonicalTurnEvent(controller, {
          type: 'tool_result',
          data: {
            tool_use_id: toolId,
            content: summary || 'File changes applied',
            is_error: false,
          },
        });
        break;
      }
      case 'mcpToolCall': {
        const toolId = typeof item.id === 'string' ? item.id : `tool:${resolvedTurnId || Date.now()}`;
        const server = typeof item.server === 'string' ? item.server : '';
        const tool = typeof item.tool === 'string' ? item.tool : '';
        const toolName = `${server}/${tool}`.replace(/^\/+/, '');
        const result = item.result as JsonRecord | null | undefined;
        const error = item.error as JsonRecord | null | undefined;
        const content = result?.content ?? result?.structuredContent ?? result?.structured_content;
        const activity = buildToolActivity(
          toolId,
          error ? 'failed' : 'completed',
          toolName,
          {
            turnId: resolvedTurnId,
            source: 'tool_call',
            inputPreview: stringifyPreview(item.arguments),
            resultPreview: stringifyPreview(error?.message || content),
          },
        );
        emitCanonicalTurnEvent(controller, { type: 'activity_event', data: activity });
        emitCanonicalTurnEvent(controller, {
          type: 'tool_use',
          data: {
            id: toolId,
            name: `mcp__${server}__${tool}`,
            input: item.arguments,
          },
        });
        emitCanonicalTurnEvent(controller, {
          type: 'tool_result',
          data: {
            tool_use_id: toolId,
            content: typeof content === 'string' ? content : content ? JSON.stringify(content) : String(error?.message || 'Done'),
            is_error: !!error,
          },
        });
        break;
      }
      case 'reasoning': {
        const parts = Array.isArray(item.content) ? item.content.filter((part): part is string => typeof part === 'string') : [];
        const text = parts.join('\n').trim();
        if (text) {
          emitCanonicalTurnEvent(controller, { type: 'status', data: { reasoning: text, turn_id: resolvedTurnId } });
        }
        break;
      }
    }
  }

  private handleStartedItem(
    controller: ReadableStreamDefaultController<string>,
    item: JsonRecord | undefined,
    turnId: string,
  ): void {
    if (!item) return;
    const itemType = normalizeItemType(item.type);
    if (itemType === 'commandExecution') {
      emitCanonicalTurnEvent(controller, {
        type: 'activity_event',
        data: {
          kind: 'command_execution',
          id: typeof item.id === 'string' ? item.id : `command:${turnId || Date.now()}`,
          turnId: turnId || undefined,
          status: 'running',
          command: typeof item.command === 'string' ? item.command : '',
          cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
        } satisfies ActivityEvent,
      });
      return;
    }
    if (itemType === 'fileChange') {
      emitCanonicalTurnEvent(controller, {
        type: 'activity_event',
        data: {
          kind: 'file_change',
          id: typeof item.id === 'string' ? item.id : `file-change:${turnId || Date.now()}`,
          turnId: turnId || undefined,
          status: 'running',
          summary: '正在修改文件…',
          changes: extractFileChangeEntries(item.changes),
        } satisfies ActivityEvent,
      });
      return;
    }
    if (itemType === 'mcpToolCall') {
      const toolId = firstString(item.id) || `tool:${turnId || Date.now()}`;
      emitCanonicalTurnEvent(controller, {
        type: 'activity_event',
        data: buildToolActivity(
          toolId,
          'running',
          `${firstString(item.server)}/${firstString(item.tool)}`.replace(/^\/+/, ''),
          {
            turnId: turnId || undefined,
            source: 'tool_call',
            inputPreview: stringifyPreview(item.arguments),
          },
        ),
      });
    }
  }

  private handleCommandExecutionDelta(
    controller: ReadableStreamDefaultController<string>,
    params: JsonRecord,
    turnId: string,
  ): void {
    emitCanonicalTurnEvent(controller, {
      type: 'activity_event',
      data: {
        kind: 'command_execution',
        id: firstString(params.itemId, params.id) || `command:${turnId || Date.now()}`,
        turnId: turnId || undefined,
        status: 'running',
        command: firstString(params.command, params.cmd),
        cwd: firstString(params.cwd) || undefined,
        output: firstString(params.delta, params.output) || undefined,
      } satisfies ActivityEvent,
    });
  }

  private handleFileChangeDelta(
    controller: ReadableStreamDefaultController<string>,
    params: JsonRecord,
    turnId: string,
  ): void {
    const changes = extractFileChangeEntries(params.changes);
    const summary = firstString(params.delta, params.summary) || '正在修改文件…';
    emitCanonicalTurnEvent(controller, {
      type: 'activity_event',
      data: {
        kind: 'file_change',
        id: firstString(params.itemId, params.id) || `file-change:${turnId || Date.now()}`,
        turnId: turnId || undefined,
        status: 'running',
        summary,
        changes,
      } satisfies ActivityEvent,
    });
  }

  private handleToolCallDelta(
    controller: ReadableStreamDefaultController<string>,
    params: JsonRecord,
    turnId: string,
  ): void {
    const toolUseId = firstString(params.itemId, params.id) || `tool:${turnId || Date.now()}`;
    const explicitToolName = firstString(params.toolName);
    const rawToolName = explicitToolName || `${firstString(params.server)}/${firstString(params.tool, params.name)}`.replace(/^\/+/, '');
    emitCanonicalTurnEvent(controller, {
      type: 'activity_event',
      data: buildToolActivity(
        toolUseId,
        'running',
        rawToolName || '工具',
        {
          turnId: turnId || undefined,
          source: 'tool_call',
          inputPreview: stringifyPreview(params.input || params.arguments),
          resultPreview: stringifyPreview(params.delta || params.output),
        },
      ),
    });
  }
}
