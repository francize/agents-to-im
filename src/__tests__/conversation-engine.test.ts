import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { initBridgeContext } from '../bridge/context.js';
import { processMessage } from '../bridge/conversation-engine.js';
import { sseEvent } from '../sse-utils.js';
import { JsonFileStore } from '../store.js';
import { CTI_HOME } from '../config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_feishu_enabled', 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    ['bridge_default_mode', 'code'],
    ['bridge_default_runtime', 'codex'],
    ['bridge_codex_default_model', 'gpt-5.4'],
    ['default_model', 'gpt-5.4'],
  ]);
}

describe('conversation-engine', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('splits codex native output into response segments without duplicating the intro text', async () => {
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
              plan: [{ title: '查看约束', status: 'completed' }],
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
      '先做一个可以直接执行的计划。\n\n计划步骤\n1. 查看约束 [completed]\n\n1. 读取 CLAUDE.md\n2. 生成单文件 HTML',
    ]);
    assert.equal(
      result.responseText,
      '我会先查看项目约束。\n\n先做一个可以直接执行的计划。\n\n计划步骤\n1. 查看约束 [completed]\n\n1. 读取 CLAUDE.md\n2. 生成单文件 HTML',
    );
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
});
