import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CTI_HOME } from '../config/config.js';
import type { Config } from '../config/config.js';
import { MultiplexLLMProvider } from '../providers/multiplex.js';
import { PendingPermissions } from '../providers/claude/permission-gateway.js';
import { JsonFileStore } from '../infra/store.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_feishu_enabled', 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
  ]);
}

function makeConfig(): Config {
  return {
    defaultWorkDir: '/tmp',
    feishu: {
      id: 'default',
    },
  };
}

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

describe('MultiplexLLMProvider', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('routes streamChat by session runtime metadata', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
    });
    const provider = new MultiplexLLMProvider(store, new PendingPermissions(), makeConfig());

    let selectedRuntime = '';
    (provider as any).getProvider = async (runtime: string) => {
      selectedRuntime = runtime;
      return {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue('data: {"type":"text","data":"hello"}\n');
            controller.close();
          },
        }),
      };
    };

    const chunks = await collectStream(provider.streamChat({
      prompt: 'hi',
      sessionId: session.id,
    }));

    assert.equal(selectedRuntime, 'codex');
    assert.ok(chunks.join('').includes('"hello"'));
  });

  it('delegates readSessionTitle and writeSessionTitle to the runtime driver', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
    });
    const provider = new MultiplexLLMProvider(store, new PendingPermissions(), makeConfig());

    let wrote: { sessionId: string; title: string } | null = null;
    (provider as any).getDriver = () => ({
      readSessionTitle: async (sessionId: string) => {
        assert.equal(sessionId, session.id);
        return 'Refactor Plan';
      },
      writeSessionTitle: async (sessionId: string, title: string) => {
        wrote = { sessionId, title };
      },
    });

    const title = await provider.readSessionTitle(session.id);
    assert.equal(title, 'Refactor Plan');

    await provider.writeSessionTitle(session.id, '群聊标题');
    assert.deepEqual(wrote, {
      sessionId: session.id,
      title: '群聊标题',
    });
  });

  it('exposes runtime capability matrix without changing streamChat interface', () => {
    const store = new JsonFileStore(makeSettings());
    const claudeSession = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
    });
    const codexSession = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
    });
    const provider = new MultiplexLLMProvider(store, new PendingPermissions(), makeConfig());

    assert.deepEqual(provider.getSessionCapabilities(claudeSession.id), {
      nativePlanProtocol: false,
      askUserQuestion: true,
      structuredInput: true,
      approvalKinds: 'permission_callback',
      activityGranularity: 'basic',
      resumeKinds: ['sdkSessionId'],
      elicitation: true,
    });
    assert.deepEqual(provider.getSessionCapabilities(codexSession.id), {
      nativePlanProtocol: true,
      askUserQuestion: false,
      structuredInput: true,
      approvalKinds: 'rich',
      activityGranularity: 'rich',
      resumeKinds: ['sdkSessionId', 'runtimeThreadId'],
      elicitation: false,
    });
  });
});
