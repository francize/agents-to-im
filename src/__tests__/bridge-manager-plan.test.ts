import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { BaseChannelAdapter, registerAdapterFactory } from '../bridge/channel-adapter.js';
import { initBridgeContext } from '../bridge/context.js';
import { start, stop } from '../bridge/bridge-manager.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../bridge/types.js';
import { JsonFileStore } from '../store.js';
import { CTI_HOME } from '../config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const CHANNEL_TYPE = 'planstub';

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    [`bridge_${CHANNEL_TYPE}_enabled`, 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    ['bridge_default_mode', 'code'],
    ['bridge_default_runtime', 'claude'],
    ['bridge_default_model', 'claude-sonnet-4-6'],
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

  it('turns a plan_request synthetic message into a plan reply plus an action card', async () => {
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
    assert.equal(adapter.sent[1].cardHeader?.title, '计划已生成');
    assert.deepEqual(
      adapter.sent[1].inlineButtons?.[0].map((button) => button.callbackData),
      ['plan:execute:wf-1', 'plan:continue:wf-1', 'plan:cancel:wf-1'],
    );
    assert.equal(store.getPlanWorkflow('wf-1')?.status, 'awaiting_confirmation');
    assert.equal(store.getPlanWorkflow('wf-1')?.actionCardMessageId, 'sent-2');
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
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '# 原生计划\\n\\n1. 先确认范围\\n2. 再开始实施' })}\n`);
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
