import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type CodexServerMessage =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CollaborationModeEntry {
  mode?: string;
  kind?: string;
  id?: string;
}

function extractCollaborationModes(result: unknown): CollaborationModeEntry[] {
  if (Array.isArray(result)) {
    return result as CollaborationModeEntry[];
  }
  if (typeof result !== 'object' || !result) {
    return [];
  }
  const record = result as {
    data?: CollaborationModeEntry[];
    modes?: CollaborationModeEntry[];
    items?: CollaborationModeEntry[];
  };
  if (Array.isArray(record.data)) {
    return record.data;
  }
  if (Array.isArray(record.modes)) {
    return record.modes;
  }
  if (Array.isArray(record.items)) {
    return record.items;
  }
  return [];
}

interface InitializeParams {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

const CLIENT_INFO = {
  name: 'agents-to-im',
  title: 'Agents to IM',
  version: '0.1.0',
} as const;

export function buildInitializeParams(): InitializeParams {
  return {
    clientInfo: CLIENT_INFO,
    capabilities: {
      experimentalApi: true,
    },
  };
}

export function buildInitializedNotification(): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method: 'initialized',
  };
}

export { extractCollaborationModes };

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function jsonRpcError(method: string, error: JsonRpcFailure['error']): Error {
  const detail = typeof error.data === 'string' ? ` (${error.data})` : '';
  return new Error(`[codex-app-server] ${method} failed: ${error.message}${detail}`);
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingCall>();
  private listeners = new Set<(message: CodexServerMessage) => void>();
  private startPromise: Promise<void> | null = null;
  private capabilities = {
    collaborationModes: new Set<string>(),
  };

  constructor(private readonly executable = 'codex') {}

  subscribe(listener: (message: CodexServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prepare(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.bootstrap();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  supportsCollaborationMode(mode: string): boolean {
    return this.capabilities.collaborationModes.has(mode);
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    await this.prepare();
    return this.callInternal<T>(method, params);
  }

  private async callInternal<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const proc = this.proc;
    if (!proc) {
      throw new Error('[codex-app-server] Process not running');
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.writePayload(payload);
    return promise;
  }

  private writePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.proc) {
      throw new Error('[codex-app-server] Process not running');
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({ jsonrpc: '2.0', id, result });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.startPromise = null;
    proc.kill();
  }

  private async bootstrap(): Promise<void> {
    const proc = spawn(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: os.homedir(),
        CODEX_HOME: resolveCodexHome(),
      },
    });
    this.proc = proc;

    proc.once('error', (error) => {
      this.failAllPending(error instanceof Error ? error : new Error(String(error)));
    });
    proc.once('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.failAllPending(new Error(`[codex-app-server] Process exited with ${suffix}`));
      this.proc = null;
      this.startPromise = null;
    });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      this.handleLine(line);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.warn(`[codex-app-server][stderr] ${text}`);
      }
    });

    await this.callInternal('initialize', buildInitializeParams());
    this.writePayload(buildInitializedNotification());

    let modes: CollaborationModeEntry[] = [];
    try {
      const result = await this.callInternal<unknown>('collaborationMode/list', {});
      modes = extractCollaborationModes(result);
    } catch (error) {
      console.warn('[codex-app-server] Failed to list collaboration modes:', error);
    }

    this.capabilities.collaborationModes.clear();
    for (const entry of modes) {
      const mode = entry.mode || entry.kind || entry.id;
      if (typeof mode === 'string' && mode) {
        this.capabilities.collaborationModes.add(mode);
      }
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    } catch (error) {
      console.warn('[codex-app-server] Ignoring invalid JSON-RPC frame:', error);
      return;
    }

    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ('error' in message) {
        pending.reject(jsonRpcError('response', message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') {
      return;
    }

    const envelope: CodexServerMessage = 'id' in message
      ? {
        kind: 'request',
        id: message.id,
        method: message.method,
        params: message.params,
      }
      : {
        kind: 'notification',
        method: message.method,
        params: message.params,
      };

    for (const listener of this.listeners) {
      listener(envelope);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
