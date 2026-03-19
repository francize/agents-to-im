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

    await waitFor(() => adapter.sent.length >= 1);
    assert.match(adapter.sent[0].text, /当前运行时请求补充信息/);
  });

  it('rotates preview drafts per segment and merges a one-character lead segment', async () => {
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
    (adapter as any).getPreviewCapabilities = () => ({ supported: true, privateOnly: false });
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
    assert.ok(previewEnds.length >= 2);
  });
});
