import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BaseChannelAdapter, registerAdapterFactory } from '../bridge/channel-adapter.js';
import { initBridgeContext } from '../bridge/context.js';
import { start, stop } from '../bridge/bridge-manager.js';
import type { InboundMessage, OutboundImage, OutboundMessage, SendResult } from '../bridge/types.js';
import { JsonFileStore } from '../infra/store.js';
import { CTI_HOME } from '../config/config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const CHANNEL_TYPE = 'planstub';

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    [`bridge_${CHANNEL_TYPE}_enabled`, 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    [`bridge_${CHANNEL_TYPE}_stream_interval_ms`, '1'],
    [`bridge_${CHANNEL_TYPE}_stream_min_delta_chars`, '1'],
    [`bridge_${CHANNEL_TYPE}_stream_max_chars`, '4000'],
    [`bridge_${CHANNEL_TYPE}_stream_prime_delay_ms`, '20'],
  ]);
}

class PlanStubAdapter extends BaseChannelAdapter {
  readonly channelType = CHANNEL_TYPE;
  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  sent: OutboundMessage[] = [];
  sentImages: OutboundImage[] = [];
  private messageSeq = 0;

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
    this.queue = [];
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    if (!this.running) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    this.messageSeq += 1;
    return { ok: true, messageId: `sent-${this.messageSeq}` };
  }

  async sendImage(image: OutboundImage): Promise<SendResult> {
    this.sentImages.push(image);
    this.messageSeq += 1;
    return { ok: true, messageId: `img-${this.messageSeq}` };
  }

  validateConfig(): string | null {
    return null;
  }

  isAuthorized(): boolean {
    return true;
  }

  push(message: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    this.queue.push(message);
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('bridge-manager plan workflow', () => {
  let adapter: PlanStubAdapter;

  beforeEach(async () => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    await stop();
    adapter = new PlanStubAdapter();
    registerAdapterFactory(CHANNEL_TYPE, () => adapter);
  });

  afterEach(async () => {
    await stop();
  });

  it('turns a Claude plan_request synthetic message into a Claude-native confirmation card', async () => {
    const store = new JsonFileStore(makeSettings());
    const llmCalls: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => {
          llmCalls.push(params);
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '1. 收集上下文\n2. 修改代码\n3. 验证结果' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-1' }) })}\n`);
              controller.close();
            },
          });
        },
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-1',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-1',
      bindingId: binding.id,
      channelType: CHANNEL_TYPE,
      chatId: 'chat-1',
      codepilotSessionId: session.id,
      status: 'planning',
      previousMode: 'code',
      requestText: '做一个实现计划',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-1', threadId: 'thread-1' },
      routeKey: 'chat-1:thread:thread-1',
      requestMessageId: 'msg-1',
      resolved: true,
    });

    await start();
    adapter.push({
      messageId: 'msg-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-1', threadId: 'thread-1' },
      text: '做一个实现计划',
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId: 'wf-1',
          promptText: 'PLAN PROMPT',
          storedUserText: '做一个实现计划',
          permissionMode: 'plan',
        },
      },
    });

    await waitFor(() => adapter.sent.length === 2);

    assert.equal(llmCalls[0].prompt, 'PLAN PROMPT');
    assert.equal(llmCalls[0].permissionMode, 'plan');
    assert.equal(adapter.sent[0].text, '1. 收集上下文\n2. 修改代码\n3. 验证结果');
    assert.equal(adapter.sent[1].cardHeader?.title, '计划已就绪');
    assert.deepEqual(
      adapter.sent[1].inlineButtons?.[0].map((button) => button.callbackData),
      ['planexit:approve:bypass:wf-1', 'planexit:approve:manual:wf-1'],
    );
    assert.deepEqual(
      adapter.sent[1].inlineButtons?.flat().map((button) => button.text),
      [
        'Yes, and bypass permissions',
        'Yes, manually approve edits',
        'Yes, clear context and bypass permissions',
      ],
    );
    assert.match(adapter.sent[1].text || '', /如需继续规划，请直接在本线程回复/);
    assert.equal(store.getPlanWorkflow('wf-1')?.status, 'awaiting_confirmation');
    assert.equal(store.getPlanWorkflow('wf-1')?.actionCardMessageId, 'sent-2');
    assert.equal(store.getPlanWorkflow('wf-1')?.approvalRequestId, '');
  });

  it('treats persistent Claude plan mode messages as plan requests without a synthetic /plan wrapper', async () => {
    const store = new JsonFileStore(makeSettings());
    const llmCalls: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => {
          llmCalls.push(params);
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({
                type: 'permission_request',
                data: JSON.stringify({
                  permissionRequestId: 'perm-persistent-plan',
                  toolName: 'ExitPlanMode',
                  toolInput: {
                    plan: '# 计划\\n\\n1. 阅读约束\\n2. 生成补丁',
                    allowedPrompts: [{ tool: 'Read', prompt: '读取仓库约束文件' }],
                  },
                }),
              })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-persistent-plan' }) })}\n`);
              controller.close();
            },
          });
        },
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-persistent-plan',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
      claudePermissionMode: 'plan',
    });

    await start();
    adapter.push({
      messageId: 'msg-persistent-plan',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-persistent-plan', threadId: 'thread-1' },
      text: '先帮我规划实现方案',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.equal(llmCalls[0].prompt, '先帮我规划实现方案');
    assert.equal(llmCalls[0].permissionMode, 'plan');
    assert.equal(adapter.sent[0].cardHeader?.title, '计划已就绪');
    assert.deepEqual(
      adapter.sent[0].inlineButtons?.flat().map((button) => button.text),
      [
        'Yes, and bypass permissions',
        'Yes, manually approve edits',
        'Yes, clear context and bypass permissions',
      ],
    );
    const workflow = store.getActivePlanWorkflowByBinding(binding.id);
    assert.ok(workflow);
    assert.equal(workflow?.status, 'awaiting_confirmation');
    assert.equal(workflow?.requestText, '先帮我规划实现方案');
  });

  it('writes local /stop replies into session history for the next model turn', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-stop',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    await start();
    adapter.push({
      messageId: 'msg-stop-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stop' },
      text: '/stop',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.match(adapter.sent[0].text, /No task is currently running/);
    const history = store.getMessages(session.id).messages.slice(-2);
    assert.equal(history[0]?.content, '/stop');
    assert.match(history[1]?.content || '', /No task is currently running/);
  });

  it('releases an active plan workflow on /stop even when no task controller is registered', async () => {
    const store = new JsonFileStore(makeSettings());
    const permissionResolutions: Array<{ id: string; resolution: unknown }> = [];
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: (id: string, resolution: unknown) => {
          permissionResolutions.push({ id, resolution });
          return true;
        },
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-stop-workflow',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-stop-workflow',
      bindingId: binding.id,
      channelType: CHANNEL_TYPE,
      chatId: 'chat-stop-workflow',
      codepilotSessionId: session.id,
      status: 'planning',
      previousMode: 'plan',
      requestText: '先做计划',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stop-workflow', threadId: 'thread-1' },
      routeKey: 'chat-stop-workflow:thread:thread-1',
      requestMessageId: 'msg-stop-workflow-1',
      approvalRequestId: 'perm-stop-workflow',
      activeAttemptId: 'attempt-stop-workflow',
      pendingFollowUpText: '补充要求',
      pendingRequestMessageId: 'msg-follow-up-1',
      pendingRouteKey: 'chat-stop-workflow:thread:thread-1',
      resolved: true,
    });

    await start();
    adapter.push({
      messageId: 'msg-stop-workflow-2',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stop-workflow', threadId: 'thread-1' },
      text: '/stop',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    const workflow = store.getPlanWorkflow('wf-stop-workflow');
    assert.equal(adapter.sent[0].text, 'Current task stopped.');
    assert.equal(workflow?.status, 'awaiting_input');
    assert.equal(workflow?.requestText, '');
    assert.equal(workflow?.activeAttemptId, '');
    assert.equal(workflow?.pendingFollowUpText, '');
    assert.deepEqual(permissionResolutions, [{
      id: 'perm-stop-workflow',
      resolution: {
        behavior: 'deny',
        message: 'Interrupted by /stop',
        interrupt: true,
      },
    }]);
    await sleep(50);
    assert.equal(adapter.sent.length, 1);
  });

  it('sends a completion reply after /stop aborts an active task', async () => {
    const store = new JsonFileStore(makeSettings());
    let resolveStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => new ReadableStream<string>({
          start(controller) {
            resolveStreamStarted?.();
            const abortController = params.abortController as AbortController | undefined;
            assert.ok(abortController);
            abortController.signal.addEventListener('abort', () => {
              setTimeout(() => {
                controller.error(new DOMException('Aborted', 'AbortError'));
              }, 10);
            }, { once: true });
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-stop-active',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    await start();
    adapter.push({
      messageId: 'msg-stop-active-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stop-active' },
      text: '开始执行',
      timestamp: Date.now(),
    });

    await streamStarted;

    adapter.push({
      messageId: 'msg-stop-active-2',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stop-active' },
      text: '/stop',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 2);

    assert.equal(adapter.sent[0].text, 'Stopping current task...');
    assert.equal(adapter.sent[1].text, 'Current task stopped.');
    assert.equal(
      adapter.sent.some((message) => (message.text || '').includes('<b>Error:</b>')),
      false,
    );
  });

  it('deduplicates the async completion reply across repeated /stop commands', async () => {
    const store = new JsonFileStore(makeSettings());
    let resolveStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => new ReadableStream<string>({
          start(controller) {
            resolveStreamStarted?.();
            const abortController = params.abortController as AbortController | undefined;
            assert.ok(abortController);
            abortController.signal.addEventListener('abort', () => {
              setTimeout(() => {
                controller.error(new DOMException('Aborted', 'AbortError'));
              }, 20);
            }, { once: true });
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-stop-repeat',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    await start();
    adapter.push({
      messageId: 'msg-stop-repeat-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stop-repeat' },
      text: '开始执行',
      timestamp: Date.now(),
    });

    await streamStarted;

    adapter.push({
      messageId: 'msg-stop-repeat-2',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stop-repeat' },
      text: '/stop',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    adapter.push({
      messageId: 'msg-stop-repeat-3',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stop-repeat' },
      text: '/stop',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 3);

    assert.equal(adapter.sent[0].text, 'Stopping current task...');
    assert.equal(adapter.sent[1].text, 'Stopping current task...');
    assert.equal(
      adapter.sent.filter((message) => message.text === 'Current task stopped.').length,
      1,
    );
  });

  it('does not emit stop completion text for normal successful turns', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '正常完成。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-normal-stop-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-no-stop',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    await start();
    adapter.push({
      messageId: 'msg-no-stop-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-no-stop' },
      text: '正常执行',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.equal(adapter.sent[0].text, '正常完成。');
    assert.equal(
      adapter.sent.some((message) => message.text === 'Current task stopped.'),
      false,
    );
  });

  it('drops stale queued plan attempts before they reach the LLM', async () => {
    const store = new JsonFileStore(makeSettings());
    const llmCalls: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => {
          llmCalls.push(params);
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-stale' }) })}\n`);
              controller.close();
            },
          });
        },
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-stale-attempt',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-stale-attempt',
      bindingId: binding.id,
      channelType: CHANNEL_TYPE,
      chatId: 'chat-stale-attempt',
      codepilotSessionId: session.id,
      status: 'interrupting',
      previousMode: 'plan',
      requestText: '旧计划',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stale-attempt', threadId: 'thread-1' },
      routeKey: 'chat-stale-attempt:thread:thread-1',
      requestMessageId: 'msg-stale-1',
      activeAttemptId: 'attempt-new',
      pendingFollowUpText: '最新要求',
      pendingRequestMessageId: 'msg-stale-2',
      pendingRouteKey: 'chat-stale-attempt:thread:thread-1',
      resolved: true,
    });

    let acked = false;
    adapter.acknowledgeUpdate = (updateId: number) => {
      if (updateId === 42) {
        acked = true;
      }
    };

    await start();
    adapter.push({
      messageId: 'msg-stale-queued',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-stale-attempt', threadId: 'thread-1' },
      text: '已经过期的补充要求',
      timestamp: Date.now(),
      updateId: 42,
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId: 'wf-stale-attempt',
          attemptId: 'attempt-old',
          promptText: 'PLAN PROMPT',
          storedUserText: '已经过期的补充要求',
          permissionMode: 'plan',
        },
      },
    });

    await waitFor(() => acked);

    assert.equal(llmCalls.length, 0);
    assert.equal(adapter.sent.length, 0);
  });

  it('treats Claude ExitPlanMode as a dedicated plan approval instead of a generic permission card', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'permission_request',
              data: JSON.stringify({
                permissionRequestId: 'perm-exit-1',
                toolName: 'ExitPlanMode',
                toolInput: {
                  plan: '# 计划\\n\\n1. 创建 HTML\\n2. 浏览器打开并截图',
                  allowedPrompts: [{ tool: 'Bash', prompt: '在浏览器中打开 HTML 文件' }],
                },
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-exit-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-exit',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-exit',
      bindingId: binding.id,
      channelType: CHANNEL_TYPE,
      chatId: 'chat-exit',
      codepilotSessionId: session.id,
      status: 'planning',
      previousMode: 'code',
      requestText: '生成单文件页面',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-exit', threadId: 'thread-1' },
      routeKey: 'chat-exit:thread:thread-1',
      requestMessageId: 'msg-exit-1',
      resolved: true,
    });

    await start();
    adapter.push({
      messageId: 'msg-exit-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-exit', threadId: 'thread-1' },
      text: '生成单文件页面',
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId: 'wf-exit',
          promptText: 'PLAN PROMPT',
          storedUserText: '生成单文件页面',
          permissionMode: 'plan',
        },
      },
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.equal(adapter.sent[0].cardHeader?.title, '计划已就绪');
    assert.deepEqual(
      adapter.sent[0].inlineButtons?.flat().map((button) => button.callbackData),
      [
        'planexit:approve:bypass:wf-exit',
        'planexit:approve:manual:wf-exit',
        'planexit:clear:bypass:wf-exit',
      ],
    );
    assert.deepEqual(
      adapter.sent[0].inlineButtons?.flat().map((button) => button.text),
      [
        'Yes, and bypass permissions',
        'Yes, manually approve edits',
        'Yes, clear context and bypass permissions',
      ],
    );
    assert.doesNotMatch(JSON.stringify(adapter.sent[0].rawCard || {}), /继续规划|claude_plan_feedback/i);
    assert.doesNotMatch(JSON.stringify(adapter.sent[0].rawCard || {}), /"tag":"form"/i);
    assert.equal(store.getPlanWorkflow('wf-exit')?.status, 'awaiting_confirmation');
    assert.equal(store.getPlanWorkflow('wf-exit')?.approvalRequestId, 'perm-exit-1');
    assert.match(store.getPlanWorkflow('wf-exit')?.planText || '', /创建 HTML/);
    assert.deepEqual(store.getPlanWorkflow('wf-exit')?.allowedPrompts, [
      { tool: 'Bash', prompt: '在浏览器中打开 HTML 文件' },
    ]);
  });

  it('keeps Claude execution output flowing after ExitPlanMode approval until the current attempt finishes', async () => {
    const store = new JsonFileStore(makeSettings());
    let releaseExecution: (() => void) | null = null;
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = () => resolve();
    });
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'permission_request',
              data: JSON.stringify({
                permissionRequestId: 'perm-exit-continue',
                toolName: 'ExitPlanMode',
                toolInput: {
                  plan: '# 计划\\n\\n1. 创建 HTML\\n2. 截图验证',
                  allowedPrompts: [],
                },
              }),
            })}\n`);
            executionReleased.then(() => {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '好的，开始执行。' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-exit-continue' }) })}\n`);
              controller.close();
            });
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-exit-continue',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-exit-continue',
      bindingId: binding.id,
      channelType: CHANNEL_TYPE,
      chatId: 'chat-exit-continue',
      codepilotSessionId: session.id,
      status: 'planning',
      previousMode: 'code',
      requestText: '生成单文件页面',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-exit-continue', threadId: 'thread-1' },
      routeKey: 'chat-exit-continue:thread:thread-1',
      requestMessageId: 'msg-exit-continue',
      activeAttemptId: 'attempt-exit-continue',
      resolved: true,
    });

    await start();
    adapter.push({
      messageId: 'msg-exit-continue',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-exit-continue', threadId: 'thread-1' },
      text: '生成单文件页面',
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId: 'wf-exit-continue',
          attemptId: 'attempt-exit-continue',
          promptText: 'PLAN PROMPT',
          storedUserText: '生成单文件页面',
          permissionMode: 'plan',
        },
      },
    });

    await waitFor(() => adapter.sent.length === 1);
    assert.equal(store.getPlanWorkflow('wf-exit-continue')?.status, 'awaiting_confirmation');

    store.updatePlanWorkflow('wf-exit-continue', {
      status: 'planning',
      approvalRequestId: '',
      actionCardMessageId: '',
      actionCardOpenMessageId: '',
      resolved: true,
    });
    const release = releaseExecution as (() => void) | null;
    if (!release) {
      throw new Error('Expected releaseExecution to be set');
    }
    release();

    await waitFor(() => adapter.sent.length === 2);

    assert.equal(adapter.sent[1].text, '好的，开始执行。');
    await waitFor(() => store.getPlanWorkflow('wf-exit-continue') === null);
  });

  it('turns a native_plan_request synthetic message into a native plan reply plus a confirmation card', async () => {
    const store = new JsonFileStore(makeSettings());
    const llmCalls: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => {
          llmCalls.push(params);
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '# 原生计划\\n\\n1. 先确认范围\\n2. 再开始实施' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'plan_result', data: '# 原生计划\\n\\n1. 先确认范围\\n2. 再开始实施' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-native-1' }) })}\n`);
              controller.close();
            },
          });
        },
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-native',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-native',
      bindingId: binding.id,
      channelType: CHANNEL_TYPE,
      chatId: 'chat-native',
      codepilotSessionId: session.id,
      status: 'planning',
      previousMode: 'code',
      requestText: '先给我方案再实施',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-native', threadId: 'thread-1' },
      routeKey: 'chat-native:thread:thread-1',
      requestMessageId: 'msg-native-1',
      resolved: true,
    });

    await start();
    adapter.push({
      messageId: 'msg-native-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-native', threadId: 'thread-1' },
      text: '先给我方案再实施',
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'native_plan_request',
          workflowId: 'wf-native',
          promptText: 'NATIVE PLAN PROMPT',
          storedUserText: '先给我方案再实施',
          permissionMode: 'plan',
        },
      },
    });

    await waitFor(() => adapter.sent.length === 2);

    assert.equal(llmCalls[0].prompt, 'NATIVE PLAN PROMPT');
    assert.equal(llmCalls[0].permissionMode, 'plan');
    assert.equal(llmCalls[0].collaborationMode, 'plan');
    assert.match(adapter.sent[0].text, /原生计划/);
    assert.match(adapter.sent[0].text, /先确认范围/);
    assert.match(adapter.sent[0].text, /再开始实施/);
    assert.equal(adapter.sent[1].cardHeader?.title, '原生计划已生成');
    assert.match(adapter.sent[1].text || '', /直接在群聊回复告诉 Codex 如何调整/);
    assert.deepEqual(
      adapter.sent[1].inlineButtons?.[0].map((button) => button.callbackData),
      ['plan:execute:wf-native'],
    );
    assert.deepEqual(
      adapter.sent[1].inlineButtons?.[0].map((button) => button.text),
      ['是，实施此计划'],
    );
    assert.equal(store.getPlanWorkflow('wf-native')?.status, 'awaiting_confirmation');
    assert.equal(store.getPlanWorkflow('wf-native')?.actionCardMessageId, 'sent-2');
  });

  it('treats the first normal message in a codex plan-mode chat as a native plan request', async () => {
    const store = new JsonFileStore(makeSettings());
    const llmCalls: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => {
          llmCalls.push(params);
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'plan_result', data: '# 原生计划\\n\\n1. 先确认范围\\n2. 再开始实施' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-native-chat-plan-1' }) })}\n`);
              controller.close();
            },
          });
        },
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-native-plan-mode',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });
    store.updateChannelBinding(binding.id, { mode: 'plan' });

    await start();
    adapter.push({
      messageId: 'msg-native-plan-mode-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-native-plan-mode' },
      text: '先给我方案再实施',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 2);

    assert.equal(llmCalls[0].prompt, '先给我方案再实施');
    assert.equal(llmCalls[0].permissionMode, 'plan');
    assert.equal(llmCalls[0].collaborationMode, 'plan');
    assert.match(adapter.sent[0].text || '', /原生计划/);
    assert.equal(adapter.sent[1].cardHeader?.title, '原生计划已生成');
    assert.deepEqual(
      adapter.sent[1].inlineButtons?.[0].map((button) => button.text),
      ['是，实施此计划'],
    );
    assert.match(adapter.sent[1].inlineButtons?.[0][0]?.callbackData || '', /^plan:execute:/);
    const workflow = store.getActivePlanWorkflowByBinding(binding.id);
    assert.ok(workflow);
    assert.equal(workflow?.status, 'awaiting_confirmation');
    assert.equal(workflow?.requestText, '先给我方案再实施');
  });

  it('falls back to a plain text hint when sending the native confirmation card throws', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '# 原生计划\\n\\n1. 先确认范围\\n2. 再开始实施' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-native-fallback-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-native-fallback',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-native-fallback',
      bindingId: binding.id,
      channelType: CHANNEL_TYPE,
      chatId: 'chat-native-fallback',
      codepilotSessionId: session.id,
      status: 'planning',
      previousMode: 'code',
      requestText: '先给我方案再实施',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-native-fallback', threadId: 'thread-1' },
      routeKey: 'chat-native-fallback:thread:thread-1',
      requestMessageId: 'msg-native-fallback-1',
      resolved: true,
    });

    const originalSend = adapter.send.bind(adapter);
    adapter.send = async (message) => {
      if (message.cardHeader?.title === '原生计划已生成') {
        throw new Error('502 Bad Gateway');
      }
      return originalSend(message);
    };

    await start();
    adapter.push({
      messageId: 'msg-native-fallback-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-native-fallback', threadId: 'thread-1' },
      text: '先给我方案再实施',
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'native_plan_request',
          workflowId: 'wf-native-fallback',
          promptText: 'NATIVE PLAN PROMPT',
          storedUserText: '先给我方案再实施',
          permissionMode: 'plan',
        },
      },
    });

    await waitFor(() => adapter.sent.length === 2);

    assert.match(adapter.sent[0].text || '', /原生计划/);
    assert.match(adapter.sent[1].text || '', /确认卡发送失败/);
    assert.match(adapter.sent[1].text || '', /直接在本线程回复/);
    assert.equal(store.getPlanWorkflow('wf-native-fallback')?.status, 'awaiting_input');
    assert.equal(store.getPlanWorkflow('wf-native-fallback')?.resolved, true);
  });

  it('sends explicit collaborationMode=default for codex code-mode turns', async () => {
    const store = new JsonFileStore(makeSettings());
    const llmCalls: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => {
          llmCalls.push(params);
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '开始执行。' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-code-1' }) })}\n`);
              controller.close();
            },
          });
        },
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-code',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    await start();
    adapter.push({
      messageId: 'msg-code-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-code', threadId: 'thread-1' },
      text: '开始按方案实现',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.equal(llmCalls[0].collaborationMode, 'default');
    assert.equal(adapter.sent[0].text, '开始执行。');
  });

  it('sends explicit collaborationMode=default for plan_execute follow-up turns', async () => {
    const store = new JsonFileStore(makeSettings());
    const llmCalls: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: (params: Record<string, unknown>) => {
          llmCalls.push(params);
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '开始按确认方案实施。' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-execute-1' }) })}\n`);
              controller.close();
            },
          });
        },
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-execute',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    await start();
    adapter.push({
      messageId: 'msg-execute-1',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-execute', threadId: 'thread-1' },
      text: '执行已确认计划：生成单文件页面',
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_execute',
          workflowId: 'wf-execute',
          promptText: '按已确认计划开始实施，不要重复输出计划。',
          storedUserText: '执行已确认计划：生成单文件页面',
          permissionMode: 'acceptEdits',
          collaborationMode: 'default',
        },
      },
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.equal(llmCalls[0].prompt, '按已确认计划开始实施，不要重复输出计划。');
    assert.equal(llmCalls[0].permissionMode, 'acceptEdits');
    assert.equal(llmCalls[0].collaborationMode, 'default');
    assert.equal(adapter.sent[0].text, '开始按确认方案实施。');
  });

  it('falls back to a plain text prompt when structured input card delivery fails', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'structured_input_request',
              data: JSON.stringify({
                requestId: 'req-1',
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                questions: [
                  {
                    id: 'q1',
                    header: '文件位置',
                    question: '这个单文件 HTML 默认放在哪里、叫什么？',
                    isOther: true,
                    isSecret: false,
                    options: [{ label: '根目录 about-codex.html', description: '推荐' }],
                  },
                ],
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-2' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-structured',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    (adapter as any).sendStructuredInputRequest = async () => {
      throw new Error('card rejected');
    };

    await start();
    adapter.push({
      messageId: 'msg-structured',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-structured' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length >= 2);
    assert.match(adapter.sent[0].text || '', /继续前还需要确认 文件位置/);
    assert.match(adapter.sent[1].text || '', /当前运行时请求补充信息/);
  });

  it('sends a short process preface before a structured input card when no assistant output was visible yet', async () => {
    const store = new JsonFileStore(makeSettings());
    let structuredRequest: { requestId?: string } | null = null;
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'structured_input_request',
              data: JSON.stringify({
                requestId: 'req-preface-1',
                threadId: 'thread-preface-1',
                turnId: 'turn-preface-1',
                itemId: 'item-preface-1',
                questions: [
                  {
                    id: 'q1',
                    header: '文件位置',
                    question: '这个单文件 HTML 要放在哪里？',
                    isOther: true,
                    isSecret: false,
                    options: [{ label: '根目录', description: '推荐' }],
                  },
                  {
                    id: 'q2',
                    header: '语言',
                    question: '自我介绍页面用什么语言？',
                    isOther: true,
                    isSecret: false,
                    options: [{ label: '中文', description: '推荐' }],
                  },
                ],
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-preface-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-structured-preface',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    (adapter as any).sendStructuredInputRequest = async (_address: unknown, request: { requestId?: string }) => {
      structuredRequest = request;
      return { ok: true, messageId: 'structured-preface-msg' };
    };

    await start();
    adapter.push({
      messageId: 'msg-structured-preface',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-structured-preface' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1 && structuredRequest !== null);

    assert.match(adapter.sent[0].text || '', /继续前还需要确认 文件位置、语言/);
    const deliveredRequest = structuredRequest || { requestId: undefined };
    assert.equal(deliveredRequest.requestId, 'req-preface-1');
  });

  it('does not prime a placeholder card before structured input follow-ups', async () => {
    const store = new JsonFileStore(makeSettings());
    const previewPrimes: number[] = [];
    let structuredRequest: { requestId?: string } | null = null;
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '我已经确认当前工作区根目录可直接放一个独立 html 文件。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '我已经确认当前工作区根目录可直接放一个独立 html 文件。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'structured_input_request',
              data: JSON.stringify({
                requestId: 'req-no-prime-1',
                threadId: 'thread-no-prime-1',
                turnId: 'turn-no-prime-1',
                itemId: 'item-no-prime-1',
                questions: [
                  {
                    id: 'q1',
                    header: '语言',
                    question: '页面内容用什么语言？',
                    isOther: true,
                    isSecret: false,
                    options: [{ label: '英文', description: '推荐' }],
                  },
                ],
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-no-prime-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-no-prime-structured',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    (adapter as any).getPreviewCapabilities = () => ({
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    });
    (adapter as any).primePreview = async (_address: unknown, draftId: number) => {
      previewPrimes.push(draftId);
      return 'sent';
    };
    (adapter as any).sendStructuredInputRequest = async (_address: unknown, request: { requestId?: string }) => {
      structuredRequest = request;
      return { ok: true, messageId: 'structured-no-prime-msg' };
    };

    await start();
    adapter.push({
      messageId: 'msg-no-prime-structured',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-no-prime-structured' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1 && structuredRequest !== null);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(previewPrimes.length, 0);
    const deliveredRequest = structuredRequest || { requestId: undefined };
    assert.equal(deliveredRequest.requestId, 'req-no-prime-1');
  });

  it('suppresses delayed lightweight activity cards when the turn immediately asks for structured input', async () => {
    const store = new JsonFileStore(makeSettings());
    const activityEvents: Array<Record<string, unknown>> = [];
    let structuredRequest: { requestId?: string } | null = null;
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'lightweight_activity',
                id: 'lw-1',
                turnId: 'turn-activity-structured',
                status: 'running',
                text: '正在自动压缩背景信息…',
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'structured_input_request',
              data: JSON.stringify({
                requestId: 'req-activity-structured',
                threadId: 'thread-activity-structured',
                turnId: 'turn-activity-structured',
                itemId: 'item-activity-structured',
                questions: [
                  {
                    id: 'q1',
                    header: '语言',
                    question: '页面内容用什么语言？',
                    isOther: true,
                    isSecret: false,
                    options: [{ label: '英文', description: '推荐' }],
                  },
                ],
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-activity-structured' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-activity-structured',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    (adapter as any).upsertActivityEvent = async (_address: unknown, event: Record<string, unknown>) => {
      activityEvents.push(event);
      return { ok: true, messageId: `activity-${activityEvents.length}` };
    };
    (adapter as any).sendStructuredInputRequest = async (_address: unknown, request: { requestId?: string }) => {
      structuredRequest = request;
      return { ok: true, messageId: 'structured-activity-msg' };
    };

    await start();
    adapter.push({
      messageId: 'msg-activity-structured',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-activity-structured' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => structuredRequest !== null);
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(activityEvents.length, 0);
    const deliveredRequest = structuredRequest || { requestId: undefined };
    assert.equal(deliveredRequest.requestId, 'req-activity-structured');
  });

  it('does not prime a preview once a Claude tool activity card is already visible', async () => {
    const store = new JsonFileStore(makeSettings());
    const activityEvents: Array<Record<string, unknown>> = [];
    const previewPrimes: number[] = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'tool_activity',
                toolUseId: 'tool-1',
                toolName: 'MCP: chrome-devtools take_screenshot',
                status: 'running',
                inputPreview: 'file:///tmp/test-cwd/index.html',
                taskId: 'task-1',
                source: 'tool_progress',
              }),
            })}\n`);
            setTimeout(() => {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '截图执行中，我会把结果直接发回群里。' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-tool-preview-1' }) })}\n`);
              controller.close();
            }, 60);
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-tool-preview',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    (adapter as any).getPreviewCapabilities = () => ({
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    });
    (adapter as any).primePreview = async (_address: unknown, draftId: number) => {
      previewPrimes.push(draftId);
      return 'sent';
    };
    (adapter as any).upsertActivityEvent = async (_address: unknown, event: Record<string, unknown>) => {
      activityEvents.push(event);
      return { ok: true, messageId: `activity-${activityEvents.length}` };
    };

    await start();
    adapter.push({
      messageId: 'msg-tool-preview',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-tool-preview', threadId: 'thread-1' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1 && activityEvents.length === 1);

    assert.equal(previewPrimes.length, 0);
    assert.equal(activityEvents[0]?.kind, 'tool_activity');
    assert.equal(adapter.sent[0].text, '截图执行中，我会把结果直接发回群里。');
  });

  it('projects lightweight, command, and file activities without mixing them into assistant text delivery', async () => {
    const store = new JsonFileStore(makeSettings());
    const activityEvents: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'lightweight_activity',
                id: 'lw-1',
                turnId: 'turn-activity-project',
                status: 'running',
                text: '正在搜索飞书文档…',
              }),
            })}\n`);
            setTimeout(() => {
              controller.enqueue(`data: ${JSON.stringify({
                type: 'activity_event',
                data: JSON.stringify({
                  kind: 'lightweight_activity',
                  id: 'lw-2',
                  turnId: 'turn-activity-project',
                  status: 'completed',
                  text: '已搜索飞书文档 (https://open.feishu.cn/...)',
                }),
              })}\n`);
              controller.enqueue(`data: ${JSON.stringify({
                type: 'activity_event',
                data: JSON.stringify({
                  kind: 'command_execution',
                  id: 'legacy-cmd-1',
                  turnId: 'turn-activity-project',
                  status: 'running',
                  command: 'rg CardKit',
                  cwd: '/tmp/test-cwd',
                  output: 'src/feishu/adapter.ts',
                }),
              })}\n`);
              controller.enqueue(`data: ${JSON.stringify({
                type: 'activity_event',
                data: JSON.stringify({
                  kind: 'command_execution',
                  id: 'stable-cmd-1',
                  turnId: 'turn-activity-project',
                  status: 'completed',
                  command: 'rg CardKit',
                  cwd: '/tmp/test-cwd',
                  output: 'src/feishu/adapter.ts',
                  exitCode: 0,
                }),
              })}\n`);
              controller.enqueue(`data: ${JSON.stringify({
                type: 'activity_event',
                data: JSON.stringify({
                  kind: 'command_execution',
                  id: 'command:turn-activity-project',
                  turnId: 'turn-activity-project',
                  status: 'completed',
                  command: 'pwd',
                  cwd: '/tmp/test-cwd',
                  output: '/tmp/test-cwd',
                  exitCode: 0,
                }),
              })}\n`);
              controller.enqueue(`data: ${JSON.stringify({
                type: 'activity_event',
                data: JSON.stringify({
                  kind: 'command_execution',
                  id: 'command:turn-activity-project',
                  turnId: 'turn-activity-project',
                  status: 'completed',
                  command: 'rg CardKit',
                  cwd: '/tmp/test-cwd',
                  output: 'src/feishu/adapter.ts',
                  exitCode: 0,
                }),
              })}\n`);
              controller.enqueue(`data: ${JSON.stringify({
                type: 'activity_event',
                data: JSON.stringify({
                  kind: 'file_change',
                  id: 'file-1',
                  turnId: 'turn-activity-project',
                  status: 'completed',
                  summary: '已修改 bridge-manager.ts',
                  changes: [{ kind: 'update', path: 'src/bridge/bridge-manager.ts' }],
                }),
              })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '我已经整理出 remodex 风格的展示方案。' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-activity-project' }) })}\n`);
              controller.close();
            }, 40);
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-activity-project',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    (adapter as any).upsertActivityEvent = async (_address: unknown, event: Record<string, unknown>) => {
      activityEvents.push(event);
      return { ok: true, messageId: `activity-${activityEvents.length}` };
    };

    await start();
    adapter.push({
      messageId: 'msg-activity-project',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-activity-project', threadId: 'thread-1' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1 && activityEvents.length >= 7);

    assert.equal(adapter.sent[0].text, '我已经整理出 remodex 风格的展示方案。');
    assert.deepEqual(
      activityEvents.map((event) => event.kind),
      [
        'lightweight_activity',
        'lightweight_activity',
        'command_execution',
        'command_execution',
        'command_execution',
        'command_execution',
        'file_change',
      ],
    );
    assert.equal(activityEvents[0].id, activityEvents[1].id);
    assert.match(String(activityEvents[0].id), /^lightweight-slot:/);
    assert.match(String(activityEvents[2].id), /^command:/);
    assert.equal(activityEvents[2].id, activityEvents[3].id);
    assert.notEqual(activityEvents[3].id, activityEvents[4].id);
    assert.notEqual(activityEvents[3].id, activityEvents[5].id);
    assert.notEqual(activityEvents[4].id, activityEvents[5].id);
    assert.match(String(activityEvents[6].id), /^file:/);
  });

  it('auto-sends a completed command screenshot once per turn and dedupes repeated completed events', async () => {
    const store = new JsonFileStore(makeSettings());
    const imagePath = path.resolve('/tmp/test-cwd/index-preview.png');
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            fs.mkdirSync(path.dirname(imagePath), { recursive: true });
            fs.writeFileSync(imagePath, 'fake-png-data');
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'command_execution',
                id: 'cmd-image-1',
                turnId: 'turn-image-1',
                status: 'completed',
                command: `python capture.py --output ${imagePath}`,
                cwd: '/tmp/test-cwd',
                output: `saved screenshot to ${imagePath}`,
                exitCode: 0,
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'command_execution',
                id: 'cmd-image-1-repeat',
                turnId: 'turn-image-1',
                status: 'completed',
                command: `python capture.py --output ${imagePath}`,
                cwd: '/tmp/test-cwd',
                output: `saved screenshot to ${imagePath}`,
                exitCode: 0,
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '截图已经生成。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-image-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-auto-image',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    await start();
    adapter.push({
      messageId: 'msg-auto-image',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-auto-image', threadId: 'thread-1' },
      text: '生成截图',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sentImages.length === 1 && adapter.sent.length === 1);

    assert.equal(adapter.sentImages.length, 1);
    assert.equal(adapter.sentImages[0].filePath, imagePath);
    assert.equal(adapter.sentImages[0].replyToMessageId, 'msg-auto-image');
    assert.equal(adapter.sent[0].text, '截图已经生成。');
  });

  it('auto-sends inline base64 images returned from tool_result blocks before the assistant summary', async () => {
    const store = new JsonFileStore(makeSettings());
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z3w8AAAAASUVORK5CYII=';
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'tool_result',
              data: JSON.stringify({
                tool_use_id: 'tool-image-1',
                content: JSON.stringify([
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: pngBase64,
                    },
                  },
                ]),
                is_error: false,
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '效果如上图所示。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-inline-image-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-inline-image',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    await start();
    adapter.push({
      messageId: 'msg-inline-image',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-inline-image', threadId: 'thread-1' },
      text: '发我截图',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sentImages.length === 1 && adapter.sent.length === 1);

    assert.match(adapter.sentImages[0].filePath, /cti-inline-tool-result-.*\.png$/);
    assert.equal(adapter.sentImages[0].replyToMessageId, 'msg-inline-image');
    assert.equal(adapter.sent[0].text, '效果如上图所示。');
  });

  it('auto-sends inline images from Codex MCP tool_result payloads that use mimeType/data fields', async () => {
    const store = new JsonFileStore(makeSettings());
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'tool_result',
              data: JSON.stringify({
                tool_use_id: 'tool-image-codex-1',
                content: JSON.stringify([
                  {
                    type: 'text',
                    text: "Took a screenshot of the current page's viewport.",
                  },
                  {
                    type: 'image',
                    mimeType: 'image/png',
                    data: pngBase64,
                  },
                ]),
                is_error: false,
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '截图已经生成。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-inline-image-codex-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-inline-image-codex',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    await start();
    adapter.push({
      messageId: 'msg-inline-image-codex',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-inline-image-codex', threadId: 'thread-1' },
      text: '发我桌面截图',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sentImages.length === 1 && adapter.sent.length === 1);

    assert.match(adapter.sentImages[0].filePath, /cti-inline-tool-result-.*\.png$/);
    assert.equal(adapter.sentImages[0].replyToMessageId, 'msg-inline-image-codex');
    assert.equal(adapter.sent[0].text, '截图已经生成。');
  });

  it('auto-sends screenshot files referenced by Codex MCP tool_result text payloads', async () => {
    const store = new JsonFileStore(makeSettings());
    const imagePath = path.resolve('/tmp/test-cwd/.artifacts/codex-intro.png');
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            fs.mkdirSync(path.dirname(imagePath), { recursive: true });
            fs.writeFileSync(imagePath, 'fake-png-data');
            controller.enqueue(`data: ${JSON.stringify({
              type: 'tool_result',
              data: JSON.stringify({
                tool_use_id: 'tool-image-path-codex-1',
                content: JSON.stringify([
                  {
                    type: 'text',
                    text: `Took a screenshot of the full current page.\nSaved screenshot to ${imagePath}.`,
                  },
                ]),
                is_error: false,
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '截图已重新生成。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-inline-image-path-codex-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-inline-image-path-codex',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    await start();
    adapter.push({
      messageId: 'msg-inline-image-path-codex',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-inline-image-path-codex', threadId: 'thread-1' },
      text: '发我截图文件',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sentImages.length === 1 && adapter.sent.length === 1);

    assert.equal(adapter.sentImages[0].filePath, imagePath);
    assert.equal(adapter.sentImages[0].replyToMessageId, 'msg-inline-image-path-codex');
    assert.equal(adapter.sent[0].text, '截图已重新生成。');
  });

  it('auto-sends a completed file_change image by resolving relative paths against the binding cwd', async () => {
    const store = new JsonFileStore(makeSettings());
    const imagePath = path.resolve('/tmp/test-cwd/shot.png');
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            fs.mkdirSync(path.dirname(imagePath), { recursive: true });
            fs.writeFileSync(imagePath, 'fake-png-data');
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'file_change',
                id: 'file-image-1',
                turnId: 'turn-file-image-1',
                status: 'completed',
                summary: '生成了预览图',
                changes: [{ kind: 'create', path: 'shot.png' }],
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '文件截图已生成。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-file-image-1' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-file-image',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    await start();
    adapter.push({
      messageId: 'msg-file-image',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-file-image' },
      text: '生成预览图',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sentImages.length === 1 && adapter.sent.length === 1);

    assert.equal(adapter.sentImages[0].filePath, imagePath);
    assert.equal(adapter.sentImages[0].replyToMessageId, 'msg-file-image');
  });

  it('skips non-images, missing files, zero-byte files, and stale files when auto-sending screenshots', async () => {
    const store = new JsonFileStore(makeSettings());
    const oldImagePath = path.resolve('/tmp/test-cwd/old-preview.png');
    const zeroImagePath = path.resolve('/tmp/test-cwd/zero-preview.png');
    const missingImagePath = path.resolve('/tmp/test-cwd/missing-preview.png');
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            fs.mkdirSync(path.dirname(oldImagePath), { recursive: true });
            fs.writeFileSync(oldImagePath, 'old-image');
            const oldTime = new Date(Date.now() - 60_000);
            fs.utimesSync(oldImagePath, oldTime, oldTime);
            fs.writeFileSync(zeroImagePath, '');
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'command_execution',
                id: 'cmd-invalid-images',
                turnId: 'turn-invalid-images',
                status: 'completed',
                command: `echo ${oldImagePath} ${zeroImagePath} ${missingImagePath}`,
                cwd: '/tmp/test-cwd',
                output: `${oldImagePath}\n${zeroImagePath}\n${missingImagePath}`,
                exitCode: 0,
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'file_change',
                id: 'file-invalid-images',
                turnId: 'turn-invalid-images',
                status: 'completed',
                summary: '只改了文本文件',
                changes: [{ kind: 'update', path: 'notes.txt' }],
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '没有有效截图需要发送。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-invalid-images' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-invalid-images',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    await start();
    adapter.push({
      messageId: 'msg-invalid-images',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-invalid-images' },
      text: '检查无效截图',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.equal(adapter.sentImages.length, 0);
    assert.equal(adapter.sent[0].text, '没有有效截图需要发送。');
  });

  it('keeps delivering assistant text even when automatic screenshot sending fails', async () => {
    const store = new JsonFileStore(makeSettings());
    const imagePath = path.resolve('/tmp/test-cwd/throwing-preview.png');
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            fs.mkdirSync(path.dirname(imagePath), { recursive: true });
            fs.writeFileSync(imagePath, 'fake-png-data');
            controller.enqueue(`data: ${JSON.stringify({
              type: 'activity_event',
              data: JSON.stringify({
                kind: 'command_execution',
                id: 'cmd-throwing-image',
                turnId: 'turn-throwing-image',
                status: 'completed',
                command: `python capture.py --output ${imagePath}`,
                cwd: '/tmp/test-cwd',
                output: imagePath,
                exitCode: 0,
              }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '即使发图失败，正文也要继续。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-throwing-image' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-throwing-image',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });
    (adapter as any).sendImage = async () => {
      throw new Error('upload failed');
    };

    await start();
    adapter.push({
      messageId: 'msg-throwing-image',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-throwing-image' },
      text: '发图失败也要继续',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.equal(adapter.sentImages.length, 0);
    assert.equal(adapter.sent[0].text, '即使发图失败，正文也要继续。');
  });

  it('keeps one final delivery for replace_preview channels and merges a one-character lead segment', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '我' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '我' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '已经确认技术方案并开始生成页面。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '已经确认技术方案并开始生成页面。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '接下来补齐剩余内容。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '接下来补齐剩余内容。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-segmented' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-segmented',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const previewUpdates: string[] = [];
    const previewEnds: number[] = [];
    (adapter as any).getPreviewCapabilities = () => ({
      supported: true,
      privateOnly: false,
      finalDelivery: 'replace_preview',
    });
    (adapter as any).sendPreview = async (_address: unknown, text: string, draftId: number) => {
      previewUpdates.push(`${draftId}:${text}`);
      return 'sent';
    };
    (adapter as any).endPreview = (_address: unknown, draftId: number) => {
      previewEnds.push(draftId);
    };

    await start();
    adapter.push({
      messageId: 'msg-segmented',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-segmented', threadId: 'thread-1' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 1);

    assert.equal(
      adapter.sent[0].text,
      '我已经确认技术方案并开始生成页面。\n\n接下来补齐剩余内容。',
    );
    assert.ok(previewUpdates.length > 0);
    assert.ok(!previewUpdates.some((entry) => entry.endsWith(':我')));
    assert.deepEqual(previewEnds.length, 1);
  });

  it('finalizes each completed segment in place for segment_replace_preview channels', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '我' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '我' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '已经确认技术方案并开始生成页面。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '已经确认技术方案并开始生成页面。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '接下来补齐剩余内容。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '接下来补齐剩余内容。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-segmented-preview' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-segmented-preview',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const previewUpdates: string[] = [];
    const previewEnds: number[] = [];
    const previewPrimes: number[] = [];
    (adapter as any).getPreviewCapabilities = () => ({
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    });
    (adapter as any).primePreview = async (_address: unknown, draftId: number) => {
      previewPrimes.push(draftId);
      return 'sent';
    };
    (adapter as any).sendPreview = async (_address: unknown, text: string, draftId: number) => {
      previewUpdates.push(`${draftId}:${text}`);
      return 'sent';
    };
    (adapter as any).endPreview = (_address: unknown, draftId: number) => {
      previewEnds.push(draftId);
    };

    await start();
    adapter.push({
      messageId: 'msg-segmented-preview',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-segmented-preview', threadId: 'thread-1' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => adapter.sent.length === 2);

    assert.deepEqual(
      adapter.sent.map((message) => message.text),
      [
        '我已经确认技术方案并开始生成页面。',
        '接下来补齐剩余内容。',
      ],
    );
    assert.ok(previewUpdates.length > 0);
    assert.ok(!previewUpdates.some((entry) => entry.endsWith(':我')));
    assert.deepEqual(previewPrimes.length, 0);
    assert.equal(previewEnds.length, 2);
    assert.notEqual(previewEnds[0], previewEnds[1]);
  });

  it('primes a visible placeholder when the next segment is delayed', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '我已经确认技术方案并开始生成页面。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '我已经确认技术方案并开始生成页面。' })}\n`);
            setTimeout(() => {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '接下来补齐剩余内容。' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '接下来补齐剩余内容。' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-prime-gap' }) })}\n`);
              controller.close();
            }, 60);
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-prime-gap',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const previewPrimes: number[] = [];
    const previewUpdates: string[] = [];
    (adapter as any).getPreviewCapabilities = () => ({
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    });
    (adapter as any).primePreview = async (_address: unknown, draftId: number) => {
      previewPrimes.push(draftId);
      return 'sent';
    };
    (adapter as any).sendPreview = async (_address: unknown, text: string, draftId: number) => {
      previewUpdates.push(`${draftId}:${text}`);
      return 'sent';
    };

    await start();
    adapter.push({
      messageId: 'msg-prime-gap',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-prime-gap', threadId: 'thread-1' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => previewPrimes.length === 1);
    await waitFor(() => adapter.sent.length === 2);

    assert.equal(previewPrimes.length, 1);
    assert.ok(previewUpdates.some((entry) => entry.endsWith(':接下来补齐剩余内容。')));
  });

  it('clears any pending preview prime before sending a Claude plan confirmation card', async () => {
    const store = new JsonFileStore(makeSettings());
    const previewPrimes: number[] = [];
    const previewEnds: number[] = [];
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '我先整理出一版实施计划。' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text_segment', data: '我先整理出一版实施计划。' })}\n`);
            setTimeout(() => {
              controller.enqueue(`data: ${JSON.stringify({
                type: 'permission_request',
                data: JSON.stringify({
                  permissionRequestId: 'perm-prime-exit',
                  toolName: 'ExitPlanMode',
                  toolInput: {
                    plan: '# 计划\\n\\n1. 创建 HTML\\n2. 截图验证',
                    allowedPrompts: [],
                  },
                }),
              })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-prime-exit' }) })}\n`);
              controller.close();
            }, 60);
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-prime-exit',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-prime-exit',
      bindingId: binding.id,
      channelType: CHANNEL_TYPE,
      chatId: 'chat-prime-exit',
      codepilotSessionId: session.id,
      status: 'planning',
      previousMode: 'code',
      requestText: '先给我计划',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-prime-exit', threadId: 'thread-1' },
      routeKey: 'chat-prime-exit:thread:thread-1',
      requestMessageId: 'msg-prime-exit',
      resolved: true,
    });

    (adapter as any).getPreviewCapabilities = () => ({
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    });
    (adapter as any).primePreview = async (_address: unknown, draftId: number) => {
      previewPrimes.push(draftId);
      return 'sent';
    };
    (adapter as any).endPreview = (_address: unknown, draftId: number) => {
      previewEnds.push(draftId);
    };

    await start();
    adapter.push({
      messageId: 'msg-prime-exit',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-prime-exit', threadId: 'thread-1' },
      text: '先给我计划',
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId: 'wf-prime-exit',
          promptText: 'PLAN PROMPT',
          storedUserText: '先给我计划',
          permissionMode: 'plan',
        },
      },
    });

    await waitFor(() => adapter.sent.length === 2);

    assert.equal(previewPrimes.length, 1);
    assert.ok(previewEnds.includes(previewPrimes[0]!));
    assert.equal(adapter.sent[1].cardHeader?.title, '计划已就绪');
  });

  it('waits for an in-flight preview before finalizing a segment so the same text is not delivered twice', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'text',
              data: '需求是做一个仅包含单个 html 文件的简易自我介绍网页；当前还在 Plan Mode，我先检查仓库里的约束文件和现有目录结构。',
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'text_segment',
              data: '需求是做一个仅包含单个 html 文件的简易自我介绍网页；当前还在 Plan Mode，我先检查仓库里的约束文件和现有目录结构。',
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-preview-race' }) })}\n`);
            controller.close();
          },
        }),
      } as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5.4',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: CHANNEL_TYPE,
      chatId: 'chat-preview-race',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const previewCreates: string[] = [];
    const finalizedInPlace: string[] = [];
    const separateMessages: string[] = [];
    const activePreviewByChat = new Map<string, string>();
    let messageSeq = 0;

    (adapter as any).getPreviewCapabilities = () => ({
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    });
    (adapter as any).sendPreview = async (address: { chatId: string }, text: string, draftId: number) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      previewCreates.push(`${draftId}:${text}`);
      activePreviewByChat.set(address.chatId, text);
      return 'sent';
    };
    (adapter as any).send = async (message: OutboundMessage): Promise<SendResult> => {
      const activePreview = activePreviewByChat.get(message.address.chatId);
      if (activePreview) {
        finalizedInPlace.push(message.text || '');
        activePreviewByChat.delete(message.address.chatId);
        messageSeq += 1;
        return { ok: true, messageId: `preview-final-${messageSeq}` };
      }
      separateMessages.push(message.text || '');
      messageSeq += 1;
      return { ok: true, messageId: `sent-${messageSeq}` };
    };
    (adapter as any).endPreview = (address: { chatId: string }) => {
      activePreviewByChat.delete(address.chatId);
    };

    await start();
    adapter.push({
      messageId: 'msg-preview-race',
      address: { channelType: CHANNEL_TYPE, chatId: 'chat-preview-race', threadId: 'thread-1' },
      text: '继续',
      timestamp: Date.now(),
    });

    await waitFor(() => previewCreates.length === 1 && finalizedInPlace.length === 1);

    assert.deepEqual(separateMessages, []);
    assert.deepEqual(finalizedInPlace, [
      '需求是做一个仅包含单个 html 文件的简易自我介绍网页；当前还在 Plan Mode，我先检查仓库里的约束文件和现有目录结构。',
    ]);
    assert.equal(previewCreates.length, 1);
  });
});
