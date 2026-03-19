import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PendingApprovals, PendingStructuredInputs } from '../permission-gateway.js';
import { sseEvent } from '../sse-utils.js';

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeCodexClient {
  public calls: Array<{ method: string; params: unknown }> = [];
  public responses: Array<{ id: string | number; result: unknown }> = [];
  public responseErrors: Array<{ id: string | number; code: number; message: string }> = [];
  private listener: ((message: any) => void) | null = null;

  constructor(
    private readonly handlers: Record<string, (params: any) => unknown | Promise<unknown>>,
    private readonly planSupported = true,
  ) {}

  async prepare(): Promise<void> {
    // no-op
  }

  supportsCollaborationMode(mode: string): boolean {
    return this.planSupported && mode === 'plan';
  }

  subscribe(listener: (message: any) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(message: any): void {
    this.listener?.(message);
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) {
      throw new Error(`Unhandled method: ${method}`);
    }
    return await handler(params) as T;
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }

  async respondError(id: string | number, code: number, message: string): Promise<void> {
    this.responseErrors.push({ id, code, message });
  }
}

describe('sseEvent', () => {
  it('formats a string data payload', () => {
    const result = sseEvent('text', 'hello');
    assert.equal(result, 'data: {"type":"text","data":"hello"}\n');
  });

  it('stringifies object data payload', () => {
    const result = sseEvent('result', { usage: { input_tokens: 10 } });
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.type, 'result');
    const inner = JSON.parse(parsed.data);
    assert.equal(inner.usage.input_tokens, 10);
  });
});

describe('CodexProvider', () => {
  it('emits native plan events and forwards collaborationMode=plan', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-1' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/plan/updated',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              explanation: '先做实现计划',
              plan: [{ title: '分析代码', status: 'in_progress' }],
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/plan/delta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'plan-1',
              delta: '1. 先分析现有实现',
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { type: 'plan', id: 'plan-1', text: '1. 先分析现有实现\n2. 再修改逻辑' },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', error: null },
            },
          });
        });
        return { turn: { id: 'turn-1' } };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const chunks = await collectStream(provider.streamChat({
      prompt: '请先规划',
      sessionId: 'session-1',
      collaborationMode: 'plan',
      model: 'gpt-5.4',
    }));

    const events = parseSSEChunks(chunks);
    assert.ok(events.some((event) => event.type === 'plan_state'));
    assert.ok(events.some((event) => event.type === 'plan_delta'));
    assert.ok(events.some((event) => event.type === 'plan_result'));

    const turnStart = fake.calls.find((call) => call.method === 'turn/start');
    assert.equal((turnStart?.params as any).collaborationMode.mode, 'plan');
    assert.equal((turnStart?.params as any).collaborationMode.settings.model, 'gpt-5.4');
  });

  it('emits completed agent messages as text_segment instead of duplicating text deltas', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-segment' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-segment',
              turnId: 'turn-segment',
              itemId: 'agent-1',
              delta: '我会先查看项目约束。',
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/completed',
            params: {
              threadId: 'thread-segment',
              turnId: 'turn-segment',
              item: { type: 'agentMessage', id: 'agent-1', text: '我会先查看项目约束。' },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-segment',
              turn: { id: 'turn-segment', error: null },
            },
          });
        });
        return { turn: { id: 'turn-segment' } };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const chunks = await collectStream(provider.streamChat({
      prompt: '规划一下',
      sessionId: 'session-segment',
    }));

    const events = parseSSEChunks(chunks);
    assert.equal(events.filter((event) => event.type === 'text').length, 1);
    assert.equal(events.filter((event) => event.type === 'text_segment').length, 1);
    assert.equal(events.find((event) => event.type === 'text')?.data, '我会先查看项目约束。');
    assert.equal(events.find((event) => event.type === 'text_segment')?.data, '我会先查看项目约束。');
  });

  it('bridges structured user input requests back into app-server responses', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const pendingInputs = new PendingStructuredInputs();
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-2' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'request',
            id: 'req-input-1',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread-2',
              turnId: 'turn-2',
              itemId: 'item-2',
              questions: [
                {
                  id: 'q1',
                  header: '输出文件',
                  question: '你想把文件命名为什么？',
                  isOther: false,
                  isSecret: false,
                  options: null,
                },
              ],
            },
          });
        });
        return { turn: { id: 'turn-2' } };
      },
    });
    const provider = new CodexProvider(new PendingApprovals(), pendingInputs);
    (provider as any).client = fake;

    const streamPromise = collectStream(provider.streamChat({
      prompt: '继续',
      sessionId: 'session-2',
    }));

    await waitFor(() => fake.calls.some((call) => call.method === 'turn/start'));
    pendingInputs.resolve('req-input-1', {
      answers: {
        q1: { answers: ['index.html'] },
      },
    });
    await waitFor(() => fake.responses.length === 1);
    fake.emit({
      kind: 'notification',
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-2', requestId: 'req-input-1' },
    });
    fake.emit({
      kind: 'notification',
      method: 'turn/completed',
      params: {
        threadId: 'thread-2',
        turn: { id: 'turn-2', error: null },
      },
    });

    const chunks = await streamPromise;
    const events = parseSSEChunks(chunks);
    assert.ok(events.some((event) => event.type === 'structured_input_request'));
    assert.ok(events.some((event) => event.type === 'server_request_resolved'));
    assert.deepEqual(fake.responses[0], {
      id: 'req-input-1',
      result: {
        answers: {
          q1: { answers: ['index.html'] },
        },
      },
    });
  });

  it('bridges approval requests and maps allow_session to acceptForSession', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const pendingApprovals = new PendingApprovals();
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-3' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'request',
            id: 'req-approval-1',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'thread-3',
              turnId: 'turn-3',
              itemId: 'cmd-1',
              command: 'npm test',
              cwd: '/tmp/demo',
            },
          });
        });
        return { turn: { id: 'turn-3' } };
      },
    });
    const provider = new CodexProvider(pendingApprovals, new PendingStructuredInputs());
    (provider as any).client = fake;

    const streamPromise = collectStream(provider.streamChat({
      prompt: '执行测试',
      sessionId: 'session-3',
    }));

    await waitFor(() => fake.calls.some((call) => call.method === 'turn/start'));
    pendingApprovals.resolve('req-approval-1', {
      behavior: 'allow',
      scope: 'session',
    });
    await waitFor(() => fake.responses.length === 1);
    fake.emit({
      kind: 'notification',
      method: 'turn/completed',
      params: {
        threadId: 'thread-3',
        turn: { id: 'turn-3', error: null },
      },
    });

    const chunks = await streamPromise;
    const events = parseSSEChunks(chunks);
    assert.ok(events.some((event) => event.type === 'approval_request'));
    assert.deepEqual(fake.responses[0], {
      id: 'req-approval-1',
      result: {
        decision: 'acceptForSession',
      },
    });
  });

  it('retries with a fresh thread when thread/resume fails before any turn starts', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    let resumeCalls = 0;
    let startCalls = 0;
    const fake = new FakeCodexClient({
      'thread/resume': async () => {
        resumeCalls += 1;
        throw new Error('resuming session with different model');
      },
      'thread/start': async () => {
        startCalls += 1;
        return { thread: { id: 'thread-fresh' }, model: 'gpt-5.4' };
      },
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-fresh',
              turn: { id: 'turn-fresh', error: null },
            },
          });
        });
        return { turn: { id: 'turn-fresh' } };
      },
    });
    const provider = new CodexProvider();
    (provider as any).client = fake;

    await collectStream(provider.streamChat({
      prompt: '继续',
      sessionId: 'session-4',
      sdkSessionId: 'old-thread',
    }));

    assert.equal(resumeCalls, 1);
    assert.equal(startCalls, 1);
  });

  it('builds localImage inputs for image attachments', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-5' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-5',
              turn: { id: 'turn-5', error: null },
            },
          });
        });
        return { turn: { id: 'turn-5' } };
      },
    });
    const provider = new CodexProvider();
    (provider as any).client = fake;

    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    await collectStream(provider.streamChat({
      prompt: '看图说话',
      sessionId: 'session-5',
      files: [
        {
          id: 'img-1',
          name: 'pixel.png',
          type: 'image/png',
          size: pngBase64.length,
          data: pngBase64,
        },
      ],
    }));

    const turnStart = fake.calls.find((call) => call.method === 'turn/start');
    assert.ok(Array.isArray((turnStart?.params as any).input));
    assert.equal((turnStart?.params as any).input[0].type, 'text');
    assert.equal((turnStart?.params as any).input[1].type, 'localImage');
  });
});

describe('Codex config helpers', () => {
  it('parses trusted project roots from ~/.codex/config.toml content', async () => {
    const { parseTrustedProjectsFromCodexConfig, isTrustedCodexWorkingDirectory } = await import('../codex-provider.js');
    const trusted = parseTrustedProjectsFromCodexConfig(`
model = "gpt-5.4"

[projects."/Users/shesong/codes"]
trust_level = "trusted"

[projects."/tmp/demo"]
trust_level = "untrusted"

[projects."/"]
trust_level = "trusted"
`);

    assert.deepEqual(trusted, ['/Users/shesong/codes', '/']);
    assert.equal(isTrustedCodexWorkingDirectory('/Users/shesong/codes/agents-to-im', trusted), true);
    assert.equal(isTrustedCodexWorkingDirectory('/private/tmp/demo', trusted), true);
  });
});
