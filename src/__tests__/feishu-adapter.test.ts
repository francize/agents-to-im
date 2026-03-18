import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';

import { CTI_HOME } from '../config.js';
import { FeishuAdapter, findMissingAppScopes } from '../feishu/adapter.js';
import { PendingPermissions } from '../permission-gateway.js';
import { JsonFileStore } from '../store.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_feishu_enabled', 'true'],
    ['bridge_feishu_app_id', 'app-id'],
    ['bridge_feishu_app_secret', 'app-secret'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    ['bridge_default_mode', 'code'],
    ['bridge_default_runtime', 'claude'],
    ['bridge_claude_default_model', 'claude-sonnet-4-6'],
    ['bridge_codex_default_model', 'gpt-5-codex'],
  ]);
}

function installContext(store: JsonFileStore, llm: Record<string, unknown> = {}): void {
  initBridgeContext({
    store,
    llm: llm as any,
    permissions: {
      resolvePendingPermission: () => true,
    },
    lifecycle: {},
  });
}

describe('FeishuAdapter', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('creates a runtime-bound group session from /new:codex in DM', async () => {
    const store = new JsonFileStore(makeSettings());
    let ensuredRuntime = '';
    installContext(store, {
      ensureRuntimeAvailable: async (runtime: string) => {
        ensuredRuntime = runtime;
      },
    });

    const sends: Array<{ kind: string; chatId?: string }> = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          create: async () => ({ code: 0, data: { chat_id: 'chat-new' } }),
        },
        message: {
          create: async (payload: { data: { receive_id: string } }) => {
            sends.push({ kind: 'create', chatId: payload.data.receive_id });
            return { code: 0, data: { message_id: `msg-${sends.length}` } };
          },
          reply: async () => {
            sends.push({ kind: 'reply', chatId: 'dm-chat' });
            return { code: 0, data: { message_id: `reply-${sends.length}` } };
          },
        },
      },
    };

    await adapter.handleCreateSessionCommand(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'dm-msg',
        address: { channelType: 'feishu', chatId: 'dm-chat', userId: 'ou_123' },
        text: '/new:codex',
        timestamp: Date.now(),
      },
      'codex',
    );

    const binding = store.getChannelBinding('feishu', 'chat-new');
    assert.ok(binding);
    assert.equal(ensuredRuntime, 'codex');
    assert.deepEqual(store.getSessionExt(binding!.codepilotSessionId), {
      runtime: 'codex',
      titleStatus: 'pending',
    });
    assert.equal(sends.length, 2);
  });

  it('reset keeps runtime and clears persisted sdk session id', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/codex',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-1',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/codex',
      model: 'gpt-5-codex',
    });
    store.updateSdkSessionId(session.id, 'sdk-old');

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          create: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
          reply: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
        },
      },
    };

    await adapter.handleResetCommand('group-1', 'reply-1');

    const updated = store.getChannelBinding('feishu', 'group-1');
    assert.ok(updated);
    assert.notEqual(updated!.codepilotSessionId, binding.codepilotSessionId);
    assert.equal(updated!.mode, binding.mode);
    assert.equal(updated!.sdkSessionId, '');
    assert.deepEqual(store.getSessionExt(updated!.codepilotSessionId), {
      runtime: 'codex',
      titleStatus: 'pending',
    });
  });

  it('reuses the preview message when finalizing a patch-based stream', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-2',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    let replyCalls = 0;
    let patchCalls = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.lastIncomingMessageId.set('group-2', 'incoming-1');
    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => {
              throw new Error('cardkit unavailable');
            },
          },
        },
      },
      im: {
        message: {
          reply: async () => {
            replyCalls += 1;
            return { code: 0, data: { message_id: 'preview-msg' } };
          },
          create: async () => {
            throw new Error('unexpected create');
          },
          patch: async () => {
            patchCalls += 1;
            return { code: 0, data: {} };
          },
        },
      },
    };

    const previewResult = await adapter.sendPreview('group-2', 'partial', 42);
    const finalResult = await adapter.send({
      address: { channelType: 'feishu', chatId: 'group-2' },
      text: 'final answer',
      parseMode: 'Markdown',
    });

    assert.equal(previewResult, 'sent');
    assert.equal(finalResult.ok, true);
    assert.equal(finalResult.messageId, 'preview-msg');
    assert.equal(replyCalls, 1);
    assert.equal(patchCalls, 2);
  });

  it('reports missing app scopes against the Feishu feature baseline', () => {
    const missing = findMissingAppScopes([
      'im:message:send_as_bot',
      'im:message:readonly',
      'im:message.p2p_msg:readonly',
      'im:message.group_at_msg:readonly',
      'im:message:update',
      'im:message.reactions:read',
      'im:message.reactions:write_only',
      'im:chat:read',
      'im:resource',
      'cardkit:card:write',
      'cardkit:card:read',
    ]);

    assert.deepEqual(missing, ['im:chat:update']);
  });
});
