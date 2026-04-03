import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PendingApprovals, PendingStructuredInputs } from '../providers/claude/permission-gateway.js';
import { sseEvent } from '../infra/sse-utils.js';

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
  public notifications: Array<{ method: string; params: unknown }> = [];
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

  async notify(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params });
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
  it('reads and writes native thread titles via thread/read and thread/name/set', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/read': async (params) => {
        assert.deepEqual(params, { threadId: 'thread-title-1' });
        return { thread: { id: 'thread-title-1', name: 'Native Thread Title' } };
      },
      'thread/name/set': async (params) => {
        assert.deepEqual(params, { threadId: 'thread-title-1', name: '人工改名' });
        return { ok: true };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    assert.equal(await provider.readSessionTitle('thread-title-1'), 'Native Thread Title');
    await provider.writeSessionTitle('thread-title-1', '人工改名');
  });

  it('emits native plan events and forwards collaborationMode=plan', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
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

  it('forwards collaborationMode=default when explicitly exiting plan mode', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-default' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-default',
              turn: { id: 'turn-default', error: null },
            },
          });
        });
        return { turn: { id: 'turn-default' } };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    await collectStream(provider.streamChat({
      prompt: '按确认后的方案开始实施',
      sessionId: 'session-default',
      collaborationMode: 'default',
      model: 'gpt-5.4',
    }));

    const turnStart = fake.calls.find((call) => call.method === 'turn/start');
    assert.equal((turnStart?.params as any).collaborationMode.mode, 'default');
    assert.equal((turnStart?.params as any).collaborationMode.settings.model, 'gpt-5.4');
  });

  it('retries without collaborationMode when explicit default is rejected', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    let turnStartCalls = 0;
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-default-retry' }, model: 'gpt-5.4' }),
      'turn/start': async (params) => {
        turnStartCalls += 1;
        if (turnStartCalls === 1) {
          assert.equal((params as any).collaborationMode.mode, 'default');
          throw new Error('Cannot switch collaboration mode while a turn is running');
        }
        assert.equal((params as any).collaborationMode, undefined);
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-default-retry',
              turn: { id: 'turn-default-retry', error: null },
            },
          });
        });
        return { turn: { id: 'turn-default-retry' } };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const chunks = await collectStream(provider.streamChat({
      prompt: '退出 plan 并继续实施',
      sessionId: 'session-default-retry',
      collaborationMode: 'default',
      model: 'gpt-5.4',
    }));

    const events = parseSSEChunks(chunks);
    assert.equal(turnStartCalls, 2);
    assert.ok(events.some((event) => event.type === 'result'));
    assert.ok(!events.some((event) => event.type === 'error'));
  });

  it('emits completed agent messages as text_segment instead of duplicating text deltas', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
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

  it('maps command/file/context and legacy runtime notifications into activity_event SSE payloads', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-activity-map' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/started',
            params: {
              threadId: 'thread-activity-map',
              turn: { id: 'turn-activity-map' },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: 'thread-activity-map',
              tokenUsage: {
                last: {
                  inputTokens: 12,
                  outputTokens: 5,
                  cachedInputTokens: 2,
                },
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/started',
            params: {
              threadId: 'thread-activity-map',
              turnId: 'turn-activity-map',
              item: {
                type: 'commandExecution',
                id: 'cmd-1',
                command: 'pwd',
                cwd: '/tmp/test-cwd',
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'thread-activity-map',
              turnId: 'turn-activity-map',
              itemId: 'cmd-1',
              command: 'pwd',
              cwd: '/tmp/test-cwd',
              delta: '/tmp/test-cwd',
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/completed',
            params: {
              threadId: 'thread-activity-map',
              turnId: 'turn-activity-map',
              item: {
                type: 'commandExecution',
                id: 'cmd-1',
                turnId: 'turn-activity-map',
                command: 'pwd',
                cwd: '/tmp/test-cwd',
                aggregatedOutput: '/tmp/test-cwd',
                exitCode: 0,
                durationMs: 18,
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/fileChange/outputDelta',
            params: {
              threadId: 'thread-activity-map',
              turnId: 'turn-activity-map',
              itemId: 'file-1',
              summary: '正在修改 bridge-manager.ts',
              changes: [{ kind: 'update', path: 'src/bridge/bridge-manager.ts' }],
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/completed',
            params: {
              threadId: 'thread-activity-map',
              turnId: 'turn-activity-map',
              item: {
                type: 'fileChange',
                id: 'file-1',
                turnId: 'turn-activity-map',
                changes: [{ kind: 'update', path: 'src/bridge/bridge-manager.ts' }],
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'codex/event/search',
            params: {
              threadId: 'thread-activity-map',
              turnId: 'turn-activity-map',
              query: 'cardkit streaming updates',
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-activity-map',
              turn: { id: 'turn-activity-map', error: null },
            },
          });
        });
        return { turn: { id: 'turn-activity-map' } };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const chunks = await collectStream(provider.streamChat({
      prompt: '继续',
      sessionId: 'session-activity-map',
      model: 'gpt-5.4',
    }));

    const events = parseSSEChunks(chunks);
    const activities = events
      .filter((event) => event.type === 'activity_event')
      .map((event) => JSON.parse(event.data));

    assert.ok(activities.some((event) => event.kind === 'context_usage' && event.inputTokens === 12));
    assert.ok(activities.some((event) => event.kind === 'command_execution' && event.status === 'running' && event.command === 'pwd'));
    assert.ok(activities.some((event) => event.kind === 'command_execution' && event.status === 'completed' && event.exitCode === 0));
    assert.ok(activities.some((event) => event.kind === 'file_change' && event.status === 'running'));
    assert.ok(activities.some((event) => event.kind === 'file_change' && event.status === 'completed'));
    assert.ok(activities.some((event) => event.kind === 'lightweight_activity' && /已搜索/.test(event.text)));
  });

  it('interrupts the active turn when the bridge aborts a codex stream', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-stop' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/started',
            params: {
              threadId: 'thread-stop',
              turn: { id: 'turn-stop' },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-stop',
              turnId: 'turn-stop',
              itemId: 'agent-stop',
              delta: '正在处理...',
            },
          });
        });
        return { turn: { id: 'turn-stop' } };
      },
      'turn/interrupt': async (params) => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: (params as { threadId: string }).threadId,
              turn: { id: (params as { turnId: string }).turnId, error: null },
            },
          });
        });
        return {};
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const abortController = new AbortController();
    const stream = provider.streamChat({
      prompt: '继续执行',
      sessionId: 'session-stop',
      model: 'gpt-5.4',
      abortController,
    });

    await waitFor(() => fake.calls.some((call) => call.method === 'turn/start'));
    abortController.abort();

    await collectStream(stream);

    const interruptCall = fake.calls.find((call) => call.method === 'turn/interrupt');
    assert.deepEqual(interruptCall?.params, {
      threadId: 'thread-stop',
      turnId: 'turn-stop',
    });
  });

  it('falls back to thread/read to resolve an in-flight turn before interrupting', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-stop-fallback' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-stop-fallback',
              turnId: 'turn-stop-fallback',
              itemId: 'agent-stop-fallback',
              delta: '正在处理...',
            },
          });
        });
        return { turn: {} };
      },
      'thread/read': async () => ({
        thread: {
          turns: [
            { id: 'turn-stop-fallback', status: 'in_progress' },
          ],
        },
      }),
      'turn/interrupt': async (params) => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: (params as { threadId: string }).threadId,
              turn: { id: (params as { turnId: string }).turnId, error: null },
            },
          });
        });
        return {};
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const abortController = new AbortController();
    const stream = provider.streamChat({
      prompt: '继续执行',
      sessionId: 'session-stop-fallback',
      model: 'gpt-5.4',
      abortController,
    });

    await waitFor(() => fake.calls.some((call) => call.method === 'turn/start'));
    abortController.abort();

    await collectStream(stream);

    assert.equal(fake.calls.some((call) => call.method === 'thread/read'), true);
    const interruptCall = fake.calls.find((call) => call.method === 'turn/interrupt');
    assert.deepEqual(interruptCall?.params, {
      threadId: 'thread-stop-fallback',
      turnId: 'turn-stop-fallback',
    });
  });

  it('treats a missing in-flight turn during interrupt fallback as already stopped', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-stop-missing' }, model: 'gpt-5.4' }),
      'turn/start': async () => ({ turn: {} }),
      'thread/read': async () => ({
        thread: {
          turns: [
            { id: 'turn-old', status: 'completed' },
          ],
        },
      }),
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const abortController = new AbortController();
    const stream = provider.streamChat({
      prompt: '继续执行',
      sessionId: 'session-stop-missing',
      model: 'gpt-5.4',
      abortController,
    });

    await waitFor(() => fake.calls.some((call) => call.method === 'turn/start'));
    abortController.abort();

    await collectStream(stream);

    assert.equal(fake.calls.some((call) => call.method === 'thread/read'), true);
    assert.equal(fake.calls.some((call) => call.method === 'turn/interrupt'), false);
  });

  it('emits tool_activity events for MCP tool calls so channel adapters can render streaming cards', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-mcp-card' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/started',
            params: {
              threadId: 'thread-mcp-card',
              turn: { id: 'turn-mcp-card' },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/started',
            params: {
              threadId: 'thread-mcp-card',
              turnId: 'turn-mcp-card',
              item: {
                type: 'mcpToolCall',
                id: 'tool-mcp-1',
                server: 'chrome-devtools',
                tool: 'take_screenshot',
                arguments: {
                  path: '/tmp/demo.html',
                },
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/toolCall/outputDelta',
            params: {
              threadId: 'thread-mcp-card',
              turnId: 'turn-mcp-card',
              itemId: 'tool-mcp-1',
              toolName: 'MCP: chrome-devtools take_screenshot',
              delta: 'Captured viewport screenshot',
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/completed',
            params: {
              threadId: 'thread-mcp-card',
              turnId: 'turn-mcp-card',
              item: {
                type: 'mcpToolCall',
                id: 'tool-mcp-1',
                server: 'chrome-devtools',
                tool: 'take_screenshot',
                arguments: {
                  path: '/tmp/demo.html',
                },
                result: {
                  content: 'Took a screenshot of the current page',
                },
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-mcp-card',
              turn: { id: 'turn-mcp-card', error: null },
            },
          });
        });
        return { turn: { id: 'turn-mcp-card' } };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const chunks = await collectStream(provider.streamChat({
      prompt: '继续',
      sessionId: 'session-mcp-card',
      model: 'gpt-5.4',
    }));

    const events = parseSSEChunks(chunks);
    const activities = events
      .filter((event) => event.type === 'activity_event')
      .map((event) => JSON.parse(event.data));
    const toolActivities = activities.filter((event) => event.kind === 'tool_activity');

    assert.ok(toolActivities.some((event) =>
      event.toolUseId === 'tool-mcp-1'
      && event.status === 'running'
      && event.toolName === 'MCP: chrome-devtools take_screenshot'
      && (event.inputPreview || '').includes('demo.html')
    ));
    assert.ok(toolActivities.some((event) =>
      event.toolUseId === 'tool-mcp-1'
      && event.status === 'completed'
      && /Took a screenshot/.test(event.resultPreview || '')
    ));
    assert.equal(
      activities.some((event) => event.kind === 'lightweight_activity' && /take_screenshot/.test(event.text || '')),
      false,
    );
  });

  it('preserves Codex desktop screenshot image payloads inside tool_result content for downstream auto-send', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-mcp-image' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/started',
            params: {
              threadId: 'thread-mcp-image',
              turn: { id: 'turn-mcp-image' },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/completed',
            params: {
              threadId: 'thread-mcp-image',
              turnId: 'turn-mcp-image',
              item: {
                type: 'mcpToolCall',
                id: 'tool-mcp-image-1',
                server: 'chrome-devtools',
                tool: 'take_screenshot',
                arguments: { format: 'png' },
                result: {
                  content: [
                    {
                      type: 'text',
                      text: "Took a screenshot of the current page's viewport.",
                    },
                    {
                      type: 'image',
                      mimeType: 'image/png',
                      data: pngBase64,
                    },
                  ],
                },
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-mcp-image',
              turn: { id: 'turn-mcp-image', error: null },
            },
          });
        });
        return { turn: { id: 'turn-mcp-image' } };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const chunks = await collectStream(provider.streamChat({
      prompt: '继续',
      sessionId: 'session-mcp-image',
      model: 'gpt-5.4',
    }));

    const events = parseSSEChunks(chunks);
    const toolResultEvent = events.find((event) => event.type === 'tool_result');
    assert.ok(toolResultEvent);

    const toolResult = JSON.parse(toolResultEvent!.data);
    const content = JSON.parse(toolResult.content);
    assert.deepEqual(content, [
      {
        type: 'text',
        text: "Took a screenshot of the current page's viewport.",
      },
      {
        type: 'image',
        mimeType: 'image/png',
        data: pngBase64,
      },
    ]);
  });

  it('keeps started and completed command activities on the same fallback id when item ids are missing', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-command-fallback' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'notification',
            method: 'turn/started',
            params: {
              threadId: 'thread-command-fallback',
              turn: { id: 'turn-command-fallback' },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/started',
            params: {
              threadId: 'thread-command-fallback',
              turnId: 'turn-command-fallback',
              item: {
                type: 'commandExecution',
                command: 'sed -n 1,220p CLAUDE.md',
                cwd: '/tmp/test-cwd',
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'item/completed',
            params: {
              threadId: 'thread-command-fallback',
              turnId: 'turn-command-fallback',
              item: {
                type: 'commandExecution',
                command: 'sed -n 1,220p CLAUDE.md',
                cwd: '/tmp/test-cwd',
                aggregatedOutput: 'ok',
                exitCode: 0,
              },
            },
          });
          fake.emit({
            kind: 'notification',
            method: 'turn/completed',
            params: {
              threadId: 'thread-command-fallback',
              turn: { id: 'turn-command-fallback', error: null },
            },
          });
        });
        return { turn: { id: 'turn-command-fallback' } };
      },
    });

    const provider = new CodexProvider();
    (provider as any).client = fake;

    const chunks = await collectStream(provider.streamChat({
      prompt: '继续',
      sessionId: 'session-command-fallback',
      model: 'gpt-5.4',
    }));

    const events = parseSSEChunks(chunks);
    const commandActivities = events
      .filter((event) => event.type === 'activity_event')
      .map((event) => JSON.parse(event.data))
      .filter((event) => event.kind === 'command_execution');

    assert.equal(commandActivities.length, 2);
    assert.equal(commandActivities[0].status, 'running');
    assert.equal(commandActivities[1].status, 'completed');
    assert.equal(commandActivities[0].id, 'command:turn-command-fallback');
    assert.equal(commandActivities[1].id, 'command:turn-command-fallback');
    assert.equal(commandActivities[1].turnId, 'turn-command-fallback');
  });

  it('bridges structured user input requests back into app-server responses', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
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
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
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

  it('bridges generic requestApproval methods instead of rejecting them as unsupported', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
    const pendingApprovals = new PendingApprovals();
    const fake = new FakeCodexClient({
      'thread/start': async () => ({ thread: { id: 'thread-approval-generic' }, model: 'gpt-5.4' }),
      'turn/start': async () => {
        queueMicrotask(() => {
          fake.emit({
            kind: 'request',
            id: 'req-approval-generic',
            method: 'item/planExecution/requestApproval',
            params: {
              threadId: 'thread-approval-generic',
              turnId: 'turn-approval-generic',
              itemId: 'plan-approval-1',
              reason: 'Confirm whether to implement the proposed plan.',
            },
          });
        });
        return { turn: { id: 'turn-approval-generic' } };
      },
    });
    const provider = new CodexProvider(pendingApprovals, new PendingStructuredInputs());
    (provider as any).client = fake;

    const streamPromise = collectStream(provider.streamChat({
      prompt: '请给我一个方案',
      sessionId: 'session-approval-generic',
      collaborationMode: 'plan',
    }));

    await waitFor(() => fake.calls.some((call) => call.method === 'turn/start'));
    pendingApprovals.resolve('req-approval-generic', {
      behavior: 'allow',
      scope: 'turn',
    });
    await waitFor(() => fake.responses.length === 1);
    fake.emit({
      kind: 'notification',
      method: 'turn/completed',
      params: {
        threadId: 'thread-approval-generic',
        turn: { id: 'turn-approval-generic', error: null },
      },
    });

    const chunks = await streamPromise;
    const events = parseSSEChunks(chunks);
    const approvalEvent = events.find((event) => event.type === 'approval_request');
    assert.ok(approvalEvent);
    assert.equal(fake.responseErrors.length, 0);
    assert.deepEqual(fake.responses[0], {
      id: 'req-approval-generic',
      result: {
        decision: 'accept',
      },
    });
    const approvalPayload = JSON.parse(approvalEvent!.data);
    assert.equal(approvalPayload.toolName, 'Plan Execution');
    assert.equal(approvalPayload.toolInput.reason, 'Confirm whether to implement the proposed plan.');
    assert.equal(approvalPayload.method, 'item/planExecution/requestApproval');
    assert.equal(approvalPayload.threadId, 'thread-approval-generic');
    assert.equal(approvalPayload.turnId, 'turn-approval-generic');
  });

  it('retries with a fresh thread when thread/resume fails before any turn starts', async () => {
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
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
    const { CodexProvider } = await import('../providers/codex/codex-provider.js');
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
    const { parseTrustedProjectsFromCodexConfig, isTrustedCodexWorkingDirectory } = await import('../providers/codex/codex-provider.js');
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
