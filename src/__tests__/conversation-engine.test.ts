import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { initBridgeContext } from '../bridge/context.js';
import { processMessage } from '../bridge/conversation-engine.js';
import { sseEvent } from '../infra/sse-utils.js';
import { JsonFileStore } from '../infra/store.js';
import { CTI_HOME } from '../config/config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_feishu_enabled', 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
  ]);
}

describe('conversation-engine', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('renders codex native plan steps with label/description details without duplicating the intro text', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(sseEvent('text', '我会先查看项目约束。'));
            controller.enqueue(sseEvent('text_segment', '我会先查看项目约束。'));
            controller.enqueue(sseEvent('plan_state', {
              explanation: '先做一个可以直接执行的计划。',
              plan: [
                { label: '查看约束', description: '检查仓库约束与入口', status: 'completed' },
                { title: '生成 HTML', text: '输出单文件 HTML', status: 'pending' },
              ],
            }));
            controller.enqueue(sseEvent('plan_result', '1. 读取 CLAUDE.md\n2. 生成单文件 HTML'));
            controller.enqueue(sseEvent('result', { session_id: 'thread-1' }));
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
      channelType: 'feishu',
      chatId: 'group-segments',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const result = await processMessage(
      binding,
      '给我一个计划',
      undefined,
      undefined,
      undefined,
      undefined,
      { collaborationModeOverride: 'plan' },
    );

    assert.deepEqual(result.responseSegments, [
      '我会先查看项目约束。',
      '先做一个可以直接执行的计划。\n\n计划步骤\n1. 查看约束 [completed]\n    检查仓库约束与入口\n2. 生成 HTML [pending]\n    输出单文件 HTML\n\n1. 读取 CLAUDE.md\n2. 生成单文件 HTML',
    ]);
    assert.equal(
      result.responseText,
      '我会先查看项目约束。\n\n先做一个可以直接执行的计划。\n\n计划步骤\n1. 查看约束 [completed]\n    检查仓库约束与入口\n2. 生成 HTML [pending]\n    输出单文件 HTML\n\n1. 读取 CLAUDE.md\n2. 生成单文件 HTML',
    );
  });

  it('dedupes a codex native plan when both agent text and plan_result carry the same plan body', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(sseEvent('text_segment', '# 原生计划\n\n1. 先确认范围\n2. 再开始实施'));
            controller.enqueue(sseEvent('plan_result', '# 原生计划\n\n1. 先确认范围\n2. 再开始实施'));
            controller.enqueue(sseEvent('result', { session_id: 'thread-plan-dedupe' }));
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
      channelType: 'feishu',
      chatId: 'group-plan-dedupe',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const result = await processMessage(
      binding,
      '给我一个计划',
      undefined,
      undefined,
      undefined,
      undefined,
      { collaborationModeOverride: 'plan' },
    );

    assert.deepEqual(result.responseSegments, [
      '# 原生计划\n\n1. 先确认范围\n2. 再开始实施',
    ]);
    assert.equal(result.responseText, '# 原生计划\n\n1. 先确认范围\n2. 再开始实施');
  });

  it('merges a very short leading segment into the next segment before notifying the bridge', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(sseEvent('text', '我'));
            controller.enqueue(sseEvent('text_segment', '我'));
            controller.enqueue(sseEvent('text', '已经确认技术方案。'));
            controller.enqueue(sseEvent('text_segment', '已经确认技术方案。'));
            controller.enqueue(sseEvent('text', '接下来会直接生成文件。'));
            controller.enqueue(sseEvent('text_segment', '接下来会直接生成文件。'));
            controller.enqueue(sseEvent('result', { session_id: 'thread-2' }));
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
      channelType: 'feishu',
      chatId: 'group-segments-merge',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const seenSegments: string[] = [];
    const result = await processMessage(
      binding,
      '继续',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (segment) => {
        seenSegments.push(segment);
      },
    );

    assert.deepEqual(result.responseSegments, [
      '我已经确认技术方案。',
      '接下来会直接生成文件。',
    ]);
    assert.deepEqual(seenSegments, [
      '我已经确认技术方案。',
      '接下来会直接生成文件。',
    ]);
  });

  it('keeps a very short leading segment buffered across tool boundaries until the canonical completion arrives', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(sseEvent('text', '我'));
            controller.enqueue(sseEvent('tool_use', {
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'pwd', cwd: '/tmp/test-cwd' },
            }));
            controller.enqueue(sseEvent('tool_result', {
              tool_use_id: 'tool-1',
              content: '/tmp/test-cwd',
              is_error: false,
            }));
            controller.enqueue(sseEvent('text_segment', '我已经确认当前工作区根目录可直接放一个独立 html 文件。'));
            controller.enqueue(sseEvent('result', { session_id: 'thread-leading-boundary' }));
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
      channelType: 'feishu',
      chatId: 'group-leading-boundary',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const seenSegments: string[] = [];
    const result = await processMessage(
      binding,
      '继续',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (segment) => {
        seenSegments.push(segment);
      },
    );

    assert.deepEqual(result.responseSegments, [
      '我已经确认当前工作区根目录可直接放一个独立 html 文件。',
    ]);
    assert.deepEqual(seenSegments, [
      '我已经确认当前工作区根目录可直接放一个独立 html 文件。',
    ]);
  });

  it('dedupes completed text_segment when a tool boundary already flushed the same text', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            const text = '我会先看一下当前目录和仓库内的协作说明，然后直接把目标仓库 clone 到当前目录下。';
            controller.enqueue(sseEvent('text', text));
            controller.enqueue(sseEvent('tool_use', {
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'git clone ...', cwd: '/tmp/test-cwd' },
            }));
            controller.enqueue(sseEvent('tool_result', {
              tool_use_id: 'tool-1',
              content: 'cloning...',
              is_error: false,
            }));
            controller.enqueue(sseEvent('text_segment', text));
            controller.enqueue(sseEvent('result', { session_id: 'thread-dup-1' }));
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
      channelType: 'feishu',
      chatId: 'group-segments-dedupe',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const seenSegments: string[] = [];
    const result = await processMessage(
      binding,
      '继续',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (segment) => {
        seenSegments.push(segment);
      },
    );

    assert.deepEqual(result.responseSegments, [
      '我会先看一下当前目录和仓库内的协作说明，然后直接把目标仓库 clone 到当前目录下。',
    ]);
    assert.deepEqual(seenSegments, [
      '我会先看一下当前目录和仓库内的协作说明，然后直接把目标仓库 clone 到当前目录下。',
    ]);
  });

  it('forwards activity callbacks without mixing reasoning/tool status into assistant response segments', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(sseEvent('status', { reasoning: '正在搜索飞书文档…', turn_id: 'turn-activity-1' }));
            controller.enqueue(sseEvent('activity_event', {
              kind: 'command_execution',
              id: 'cmd-1',
              turnId: 'turn-activity-1',
              status: 'running',
              command: 'rg CardKit',
              cwd: '/tmp/test-cwd',
            }));
            controller.enqueue(sseEvent('tool_use', {
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'rg CardKit', cwd: '/tmp/test-cwd' },
            }));
            controller.enqueue(sseEvent('tool_result', {
              tool_use_id: 'tool-1',
              content: 'match found',
              is_error: false,
            }));
            controller.enqueue(sseEvent('text_segment', '我已经定位到相关文档和实现入口。'));
            controller.enqueue(sseEvent('result', { session_id: 'thread-activity-1' }));
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
      channelType: 'feishu',
      chatId: 'group-activity',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5.4',
    });

    const seenActivities: Array<Record<string, unknown>> = [];
    const result = await processMessage(
      binding,
      '继续',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (event) => {
        seenActivities.push(event as Record<string, unknown>);
      },
    );

    assert.deepEqual(result.responseSegments, ['我已经定位到相关文档和实现入口。']);
    assert.equal(result.responseText, '我已经定位到相关文档和实现入口。');
    assert.equal(seenActivities.length, 2);
    assert.deepEqual(
      seenActivities.map((event) => event.kind),
      ['lightweight_activity', 'command_execution'],
    );
    assert.equal(seenActivities[0].text, '正在思考…');
    assert.equal(seenActivities[1].command, 'rg CardKit');
  });
});
