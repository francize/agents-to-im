import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { initBridgeContext } from '../bridge/context.js';
import { forwardPermissionRequest } from '../bridge/permission-broker.js';
import {
  CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE,
  buildClaudePlanModeUpdates,
} from '../runtime/claude-plan-exit.js';

import { CTI_HOME } from '../config/config.js';
import type { Config } from '../config/config.js';
import { FeishuAdapter, findMissingAppScopes } from '../feishu/adapter.js';
import { JsonFileStore } from '../infra/store.js';
import { MultiplexLLMProvider } from '../providers/multiplex.js';
import { PendingPermissions } from '../providers/claude/permission-gateway.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_feishu_enabled', 'true'],
    ['bridge_feishu_app_id', 'app-id'],
    ['bridge_feishu_app_secret', 'app-secret'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    ['bridge_feishu_allowed_users', '*'],
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

function installContext(store: JsonFileStore, llm: unknown = {}): void {
  initBridgeContext({
    store,
    llm: llm as any,
    permissions: {
      resolvePendingPermission: () => true,
    },
    lifecycle: {},
  });
}

function writeJsonlFile(filePath: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n'));
}

describe('FeishuAdapter', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('validates explicit profile config before bridge context is initialized', () => {
    const adapter = new FeishuAdapter({
      profile: {
        id: 'profile-codex',
        appId: 'app-id',
        appSecret: 'app-secret',
      },
    });

    assert.equal(adapter.validateConfig(), null);
  });

  describe('isAuthorized', () => {
    it('rejects everyone when allowlist is empty (secure default)', () => {
      const store = new JsonFileStore(new Map([
        ['bridge_feishu_app_id', 'app-id'],
        ['bridge_feishu_app_secret', 'app-secret'],
      ]));
      installContext(store);
      const adapter = new FeishuAdapter();
      assert.equal(adapter.isAuthorized('ou_anyone', 'chat-1'), false);
    });

    it('allows everyone only when allowlist is exactly the single wildcard "*"', () => {
      const store = new JsonFileStore(new Map([
        ['bridge_feishu_app_id', 'app-id'],
        ['bridge_feishu_app_secret', 'app-secret'],
        ['bridge_feishu_allowed_users', '*'],
      ]));
      installContext(store);
      const adapter = new FeishuAdapter();
      assert.equal(adapter.isAuthorized('ou_anyone', 'chat-1'), true);
      assert.equal(adapter.isAuthorized('ou_other', 'chat-2'), true);
    });

    it('matches exact open_id when allowlist contains specific ids', () => {
      const store = new JsonFileStore(new Map([
        ['bridge_feishu_app_id', 'app-id'],
        ['bridge_feishu_app_secret', 'app-secret'],
        ['bridge_feishu_allowed_users', 'ou_alice, ou_bob'],
      ]));
      installContext(store);
      const adapter = new FeishuAdapter();
      assert.equal(adapter.isAuthorized('ou_alice', 'chat-1'), true);
      assert.equal(adapter.isAuthorized('ou_bob', 'chat-1'), true);
      assert.equal(adapter.isAuthorized('ou_eve', 'chat-1'), false);
    });

    it('does not treat "*" as wildcard when mixed with specific ids', () => {
      // 防止用户写成 ['*', 'ou_alice'] 后产生歧义。明确语义：
      // 只要列表不是单独一个 '*'，就按精确匹配处理，'*' 字面量不会命中真实 user_id。
      const store = new JsonFileStore(new Map([
        ['bridge_feishu_app_id', 'app-id'],
        ['bridge_feishu_app_secret', 'app-secret'],
        ['bridge_feishu_allowed_users', '*, ou_alice'],
      ]));
      installContext(store);
      const adapter = new FeishuAdapter();
      assert.equal(adapter.isAuthorized('ou_alice', 'chat-1'), true);
      assert.equal(adapter.isAuthorized('ou_anyone_else', 'chat-1'), false);
    });
  });

  it('sends a Claude new-session card with workspace select and existing mode buttons from /new:claude in DM', async () => {
    const store = new JsonFileStore(makeSettings());
    let ensuredRuntime = '';
    installContext(store, {
      ensureRuntimeAvailable: async (runtime: string) => {
        ensuredRuntime = runtime;
      },
    });

    let chatCreateCalls = 0;
    const replies: Array<{ msgType: string; content: string }> = [];
    const adapter = new FeishuAdapter({
      profile: {
        id: 'default',
        showToolCallCards: true,
      },
    }) as any;
    adapter.restClient = {
      im: {
        chat: {
          create: async () => {
            chatCreateCalls += 1;
            return { code: 0, data: { chat_id: 'unexpected-chat' } };
          },
        },
        message: {
          reply: async (payload: { data: { msg_type: string; content: string } }) => {
            replies.push({ msgType: payload.data.msg_type, content: payload.data.content });
            return { code: 0, data: { message_id: 'reply-1', open_message_id: 'open-reply-1' } };
          },
          create: async () => {
            throw new Error('unexpected create');
          },
        },
      },
    };

    await adapter.handleCreateSessionCommand(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'dm-msg',
        address: { channelType: 'feishu', chatId: 'dm-chat', userId: 'ou_123' },
        text: '/new:claude',
        timestamp: Date.now(),
      },
      'claude',
    );

    assert.equal(ensuredRuntime, 'claude');
    assert.equal(chatCreateCalls, 0);
    assert.equal(store.listChannelBindings().length, 0);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].msgType, 'interactive');
    const card = JSON.parse(replies[0].content);
    assert.equal(card.body.elements[0].tag, 'form');
    assert.equal(card.body.elements[0].elements[2].tag, 'select_static');
    assert.equal(card.body.elements[0].elements[2].name, 'new_session_workdir');
    const buttons = card.body.elements[0].elements[3].columns.map((column: any) => column.elements[0]);
    const titles = buttons.map((button: any) => button.text.content);
    assert.deepEqual(titles, ['Default', 'Plan Mode', 'Accept edits', 'Bypass Permissions', "Don't Ask"]);
    assert.ok(buttons.every((button: any) => typeof button.name === 'string' && button.name.length > 0));
  });

  it('sends a Codex new-session card with workspace select and mode buttons from /new:codex in DM', async () => {
    const store = new JsonFileStore(makeSettings());
    let ensuredRuntime = '';
    installContext(store, {
      ensureRuntimeAvailable: async (runtime: string) => {
        ensuredRuntime = runtime;
      },
    });

    let chatCreateCalls = 0;
    const replies: Array<{ msgType: string; content: string }> = [];
    const adapter = new FeishuAdapter({
      profile: {
        id: 'default',
        showToolCallCards: true,
      },
    }) as any;
    adapter.restClient = {
      im: {
        chat: {
          create: async () => {
            chatCreateCalls += 1;
            return { code: 0, data: { chat_id: 'chat-new' } };
          },
        },
        message: {
          reply: async (payload: { data: { msg_type: string; content: string } }) => {
            replies.push({ msgType: payload.data.msg_type, content: payload.data.content });
            return { code: 0, data: { message_id: 'reply-1', open_message_id: 'open-reply-1' } };
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

    assert.equal(ensuredRuntime, 'codex');
    assert.equal(chatCreateCalls, 0);
    assert.equal(store.listChannelBindings().length, 0);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].msgType, 'interactive');
    const card = JSON.parse(replies[0].content);
    assert.equal(card.body.elements[0].tag, 'form');
    assert.equal(card.body.elements[0].elements[2].tag, 'select_static');
    assert.equal(card.body.elements[0].elements[2].name, 'new_session_workdir');
    const buttons = card.body.elements[0].elements[3].columns.map((column: any) => column.elements[0]);
    const titles = buttons.map((button: any) => button.text.content);
    assert.deepEqual(titles, ['默认', 'Plan']);
    assert.deepEqual(buttons.map((button: any) => button.name), ['new_session_codex_code', 'new_session_codex_plan']);
  });

  it('creates a Codex plan session from the new-session card using the selected workspace', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {
      ensureRuntimeAvailable: async () => {},
    });

    let patchCalls = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          create: async () => ({ code: 0, data: { chat_id: 'chat-codex-plan' } }),
        },
        message: {
          create: async () => ({ code: 0, data: { message_id: 'group-msg-1' } }),
          patch: async () => {
            patchCalls += 1;
            return { code: 0, data: {} };
          },
        },
      },
    };

    const result = await adapter.handleCardAction({
      open_id: 'ou_123',
      tenant_key: 'tenant',
      token: 'token',
      open_message_id: 'open-card-1',
      operator: { open_id: 'ou_123' },
      action: {
        tag: 'button',
        value: {
          callback_data: 'new-session:codex:plan',
        },
        form_value: {
          new_session_workdir: '/tmp/codex-plan',
        },
      },
    });

    const binding = store.getChannelBinding('feishu', 'chat-codex-plan');
    assert.equal(result.toast.type, 'success');
    assert.ok(binding);
    assert.equal(binding!.workingDirectory, '/tmp/codex-plan');
    assert.equal(binding!.mode, 'plan');
    assert.equal(store.getSessionExt(binding!.codepilotSessionId)?.runtime, 'codex');
    assert.equal(patchCalls, 1);
  });

  it('creates a Claude session from the mode card using the selected workspace', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {
      ensureRuntimeAvailable: async () => {},
    });

    let patchCalls = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          create: async () => ({ code: 0, data: { chat_id: 'chat-claude-default' } }),
        },
        message: {
          create: async () => ({ code: 0, data: { message_id: 'group-msg-1' } }),
          patch: async () => {
            patchCalls += 1;
            return { code: 0, data: {} };
          },
        },
      },
    };

    const result = await adapter.handleCardAction({
      open_id: 'ou_123',
      tenant_key: 'tenant',
      token: 'token',
      open_message_id: 'open-card-2',
      operator: { open_id: 'ou_123' },
      action: {
        tag: 'button',
        value: {
          callback_data: 'claude-mode:new:default',
        },
        form_value: {
          new_session_workdir: '/tmp/claude-default',
        },
      },
    });

    const binding = store.getChannelBinding('feishu', 'chat-claude-default');
    assert.equal(result.toast.type, 'success');
    assert.ok(binding);
    assert.equal(binding!.workingDirectory, '/tmp/claude-default');
    assert.equal(binding!.mode, 'code');
    assert.equal(binding!.claudePermissionMode, 'default');
    assert.equal(store.getSessionExt(binding!.codepilotSessionId)?.runtime, 'claude');
    assert.equal(patchCalls, 1);
  });

  it('lists recent codex native sessions from /resume:codex in DM', async () => {
    const tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-resume-codex-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempCodexHome;
    const store = new JsonFileStore(makeSettings());
    installContext(store, {
      ensureRuntimeAvailable: async () => {},
    });

    try {
      fs.mkdirSync(path.join(tempCodexHome, 'sessions', '2026', '03', '28'), { recursive: true });
      fs.writeFileSync(
        path.join(tempCodexHome, 'session_index.jsonl'),
        JSON.stringify({
          id: 'resume-codex-1',
          thread_name: '恢复测试会话',
          updated_at: '2026-03-28T09:00:00.000Z',
        }),
      );
      writeJsonlFile(
        path.join(tempCodexHome, 'sessions', '2026', '03', '28', 'rollout-2026-03-28-resume-codex-1.jsonl'),
        [
          { type: 'session_meta', payload: { id: 'resume-codex-1', cwd: '/tmp/test-cwd' } },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '请恢复这个会话' }],
            },
          },
        ],
      );

      const replies: Array<{ msgType: string; content: string }> = [];
      const adapter = new FeishuAdapter() as any;
      adapter.restClient = {
        im: {
          message: {
            reply: async (payload: { data: { msg_type: string; content: string } }) => {
              replies.push({ msgType: payload.data.msg_type, content: payload.data.content });
              return { code: 0, data: { message_id: 'reply-1', open_message_id: 'open-reply-1' } };
            },
          },
        },
      };

      await adapter.handleDirectMessage(
        { id: 'ou_123', type: 'open_id' },
        {
          messageId: 'dm-msg',
          address: { channelType: 'feishu', chatId: 'dm-chat', userId: 'ou_123' },
          text: '/resume:codex',
          timestamp: Date.now(),
        },
      );

      assert.equal(replies.length, 1);
      assert.equal(replies[0].msgType, 'interactive');
      const card = JSON.parse(replies[0].content);
      assert.equal(card.header.title.content, '恢复 Codex 会话');
      assert.match(card.body.elements[1].columns[0].elements[0].content, /恢复测试会话/);
      assert.equal(
        card.body.elements[1].columns[1].elements[0].behaviors[0].value.callback_data,
        'resume:pick:codex:resume-codex-1',
      );
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(tempCodexHome, { recursive: true, force: true });
    }
  });

  it('replays codex native history into a new group without storing imported transcript locally', async () => {
    const tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-resume-action-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempCodexHome;
    const store = new JsonFileStore(makeSettings());
    installContext(store, {
      ensureRuntimeAvailable: async () => {},
    });

    try {
      fs.mkdirSync(path.join(tempCodexHome, 'sessions', '2026', '03', '28'), { recursive: true });
      fs.writeFileSync(
        path.join(tempCodexHome, 'session_index.jsonl'),
        JSON.stringify({
          id: 'resume-codex-2',
          thread_name: '恢复并回放',
          updated_at: '2026-03-28T10:00:00.000Z',
        }),
      );
      writeJsonlFile(
        path.join(tempCodexHome, 'sessions', '2026', '03', '28', 'rollout-2026-03-28-resume-codex-2.jsonl'),
        [
          { type: 'session_meta', payload: { id: 'resume-codex-2', cwd: '/tmp/test-cwd' } },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '第一条用户消息' }],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '第一条模型消息' }],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'function_call',
              call_id: 'call-1',
              name: 'shell_command',
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call-1',
              output: 'Output from tool',
            },
          },
        ],
      );

      const creates: Array<{ msgType: string; content: string; receiveId: string }> = [];
      let patchCalls = 0;
      const adapter = new FeishuAdapter() as any;
      adapter.restClient = {
        im: {
          chat: {
            create: async () => ({ code: 0, data: { chat_id: 'chat-resume-codex' } }),
          },
          message: {
            create: async (payload: { data: { msg_type: string; content: string; receive_id: string } }) => {
              creates.push({
                msgType: payload.data.msg_type,
                content: payload.data.content,
                receiveId: payload.data.receive_id,
              });
              return { code: 0, data: { message_id: `msg-${creates.length}` } };
            },
            patch: async () => {
              patchCalls += 1;
              return { code: 0, data: {} };
            },
          },
        },
      };

      const result = await adapter.handleCardAction({
        open_id: 'ou_123',
        tenant_key: 'tenant',
        token: 'token',
        open_message_id: 'open-resume-1',
        operator: { open_id: 'ou_123' },
        action: {
          tag: 'button',
          value: {
            callback_data: 'resume:pick:codex:resume-codex-2',
          },
        },
      });

      const binding = store.getChannelBinding('feishu', 'chat-resume-codex');
      assert.equal(result.toast.type, 'success');
      assert.ok(binding);
      assert.equal(store.getSessionSdkSessionId(binding!.codepilotSessionId), 'resume-codex-2');
      assert.equal(store.getSessionExt(binding!.codepilotSessionId)?.codexThreadId, 'resume-codex-2');
      assert.equal(store.getSessionExt(binding!.codepilotSessionId)?.title, '恢复并回放');
      assert.equal(store.getSessionExt(binding!.codepilotSessionId)?.displayNameMode, 'native_locked');
      assert.deepEqual(store.getMessages(binding!.codepilotSessionId).messages, []);
      assert.equal(creates.length, 4);
      assert.deepEqual(
        creates.map((item) => item.msgType),
        ['interactive', 'interactive', 'interactive', 'post'],
      );
      const replayCards = creates.slice(0, 3).map((item) => JSON.parse(item.content));
      assert.equal(replayCards[0].header, undefined);
      assert.equal(replayCards[0].body.elements[0].content, '**用户**\n\n第一条用户消息');
      assert.equal(replayCards[1].body.elements[0].content, '**Codex**\n\n第一条模型消息');
      assert.equal(replayCards[2].body.elements[0].content, '**工具结果 · shell_command**\n\nOutput from tool');
      assert.equal(patchCalls, 1);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(tempCodexHome, { recursive: true, force: true });
    }
  });

  it('does not advertise /perm in group-ready messages', () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});

    const claudeSession = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const claudeBinding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-claude',
      codepilotSessionId: claudeSession.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
      claudePermissionMode: 'plan',
    });

    const codexSession = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    const codexBinding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-codex',
      codepilotSessionId: codexSession.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    const adapter = new FeishuAdapter() as any;
    const claudeMessage = adapter.buildSessionReadyMessage('claude', claudeBinding);
    const codexMessage = adapter.buildSessionReadyMessage('codex', codexBinding);

    assert.equal(claudeMessage.includes('/perm'), false);
    assert.equal(codexMessage.includes('/perm'), false);
    assert.equal(claudeMessage.includes('/stop'), true);
    assert.equal(codexMessage.includes('/stop'), true);
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

    await adapter.handleResetCommand({ channelType: 'feishu', chatId: 'group-1' }, 'reply-1');

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

  it('syncs the group name from the native codex thread title', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.updateCodexThreadId(session.id, 'thread-title-sync');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-title-sync',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    const readCalls: string[] = [];
    installContext(store, {
      readSessionTitle: async (sessionId: string) => {
        readCalls.push(sessionId);
        return 'Codex 原生标题';
      },
    });

    const chatUpdates: Array<{ data: { name: string } }> = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async (payload: { data: { name: string } }) => {
            chatUpdates.push(payload);
            return { code: 0, data: {} };
          },
        },
      },
    };

    await adapter.maybeSyncSessionTitle('group-title-sync');

    assert.deepEqual(readCalls, [session.id]);
    assert.equal(chatUpdates.length, 1);
    assert.equal(chatUpdates[0].data.name, 'Codex 原生标题');
    assert.deepEqual(store.getSessionExt(session.id), {
      runtime: 'codex',
      codexThreadId: 'thread-title-sync',
      title: 'Codex 原生标题',
      titleStatus: 'done',
      displayNameMode: 'default',
    });
  });

  it('leaves the default group name unchanged when the codex thread has no native title', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.updateCodexThreadId(session.id, 'thread-empty-title');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-empty-native-title',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });
    installContext(store, {
      readSessionTitle: async () => null,
    });

    let chatUpdateCalls = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => {
            chatUpdateCalls += 1;
            return { code: 0, data: {} };
          },
        },
      },
    };

    await adapter.maybeSyncSessionTitle('group-empty-native-title');

    assert.equal(chatUpdateCalls, 0);
    assert.deepEqual(store.getSessionExt(session.id), {
      runtime: 'codex',
      codexThreadId: 'thread-empty-title',
      titleStatus: 'pending',
    });
  });

  it('treats a manual Feishu rename as authoritative and syncs it back to codex', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.updateCodexThreadId(session.id, 'thread-manual-codex');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-manual-codex',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    const writes: Array<{ sessionId: string; title: string }> = [];
    installContext(store, {
      writeSessionTitle: async (sessionId: string, title: string) => {
        writes.push({ sessionId, title });
      },
    });

    const adapter = new FeishuAdapter() as any;
    await adapter.handleChatUpdatedEvent({
      chat_id: 'group-manual-codex',
      before_change: { name: 'Codex 新会话' },
      after_change: { name: '人工改名' },
    });

    assert.deepEqual(writes, [{ sessionId: session.id, title: '人工改名' }]);
    assert.deepEqual(store.getSessionExt(session.id), {
      runtime: 'codex',
      codexThreadId: 'thread-manual-codex',
      title: '人工改名',
      titleStatus: 'done',
      displayNameMode: 'manual_locked',
    });
  });

  it('appends a custom-title entry when a manual Feishu rename targets a claude session', async () => {
    const tempClaudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-feishu-claude-title-'));
    const previousClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = tempClaudeHome;

    try {
      const workdir = '/tmp/claude-manual-title';
      const sessionFile = path.join(
        tempClaudeHome,
        'projects',
        '-tmp-claude-manual-title',
        'claude-session-manual.jsonl',
      );
      writeJsonlFile(sessionFile, [
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '请同步 Claude 标题' }],
          },
        },
      ]);

      const store = new JsonFileStore(makeSettings());
      const session = store.createRuntimeSession({
        runtime: 'claude',
        model: 'claude-sonnet-4-6',
        cwd: workdir,
      });
      store.updateSdkSessionId(session.id, 'claude-session-manual');
      store.upsertChannelBinding({
        channelType: 'feishu',
        chatId: 'group-manual-claude',
        codepilotSessionId: session.id,
        workingDirectory: workdir,
        model: 'claude-sonnet-4-6',
      });
      installContext(
        store,
        new MultiplexLLMProvider(store, new PendingPermissions(), makeConfig()),
      );

      const adapter = new FeishuAdapter() as any;
      await adapter.handleChatUpdatedEvent({
        chat_id: 'group-manual-claude',
        before_change: { name: 'Claude 新会话' },
        after_change: { name: '用户手动改名' },
      });

      const raw = fs.readFileSync(sessionFile, 'utf8');
      assert.match(raw, /"type":"custom-title"/);
      assert.match(raw, /"customTitle":"用户手动改名"/);
      assert.equal(store.getSessionExt(session.id)?.displayNameMode, 'manual_locked');
    } finally {
      process.env.CLAUDE_HOME = previousClaudeHome;
      fs.rmSync(tempClaudeHome, { recursive: true, force: true });
    }
  });

  it('defers manual title propagation until the runtime thread id is available', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-deferred-title',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    const writes: Array<{ sessionId: string; title: string; threadId: string }> = [];
    installContext(store, {
      readSessionTitle: async () => null,
      writeSessionTitle: async (sessionId: string, title: string) => {
        const threadId = store.getSessionExt(sessionId)?.codexThreadId || store.getSessionSdkSessionId(sessionId);
        if (!threadId) return;
        writes.push({ sessionId, title, threadId });
      },
    });

    const adapter = new FeishuAdapter() as any;
    await adapter.handleChatUpdatedEvent({
      chat_id: 'group-deferred-title',
      before_change: { name: 'Codex 新会话' },
      after_change: { name: '延后同步标题' },
    });
    assert.equal(writes.length, 0);

    store.updateCodexThreadId(session.id, 'thread-deferred-1');
    await adapter.maybeSyncSessionTitle('group-deferred-title');

    assert.deepEqual(writes, [{
      sessionId: session.id,
      title: '延后同步标题',
      threadId: 'thread-deferred-1',
    }]);
  });

  it('ignores im.chat.updated_v1 echoes generated by bridge-driven renames', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-rename-echo',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });
    store.updateSessionExt(session.id, {
      title: '桥接同步标题',
      titleStatus: 'done',
      displayNameMode: 'default',
    });
    installContext(store, {
      writeSessionTitle: async () => {
        throw new Error('manual rename sync should be suppressed for self echoes');
      },
    });

    let chatUpdateCalls = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => {
            chatUpdateCalls += 1;
            return { code: 0, data: {} };
          },
        },
      },
    };

    await adapter.syncChatName('group-rename-echo');
    await adapter.handleChatUpdatedEvent({
      chat_id: 'group-rename-echo',
      before_change: { name: 'Codex 新会话' },
      after_change: { name: '桥接同步标题' },
    });

    assert.equal(chatUpdateCalls, 1);
    assert.equal(store.getSessionExt(session.id)?.displayNameMode, 'default');
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
    adapter.lastIncomingMessageId.set('group-2:main', 'incoming-1');
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

    const previewResult = await adapter.sendPreview({ channelType: 'feishu', chatId: 'group-2' }, 'partial', 42);
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

  it('finalizes a CardKit preview in place without sending a second reply', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-cardkit',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    let createCalls = 0;
    let replyCalls = 0;
    let streamCalls = 0;
    let updateCalls = 0;
    let settingsCalls = 0;
    let finalSettings = '';
    const adapter = new FeishuAdapter() as any;
    adapter.lastIncomingMessageId.set('group-cardkit:main', 'incoming-1');
    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => {
              createCalls += 1;
              return { code: 0, data: { card_id: 'card-1' } };
            },
            update: async () => {
              updateCalls += 1;
              return { code: 0, data: {} };
            },
            settings: async (payload: { data: { settings: string } }) => {
              settingsCalls += 1;
              finalSettings = payload.data.settings;
              return { code: 0, data: {} };
            },
          },
          cardElement: {
            content: async () => {
              streamCalls += 1;
              return { code: 0, data: {} };
            },
          },
        },
      },
      im: {
        message: {
          reply: async () => {
            replyCalls += 1;
            return { code: 0, data: { message_id: 'preview-card-msg' } };
          },
          create: async () => {
            throw new Error('unexpected create');
          },
          patch: async () => {
            throw new Error('unexpected patch');
          },
        },
      },
    };

    const previewResult = await adapter.sendPreview({ channelType: 'feishu', chatId: 'group-cardkit' }, 'partial', 99);
    const finalResult = await adapter.send({
      address: { channelType: 'feishu', chatId: 'group-cardkit' },
      text: 'final answer',
      parseMode: 'Markdown',
    });

    assert.equal(previewResult, 'sent');
    assert.equal(finalResult.ok, true);
    assert.equal(finalResult.messageId, 'preview-card-msg');
    assert.equal(createCalls, 1);
    assert.equal(replyCalls, 1);
    assert.equal(streamCalls, 1);
    assert.equal(updateCalls, 1);
    assert.equal(settingsCalls, 1);
    assert.equal(JSON.parse(finalSettings).streaming_mode, false);
  });

  it('primes an empty CardKit preview and reuses it for the next streamed update', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-cardkit-prime',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    let createCalls = 0;
    let replyCalls = 0;
    let streamCalls = 0;
    let createdCardPayload = '';
    const adapter = new FeishuAdapter() as any;
    adapter.lastIncomingMessageId.set('group-cardkit-prime:main', 'incoming-1');
    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async (payload: { data: { data: string } }) => {
              createCalls += 1;
              createdCardPayload = payload.data.data;
              return { code: 0, data: { card_id: 'card-prime-1' } };
            },
          },
          cardElement: {
            content: async () => {
              streamCalls += 1;
              return { code: 0, data: {} };
            },
          },
        },
      },
      im: {
        message: {
          reply: async () => {
            replyCalls += 1;
            return { code: 0, data: { message_id: 'preview-prime-msg' } };
          },
          create: async () => {
            throw new Error('unexpected create');
          },
          patch: async () => {
            throw new Error('unexpected patch');
          },
        },
      },
    };

    const primeResult = await adapter.primePreview({ channelType: 'feishu', chatId: 'group-cardkit-prime' }, 77);
    const previewResult = await adapter.sendPreview({ channelType: 'feishu', chatId: 'group-cardkit-prime' }, 'partial', 77);

    assert.equal(primeResult, 'sent');
    assert.equal(previewResult, 'sent');
    assert.equal(createCalls, 1);
    assert.equal(replyCalls, 1);
    assert.equal(streamCalls, 1);
    assert.match(createdCardPayload, /🤖 努力回答中\.\.\./);
  });

  it('deletes a prime-only preview placeholder when the preview ends without real text', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});

    let deleteCalls = 0;
    let deletedMessageId = '';
    const adapter = new FeishuAdapter() as any;
    adapter.previewArtifacts.set('group-cardkit-prime:main:77', {
      key: 'group-cardkit-prime:main:77',
      routeKey: 'group-cardkit-prime:main',
      chatId: 'group-cardkit-prime',
      draftId: 77,
      messageId: 'preview-prime-msg',
      lastText: '',
      sequence: 0,
      mode: 'cardkit',
    });
    adapter.activePreviewByRoute.set('group-cardkit-prime:main', 'group-cardkit-prime:main:77');
    adapter.restClient = {
      im: {
        message: {
          delete: async (payload: { path: { message_id: string } }) => {
            deleteCalls += 1;
            deletedMessageId = payload.path.message_id;
            return { code: 0, data: {} };
          },
        },
      },
    };

    adapter.endPreview({ channelType: 'feishu', chatId: 'group-cardkit-prime' }, 77);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(deleteCalls, 1);
    assert.equal(deletedMessageId, 'preview-prime-msg');
    assert.equal(adapter.previewArtifacts.size, 0);
    assert.equal(adapter.activePreviewByRoute.size, 0);
  });

  it('upserts the latest lightweight activity card in place on the same message', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});

    const sentPayloads: string[] = [];
    const patchedPayloads: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.lastIncomingMessageId.set('group-activity:main', 'incoming-1');
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string } }) => {
            sentPayloads.push(payload.data.content);
            return { code: 0, data: { message_id: 'activity-msg-1', open_message_id: 'open-activity-1' } };
          },
          patch: async (payload: { data: { content: string } }) => {
            patchedPayloads.push(payload.data.content);
            return { code: 0, data: {} };
          },
        },
      },
    };

    const first = await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity' },
      {
        kind: 'lightweight_activity',
        id: 'lightweight-slot:turn-1',
        turnId: 'turn-1',
        status: 'running',
        text: '正在搜索网页…',
      },
    );
    const second = await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity' },
      {
        kind: 'lightweight_activity',
        id: 'lightweight-slot:turn-1',
        turnId: 'turn-1',
        status: 'completed',
        text: '已搜索网页 (https://open.feishu.cn/...)',
      },
    );

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(sentPayloads.length, 1);
    assert.equal(patchedPayloads.length, 1);
    assert.match(sentPayloads[0], /🤖 正在搜索网页/);
    assert.match(patchedPayloads[0], /🤖 已搜索网页/);
  });

  it('recovers an activity card after a gateway timeout by reusing the same UUID and patching the original message', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});

    const replyUuids: string[] = [];
    const replyPayloads: string[] = [];
    const patchedPayloads: string[] = [];
    let firstAttempt = true;
    const adapter = new FeishuAdapter({
      profile: {
        id: 'default',
        showToolCallCards: true,
      },
    }) as any;
    adapter.lastIncomingMessageId.set('group-activity-timeout:main', 'incoming-timeout-1');
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string; uuid: string } }) => {
            replyUuids.push(payload.data.uuid);
            replyPayloads.push(payload.data.content);
            if (firstAttempt) {
              firstAttempt = false;
              throw new Error('Request failed with status code 504');
            }
            return { code: 0, data: { message_id: 'activity-timeout-msg-1', open_message_id: 'open-timeout-1' } };
          },
          patch: async (payload: { data: { content: string } }) => {
            patchedPayloads.push(payload.data.content);
            return { code: 0, data: {} };
          },
        },
      },
    };

    const running = await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-timeout' },
      {
        kind: 'command_execution',
        id: 'command:turn-timeout:cmd-1',
        turnId: 'turn-timeout',
        status: 'running',
        command: 'sed -n 1,220p /Users/shesong/codes/index.html',
        cwd: '/Users/shesong/codes',
      },
    );
    const completed = await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-timeout' },
      {
        kind: 'command_execution',
        id: 'command:turn-timeout:cmd-1',
        turnId: 'turn-timeout',
        status: 'completed',
        command: 'sed -n 1,220p /Users/shesong/codes/index.html',
        cwd: '/Users/shesong/codes',
        output: '<html lang=\"en\">',
        exitCode: 0,
      },
    );

    assert.equal(running.ok, false);
    assert.equal(completed.ok, true);
    assert.equal(replyUuids.length, 2);
    assert.equal(replyUuids[0], replyUuids[1]);
    assert.equal(replyPayloads.length, 2);
    assert.equal(patchedPayloads.length, 1);
    assert.match(replyPayloads[0], /执行命令/);
    assert.match(replyPayloads[0], /进行中/);
    assert.match(replyPayloads[1], /已完成/);
    assert.match(patchedPayloads[0], /已完成/);
  });

  it('uploads a local image and sends it as a native Feishu image reply', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const tempImagePath = path.join(DATA_DIR, 'auto-image-send.png');
    fs.mkdirSync(path.dirname(tempImagePath), { recursive: true });
    fs.writeFileSync(tempImagePath, 'not-a-real-png-but-good-enough');

    const uploadPayloads: Array<Record<string, unknown>> = [];
    const replyPayloads: Array<Record<string, unknown>> = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        image: {
          create: async (payload: Record<string, unknown>) => {
            uploadPayloads.push(payload);
            return { image_key: 'img_v2_test_1' };
          },
        },
        message: {
          reply: async (payload: Record<string, unknown>) => {
            replyPayloads.push(payload);
            return { code: 0, data: { message_id: 'img-msg-1', open_message_id: 'open-img-msg-1' } };
          },
        },
      },
    };

    const result = await adapter.sendImage({
      address: { channelType: 'feishu', chatId: 'group-image', threadId: 'thread-image-1' },
      filePath: tempImagePath,
      replyToMessageId: 'incoming-1',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageId, 'img-msg-1');
    assert.equal(uploadPayloads.length, 1);
    assert.equal((uploadPayloads[0].data as { image_type?: string }).image_type, 'message');
    assert.equal(replyPayloads.length, 1);
    assert.equal((replyPayloads[0].path as { message_id?: string }).message_id, 'incoming-1');
    const replyData = replyPayloads[0].data as { msg_type?: string; content?: string; reply_in_thread?: boolean };
    assert.equal(replyData.msg_type, 'image');
    assert.equal(replyData.reply_in_thread, true);
    assert.match(replyData.content || '', /img_v2_test_1/);
  });

  it('returns a failed SendResult when sendImage is called without a Feishu client', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const adapter = new FeishuAdapter();

    const result = await adapter.sendImage({
      address: { channelType: 'feishu', chatId: 'group-image' },
      filePath: '/tmp/does-not-matter.png',
      replyToMessageId: 'incoming-1',
    });

    assert.equal(result.ok, false);
    assert.match(result.error || '', /not initialized/i);
  });

  it('returns a failed SendResult when Feishu image upload does not provide an image key', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const tempImagePath = path.join(DATA_DIR, 'missing-image-key.png');
    fs.mkdirSync(path.dirname(tempImagePath), { recursive: true });
    fs.writeFileSync(tempImagePath, 'still-good-enough');

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        image: {
          create: async () => ({}),
        },
        message: {
          reply: async () => {
            throw new Error('should not send reply without image key');
          },
        },
      },
    };

    const result = await adapter.sendImage({
      address: { channelType: 'feishu', chatId: 'group-image' },
      filePath: tempImagePath,
      replyToMessageId: 'incoming-1',
    });

    assert.equal(result.ok, false);
    assert.match(result.error || '', /image_key/i);
  });

  it('renders command and file activity cards with fixed titles and concise details when explicitly enabled', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});

    const sentPayloads: string[] = [];
    const adapter = new FeishuAdapter({
      profile: {
        id: 'default',
        showToolCallCards: true,
      },
    }) as any;
    adapter.lastIncomingMessageId.set('group-activity-cards:main', 'incoming-1');
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string } }) => {
            sentPayloads.push(payload.data.content);
            return { code: 0, data: { message_id: `activity-msg-${sentPayloads.length}` } };
          },
        },
      },
    };

    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-cards' },
      {
        kind: 'command_execution',
        id: 'command:turn-1:cmd-1',
        turnId: 'turn-1',
        status: 'completed',
        command: 'rg CardKit',
        cwd: '/tmp/test-cwd',
        output: 'src/feishu/adapter.ts',
        exitCode: 0,
      },
    );
    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-cards' },
      {
        kind: 'file_change',
        id: 'file:turn-1:file-1',
        turnId: 'turn-1',
        status: 'completed',
        summary: '已修改 bridge-manager.ts',
        changes: [{ kind: 'update', path: 'src/bridge/bridge-manager.ts' }],
      },
    );

    const commandCard = JSON.parse(sentPayloads[0]);
    const fileCard = JSON.parse(sentPayloads[1]);
    assert.equal(commandCard.config.width_mode, 'fill');
    assert.equal(commandCard.body.elements[0].tag, 'collapsible_panel');
    assert.equal(commandCard.body.elements[0].expanded, false);
    assert.equal(commandCard.body.elements[0].header.width, 'fill');
    assert.match(commandCard.body.elements[0].header.title.content, /执行命令/);
    assert.match(commandCard.body.elements[0].header.title.content, /rg CardKit/);
    assert.match(commandCard.body.elements[0].elements[0].content, /退出码/);
    assert.equal(fileCard.config.width_mode, 'fill');
    assert.equal(fileCard.body.elements[0].tag, 'collapsible_panel');
    assert.equal(fileCard.body.elements[0].expanded, false);
    assert.equal(fileCard.body.elements[0].header.width, 'fill');
    assert.match(fileCard.body.elements[0].header.title.content, /修改文件/);
    assert.match(fileCard.body.elements[0].elements[0].content, /bridge-manager\.ts/);
    assert.match(fileCard.body.elements[0].elements[0].content, /已完成/);
  });

  it('suppresses tool-call activity cards by default while keeping other activity cards', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});

    const sentPayloads: string[] = [];
    const patchedPayloads: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.lastIncomingMessageId.set('group-activity-reasoning:main', 'incoming-1');
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string } }) => {
            sentPayloads.push(payload.data.content);
            return {
              code: 0,
              data: {
                message_id: `activity-msg-${sentPayloads.length}`,
                open_message_id: `open-activity-${sentPayloads.length}`,
              },
            };
          },
          patch: async (payload: { data: { content: string } }) => {
            patchedPayloads.push(payload.data.content);
            return { code: 0, data: {} };
          },
        },
      },
    };

    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-reasoning' },
      {
        kind: 'reasoning_activity',
        turnId: 'turn-reasoning-1',
        status: 'running',
        text: '正在分析页面结构与截图步骤',
        source: 'task_progress',
      },
    );
    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-reasoning' },
      {
        kind: 'tool_activity',
        turnId: 'turn-reasoning-1',
        toolUseId: 'tool-use-1',
        toolName: 'MCP: chrome-devtools take_screenshot',
        status: 'running',
        inputPreview: 'file:///tmp/test-cwd/index.html',
        taskId: 'task-1',
        source: 'tool_progress',
      },
    );
    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-reasoning' },
      {
        kind: 'tool_activity',
        turnId: 'turn-reasoning-1',
        toolUseId: 'tool-use-1',
        toolName: 'MCP: chrome-devtools take_screenshot',
        status: 'completed',
        inputPreview: 'file:///tmp/test-cwd/index.html',
        resultPreview: '返回了 1 张图片',
        elapsedSeconds: 1.2,
        taskId: 'task-1',
        source: 'tool_progress',
      },
    );
    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-reasoning' },
      {
        kind: 'command_execution',
        id: 'command-1',
        turnId: 'turn-reasoning-1',
        status: 'completed',
        command: '/bin/zsh -lc "ls -1"',
        cwd: '/tmp/test-cwd',
        output: 'README.md',
        exitCode: 0,
      },
    );
    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-reasoning' },
      {
        kind: 'file_change',
        id: 'file-change-1',
        turnId: 'turn-reasoning-1',
        status: 'completed',
        summary: '更新 landing page',
        changes: [{ kind: 'update', path: 'landingpage/index.html' }],
      },
    );

    assert.equal(sentPayloads.length, 1);
    assert.equal(patchedPayloads.length, 0);

    const reasoningCard = JSON.parse(sentPayloads[0]);
    assert.equal(reasoningCard.header.title.content, '思考过程');
    assert.match(reasoningCard.body.elements[0].content, /正在分析页面结构与截图步骤/);
  });

  it('renders tool activity cards when explicitly enabled and patches a tool lifecycle in place', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});

    const sentPayloads: string[] = [];
    const patchedPayloads: string[] = [];
    const adapter = new FeishuAdapter({
      profile: {
        id: 'default',
        showToolCallCards: true,
      },
    }) as any;
    adapter.lastIncomingMessageId.set('group-activity-reasoning:main', 'incoming-1');
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string } }) => {
            sentPayloads.push(payload.data.content);
            return {
              code: 0,
              data: {
                message_id: `activity-msg-${sentPayloads.length}`,
                open_message_id: `open-activity-${sentPayloads.length}`,
              },
            };
          },
          patch: async (payload: { data: { content: string } }) => {
            patchedPayloads.push(payload.data.content);
            return { code: 0, data: {} };
          },
        },
      },
    };

    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-reasoning' },
      {
        kind: 'reasoning_activity',
        turnId: 'turn-reasoning-1',
        status: 'running',
        text: '正在分析页面结构与截图步骤',
        source: 'task_progress',
      },
    );
    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-reasoning' },
      {
        kind: 'tool_activity',
        turnId: 'turn-reasoning-1',
        toolUseId: 'tool-use-1',
        toolName: 'MCP: chrome-devtools take_screenshot',
        status: 'running',
        inputPreview: 'file:///tmp/test-cwd/index.html',
        taskId: 'task-1',
        source: 'tool_progress',
      },
    );
    await adapter.upsertActivityEvent(
      { channelType: 'feishu', chatId: 'group-activity-reasoning' },
      {
        kind: 'tool_activity',
        turnId: 'turn-reasoning-1',
        toolUseId: 'tool-use-1',
        toolName: 'MCP: chrome-devtools take_screenshot',
        status: 'completed',
        inputPreview: 'file:///tmp/test-cwd/index.html',
        resultPreview: '返回了 1 张图片',
        elapsedSeconds: 1.2,
        taskId: 'task-1',
        source: 'tool_progress',
      },
    );

    assert.equal(sentPayloads.length, 2);
    assert.equal(patchedPayloads.length, 1);

    const reasoningCard = JSON.parse(sentPayloads[0]);
    const runningToolCard = JSON.parse(sentPayloads[1]);
    const completedToolCard = JSON.parse(patchedPayloads[0]);

    assert.equal(reasoningCard.header.title.content, '思考过程');
    assert.match(reasoningCard.body.elements[0].content, /正在分析页面结构与截图步骤/);
    assert.equal(runningToolCard.body.elements[0].tag, 'collapsible_panel');
    assert.match(runningToolCard.body.elements[0].header.title.content, /MCP: chrome-devtools take_screenshot/);
    assert.match(runningToolCard.body.elements[0].elements[0].content, /输入预览/);
    assert.match(completedToolCard.body.elements[0].header.title.content, /已完成/);
    assert.match(completedToolCard.body.elements[0].elements[0].content, /结果预览/);
    assert.match(completedToolCard.body.elements[0].elements[0].content, /返回了 1 张图片/);
  });

  it('sends permission cards as schema 2.0 without deprecated action tags', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});

    let payloadContent = '';
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string } }) => {
            payloadContent = payload.data.content;
            return { code: 0, data: { message_id: 'perm-msg-1' } };
          },
        },
      },
    };

    const result = await adapter.send({
      address: { channelType: 'feishu', chatId: 'group-perm' },
      text: '需要你的确认。',
      parseMode: 'Markdown',
      replyToMessageId: 'incoming-1',
      inlineButtons: [[
        { text: 'Allow', callbackData: 'perm:allow:req-1' },
        { text: 'Deny', callbackData: 'perm:deny:req-1' },
      ]],
    });

    const card = JSON.parse(payloadContent);
    assert.equal(result.ok, true);
    assert.equal(card.schema, '2.0');
    assert.equal(card.body.elements[1].tag, 'column_set');
    assert.equal(card.body.elements[1].columns[0].elements[0].tag, 'button');
    assert.equal(card.body.elements[1].columns[0].elements[0].behaviors[0].value.callback_data, 'perm:allow:req-1');
    assert.equal(card.body.elements[1].columns[1].elements[0].behaviors[0].value.callback_data, 'perm:deny:req-1');
  });

  it('shows runtime-specific timeout hints on forwarded permission cards', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const claudeSession = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const codexSession = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });

    const payloads: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string } }) => {
            payloads.push(payload.data.content);
            return { code: 0, data: { message_id: `perm-msg-${payloads.length}` } };
          },
        },
      },
    };

    await forwardPermissionRequest(
      adapter,
      { channelType: 'feishu', chatId: 'group-perm-timeout' },
      'req-claude-timeout',
      'Bash',
      { command: 'npm test' },
      claudeSession.id,
      [],
      'incoming-claude',
    );
    await forwardPermissionRequest(
      adapter,
      { channelType: 'feishu', chatId: 'group-perm-timeout' },
      'req-codex-timeout',
      'Plan Execution',
      { reason: 'Confirm whether to implement the proposed plan.' },
      codexSession.id,
      [],
      'incoming-codex',
    );

    const claudeCard = JSON.parse(payloads[0]);
    const codexCard = JSON.parse(payloads[1]);
    assert.match(claudeCard.body.elements[0].content, /15 分钟/);
    assert.match(claudeCard.body.elements[0].content, /自动拒绝/);
    assert.match(codexCard.body.elements[0].content, /10 分钟/);
    assert.match(codexCard.body.elements[0].content, /自动拒绝/);
  });

  it('patches a permission card into a handled state after a button action', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: () => true,
      },
      lifecycle: {},
    });
    store.insertPermissionLink({
      permissionRequestId: 'req-perm-1',
      channelType: 'feishu',
      chatId: 'group-perm-action',
      messageId: 'perm-msg-1',
      openMessageId: 'open-perm-1',
      toolName: 'Bash',
      suggestions: '',
    });

    let patchedCard: Record<string, unknown> | null = null;
    let patchTarget = '';
    let patchParams: Record<string, unknown> | undefined;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          patch: async (payload: { path: { message_id: string }; params?: Record<string, unknown>; data: { content: string } }) => {
            patchTarget = payload.path.message_id;
            patchParams = payload.params;
            patchedCard = JSON.parse(payload.data.content);
            return { code: 0, data: {} };
          },
        },
      },
    };

    const result = await adapter.handleCardAction({
      open_id: 'ou_123',
      tenant_key: 'tenant',
      token: 'token',
      open_message_id: 'open-perm-1',
      operator: { open_id: 'ou_123' },
      action: {
        value: { callback_data: 'perm:allow_session:req-perm-1' },
        tag: 'button',
      },
    });

    assert.equal(result.toast.type, 'success');
    assert.equal(store.getPermissionLink('req-perm-1')?.resolved, true);
    assert.equal(patchTarget, 'open-perm-1');
    assert.deepEqual(patchParams, { message_id_type: 'open_message_id' });
    assert.equal((patchedCard as any)?.header?.title?.content, '授权已处理');
    assert.match((patchedCard as any)?.body?.elements?.[0]?.content || '', /本会话允许/);
    assert.equal((patchedCard as any)?.body?.elements?.length, 1);
  });

  it('keeps threaded follow-up messages on the same route and replies in thread', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-thread',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    const replyCalls: Array<{ replyInThread?: boolean }> = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ code: 0, data: { card_id: 'card-1' } }),
            update: async () => ({ code: 0, data: {} }),
            settings: async () => ({ code: 0, data: {} }),
          },
          cardElement: {
            content: async () => ({ code: 0, data: {} }),
          },
        },
      },
      im: {
        message: {
          reply: async (payload: { data?: { reply_in_thread?: boolean } }) => {
            replyCalls.push({ replyInThread: payload.data?.reply_in_thread });
            return { code: 0, data: { message_id: `msg-${replyCalls.length}` } };
          },
          create: async () => {
            throw new Error('unexpected create');
          },
          patch: async () => ({ code: 0, data: {} }),
        },
      },
    };

    await adapter.handleIncomingEvent({
      sender: {
        sender_id: { open_id: 'ou_123' },
        sender_type: 'user',
      },
      message: {
        message_id: 'thread-msg-1',
        chat_id: 'group-thread',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'follow up' }),
        create_time: String(Date.now()),
        thread_id: 'omt-thread-1',
        root_id: 'om-root-1',
        parent_id: 'om-parent-1',
      },
    });

    const queued = await adapter.consumeOne();
    assert.equal(queued?.address.threadId, 'omt-thread-1');
    assert.equal(adapter.lastIncomingMessageId.get('group-thread:thread:omt-thread-1'), 'thread-msg-1');

    const previewResult = await adapter.sendPreview(
      { channelType: 'feishu', chatId: 'group-thread', threadId: 'omt-thread-1' },
      'partial',
      7,
    );
    const finalResult = await adapter.send({
      address: { channelType: 'feishu', chatId: 'group-thread', threadId: 'omt-thread-1' },
      text: 'final threaded answer',
      parseMode: 'Markdown',
    });

    assert.equal(previewResult, 'sent');
    assert.equal(finalResult.ok, true);
    assert.deepEqual(replyCalls, [{ replyInThread: true }]);
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

  it('supports /mode in group chat, clears active plan workflow, and syncs PLAN suffix', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-mode',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });
    store.upsertPlanWorkflow({
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-mode',
      codepilotSessionId: session.id,
      status: 'awaiting_input',
      previousMode: 'code',
      requestText: '',
      address: { channelType: 'feishu', chatId: 'group-mode' },
      routeKey: 'group-mode:main',
      requestMessageId: 'msg-1',
      resolved: true,
    });

    const updatedNames: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async (payload: { data: { name: string } }) => {
            updatedNames.push(payload.data.name);
            return { code: 0, data: {} };
          },
        },
        message: {
          create: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
          reply: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
        },
      },
    };

    await adapter.handleModeCommand(
      binding.id,
      '/mode plan',
      { channelType: 'feishu', chatId: 'group-mode' },
      'reply-1',
    );

    assert.equal(store.getChannelBinding('feishu', 'group-mode')?.mode, 'plan');
    assert.equal(store.getActivePlanWorkflowByBinding(binding.id), null);
    assert.equal(updatedNames.at(-1), 'Codex 新会话 [PLAN]');
    const history = store.getMessages(session.id).messages.slice(-2);
    assert.equal(history[0]?.role, 'user');
    assert.equal(history[0]?.content, '/mode plan');
    assert.equal(history[1]?.role, 'assistant');
    assert.match(history[1]?.content || '', /切换到 plan 模式/);
  });

  it('queues /stop in a bound group instead of treating it as an unsupported command', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-stop',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    const replies: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          create: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
          reply: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: 'msg-2' } };
          },
        },
      },
    };

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'cmd-stop-1',
        address: { channelType: 'feishu', chatId: 'group-stop', threadId: 'thread-1' },
        text: '/stop',
        timestamp: Date.now(),
      },
    );

    assert.equal(replies.length, 0);
    assert.equal((adapter as any).queue.length, 1);
    assert.equal((adapter as any).queue[0].text, '/stop');
  });

  it('shows the Claude mode card for /mode in Claude groups regardless of text arguments', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-claude-mode',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    const replies: Array<{ msgType: string; content: string }> = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { msg_type: string; content: string } }) => {
            replies.push({ msgType: payload.data.msg_type, content: payload.data.content });
            return { code: 0, data: { message_id: 'msg-1', open_message_id: 'open-msg-1' } };
          },
          create: async () => {
            throw new Error('unexpected create');
          },
        },
      },
    };

    await adapter.handleModeCommand(
      binding.id,
      '/mode bypassPermissions',
      { channelType: 'feishu', chatId: 'group-claude-mode' },
      'reply-1',
    );

    assert.equal(store.getChannelBinding('feishu', 'group-claude-mode')?.claudePermissionMode, undefined);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].msgType, 'interactive');
    const history = store.getMessages(session.id).messages.slice(-2);
    assert.equal(history[0]?.content, '/mode bypassPermissions');
    assert.match(history[1]?.content || '', /打开 Claude mode 选择卡/);
    const card = JSON.parse(replies[0].content);
    const buttons = card.body.elements[1].columns.map((column: any) => ({
      title: column.elements[0].text.content,
      type: column.elements[0].type,
    }));
    assert.deepEqual(buttons[0], { title: 'Default', type: 'default' });
    assert.deepEqual(buttons[1], { title: 'Plan Mode', type: 'default' });
  });

  it('switches Claude mode from card actions and syncs the chat suffix', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-claude-switch',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    const updatedNames: string[] = [];
    let patchedCard: Record<string, unknown> | null = null;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async (payload: { data: { name: string } }) => {
            updatedNames.push(payload.data.name);
            return { code: 0, data: {} };
          },
        },
        message: {
          patch: async (payload: { data: { content: string } }) => {
            patchedCard = JSON.parse(payload.data.content);
            return { code: 0, data: {} };
          },
        },
      },
    };

    const result = await adapter.handleClaudeModeCardAction(
      {
        open_id: 'ou_123',
        tenant_key: 'tenant',
        token: 'token',
        open_message_id: 'open-msg-1',
        action: {
          value: { callback_data: `claude-mode:switch:${binding.id}:plan` },
          tag: 'button',
        },
      },
      `claude-mode:switch:${binding.id}:plan`,
    );

    assert.equal(result.toast.type, 'success');
    assert.equal(store.getChannelBinding('feishu', 'group-claude-switch')?.claudePermissionMode, 'plan');
    assert.equal(store.getChannelBinding('feishu', 'group-claude-switch')?.mode, 'code');
    assert.equal(updatedNames.at(-1), 'Claude 新会话 [Plan Mode]');
    const buttons = (patchedCard as any)?.body?.elements?.[1]?.columns?.map((column: any) => ({
      title: column.elements[0].text.content,
      type: column.elements[0].type,
    }));
    assert.deepEqual(buttons?.slice(0, 2), [
      { title: 'Default', type: 'default' },
      { title: 'Plan Mode', type: 'primary' },
    ]);
  });

  it('enters awaiting_input on bare /plan and converts the next same-thread message into a planning request', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-plan',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    const replies: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
        },
        message: {
          create: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: `msg-${replies.length}` } };
          },
          reply: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: `msg-${replies.length}` } };
          },
        },
      },
    };

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'cmd-1',
        address: { channelType: 'feishu', chatId: 'group-plan', threadId: 'thread-1' },
        text: '/plan',
        timestamp: Date.now(),
      },
    );

    const waiting = store.getActivePlanWorkflowByBinding(binding.id);
    assert.ok(waiting);
    assert.equal(waiting?.status, 'awaiting_input');
    const history = store.getMessages(session.id).messages.slice(-2);
    assert.equal(history[0]?.content, '/plan');
    assert.match(history[1]?.content || '', /进入 Claude PLAN 流程/);

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'user-2',
        address: { channelType: 'feishu', chatId: 'group-plan', threadId: 'thread-1' },
        text: '请先做一个实现计划',
        timestamp: Date.now(),
      },
    );

    const queued = (adapter as any).queue[0];
    assert.equal(queued.bridgeMeta.planWorkflow.kind, 'plan_request');
    assert.equal(queued.bridgeMeta.planWorkflow.storedUserText, '请先做一个实现计划');
    assert.match(queued.bridgeMeta.planWorkflow.promptText, /只输出计划/);
    assert.equal(store.getPlanWorkflow(waiting!.workflowId)?.status, 'planning');
  });

  it('interrupts an in-flight planning workflow, acknowledges the steer, and keeps only the latest attempt active', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-plan-steer',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-steer',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-plan-steer',
      codepilotSessionId: session.id,
      status: 'planning',
      previousMode: 'code',
      requestText: '先做计划',
      address: { channelType: 'feishu', chatId: 'group-plan-steer', threadId: 'thread-1' },
      routeKey: 'group-plan-steer:thread:thread-1',
      requestMessageId: 'plan-msg-1',
      activeAttemptId: 'attempt-old',
      resolved: true,
    });

    const replies: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
        },
        message: {
          create: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: `msg-${replies.length}` } };
          },
          reply: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: `msg-${replies.length}` } };
          },
        },
      },
    };

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'user-steer-1',
        address: { channelType: 'feishu', chatId: 'group-plan-steer', threadId: 'thread-1' },
        text: '把范围缩小到单文件',
        timestamp: Date.now(),
      },
    );

    const workflowAfterFirst = store.getPlanWorkflow('wf-steer');
    const firstAttemptId = (adapter as any).queue[0].bridgeMeta.planWorkflow.attemptId;
    assert.equal(workflowAfterFirst?.status, 'interrupting');
    assert.equal(workflowAfterFirst?.pendingFollowUpText, '把范围缩小到单文件');
    assert.equal(workflowAfterFirst?.activeAttemptId, firstAttemptId);
    assert.match(replies[0] || '', /正在按新要求重试/);
    assert.doesNotMatch(replies[0] || '', /当前 PLAN 请求正在处理中/);

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'user-steer-2',
        address: { channelType: 'feishu', chatId: 'group-plan-steer', threadId: 'thread-1' },
        text: '再把步骤压缩成两步',
        timestamp: Date.now(),
      },
    );

    const workflowAfterSecond = store.getPlanWorkflow('wf-steer');
    const secondAttemptId = (adapter as any).queue[1].bridgeMeta.planWorkflow.attemptId;
    assert.equal(workflowAfterSecond?.status, 'interrupting');
    assert.equal(workflowAfterSecond?.pendingFollowUpText, '再把步骤压缩成两步');
    assert.equal(workflowAfterSecond?.activeAttemptId, secondAttemptId);
    assert.notEqual(secondAttemptId, firstAttemptId);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.storedUserText, '把范围缩小到单文件');
    assert.equal((adapter as any).queue[1].bridgeMeta.planWorkflow.storedUserText, '再把步骤压缩成两步');
  });

  it('writes /reset local replies into the new session history instead of the old session', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    store.addMessage(session.id, 'user', 'before reset');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-reset',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
        },
        message: {
          create: async () => ({ code: 0, data: { message_id: 'msg-reset-1' } }),
          reply: async () => ({ code: 0, data: { message_id: 'msg-reset-1' } }),
        },
      },
    };

    await adapter.handleResetCommand(
      { channelType: 'feishu', chatId: 'group-reset' },
      'reply-1',
    );

    const updated = store.getChannelBinding('feishu', 'group-reset');
    assert.ok(updated);
    assert.notEqual(updated?.codepilotSessionId, session.id);
    assert.equal(store.getMessages(session.id).messages.length, 1);
    const newHistory = store.getMessages(updated!.codepilotSessionId).messages.slice(-2);
    assert.equal(newHistory[0]?.content, '/reset');
    assert.match(newHistory[1]?.content || '', /旧上下文已清空/);
  });

  it('keeps the PLAN workflow active for codex until the native plan turn actually finishes', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {
      ensureCodexNativePlanAvailable: async () => {},
    });
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-native-plan',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });

    const updatedNames: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async (payload: { data: { name: string } }) => {
            updatedNames.push(payload.data.name);
            return { code: 0, data: {} };
          },
        },
        message: {
          create: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
          reply: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
        },
      },
    };

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'cmd-1',
        address: { channelType: 'feishu', chatId: 'group-native-plan', threadId: 'thread-1' },
        text: '/plan',
        timestamp: Date.now(),
      },
    );

    const waiting = store.getActivePlanWorkflowByBinding(binding.id);
    assert.ok(waiting);
    assert.equal(waiting?.status, 'awaiting_input');
    assert.equal(updatedNames.at(-1), 'Codex 新会话 [PLAN]');

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'user-2',
        address: { channelType: 'feishu', chatId: 'group-native-plan', threadId: 'thread-1' },
        text: '请给我一个原生 plan',
        timestamp: Date.now(),
      },
    );

    const queued = (adapter as any).queue[0];
    assert.equal(queued.bridgeMeta.planWorkflow.kind, 'native_plan_request');
    assert.equal(store.getPlanWorkflow(waiting!.workflowId)?.status, 'planning');
    assert.equal(updatedNames.at(-1), 'Codex 新会话 [PLAN]');
  });

  it('sends structured input cards as schema 2.0 forms without deprecated note tags', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const adapter = new FeishuAdapter() as any;
    let payloadContent = '';
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string } }) => {
            payloadContent = payload.data.content;
            return { code: 0, data: { message_id: 'msg-input-1', open_message_id: 'open-input-1' } };
          },
        },
      },
    };

    const result = await adapter.sendStructuredInputRequest(
      { channelType: 'feishu', chatId: 'group-structured', threadId: 'thread-1' },
      {
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
            options: [
              { label: '根目录 about-codex.html', description: '推荐' },
            ],
          },
        ],
      },
      'reply-1',
    );

    const card = JSON.parse(payloadContent);
    assert.equal(result.ok, true);
    assert.doesNotMatch(payloadContent, /"tag":"note"/);
    assert.doesNotMatch(payloadContent, /"tag":"action"/);
    assert.equal(card.header.title.content, '补充信息');
    assert.equal(card.schema, '2.0');
    assert.equal(card.body.elements[0].tag, 'form');
    assert.equal(card.body.elements[0].name, 'form_req_1');
    assert.equal(card.body.elements[0].elements[2].tag, 'select_static');
    assert.equal(card.body.elements[0].elements[2].name, 'structured-input_req_1_answer_q1');
    assert.equal(card.body.elements[0].elements[2].options[0].value, '根目录 about-codex.html');
    assert.match(card.body.elements[0].elements[1].content, /根目录 about-codex\.html：推荐/);
    assert.equal(card.body.elements[0].elements[3].tag, 'input');
    assert.equal(card.body.elements[0].elements[3].name, 'structured-input_req_1_other_q1');
    assert.equal(card.body.elements[0].elements[4].tag, 'markdown');
    assert.match(card.body.elements[0].elements[4].content, /可填写上面的自定义输入框/);
    assert.equal(card.body.elements[0].elements.at(-2).tag, 'markdown');
    assert.match(card.body.elements[0].elements.at(-2).content, /StatusFlashOfInspiration/);
    assert.match(card.body.elements[0].elements.at(-2).content, /<font color=orange>/);
    assert.match(card.body.elements[0].elements.at(-2).content, /10 分钟/);
    assert.match(card.body.elements[0].elements.at(-2).content, /未补充处理/);
    assert.equal(card.body.elements[0].elements.at(-1).tag, 'column_set');
    assert.equal(card.body.elements[0].elements.at(-1).columns[0].elements[0].tag, 'button');
    assert.equal(card.body.elements[0].elements.at(-1).columns[0].elements[0].form_action_type, 'submit');
    assert.equal(
      card.body.elements[0].elements.at(-1).columns[0].elements[0].behaviors[0].value.callback_data,
      'input:submit:req-1',
    );
  });

  it('falls back to a post message for structured input and keeps option reasons', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const adapter = new FeishuAdapter() as any;
    const sends: Array<{ msgType: string; content: string }> = [];
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { msg_type: string; content: string } }) => {
            if (payload.data.msg_type === 'interactive') {
              throw new Error('interactive failed');
            }
            sends.push({ msgType: payload.data.msg_type, content: payload.data.content });
            return { code: 0, data: { message_id: 'msg-fallback-1' } };
          },
        },
      },
    };

    const result = await adapter.sendStructuredInputRequest(
      { channelType: 'feishu', chatId: 'group-structured', threadId: 'thread-1' },
      {
        requestId: 'req-fallback',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: '模式',
            question: '要用哪个模式？',
            isOther: false,
            isSecret: false,
            options: [
              { label: 'Plan Mode', description: '先只做规划' },
              { label: 'Accept edits', description: '执行时逐步确认修改' },
            ],
          },
        ],
      },
      'reply-1',
    );

    assert.equal(result.ok, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].msgType, 'post');
    assert.match(sends[0].content, /Plan Mode：先只做规划/);
    assert.match(sends[0].content, /Accept edits：执行时逐步确认修改/);
  });

  it('downloads inbound images and attaches them when the user replies with text', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-image',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    const replies: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => ({
            headers: { 'content-type': 'image/png' },
            getReadableStream: () => Readable.from([Buffer.from('image-binary')]),
            writeFile: async () => undefined,
          }),
        },
        message: {
          reply: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: `msg-${replies.length}` } };
          },
          create: async () => ({ code: 0, data: { message_id: 'msg-create-1' } }),
        },
      },
    };

    await adapter.handleIncomingEvent({
      sender: {
        sender_id: { open_id: 'ou_123' },
        sender_type: 'user',
      },
      message: {
        message_id: 'img-msg-1',
        chat_id: 'group-image',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img-key-1' }),
        create_time: String(Date.now()),
      },
    });

    assert.equal((adapter as any).queue.length, 0);
    assert.match(replies[0] || '', /已收到图片/);

    await adapter.handleIncomingEvent({
      sender: {
        sender_id: { open_id: 'ou_123' },
        sender_type: 'user',
      },
      message: {
        message_id: 'txt-msg-1',
        chat_id: 'group-image',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '请描述这张图片' }),
        create_time: String(Date.now()),
        parent_id: 'img-msg-1',
      },
    });

    const queued = (adapter as any).queue[0];
    assert.equal(queued.text, '请描述这张图片');
    assert.equal(queued.attachments?.length, 1);
    assert.equal(Buffer.from(queued.attachments[0].data, 'base64').toString(), 'image-binary');
    assert.equal(queued.attachments[0].type, 'image/png');
  });

  it('surfaces inbound image download failures and blocks stale replies from silently continuing', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-image-fail',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });

    const replies: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        messageResource: {
          get: async () => {
            throw new Error('resource unavailable');
          },
        },
        message: {
          reply: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: `msg-${replies.length}` } };
          },
          create: async () => ({ code: 0, data: { message_id: 'msg-create-1' } }),
        },
      },
    };

    await adapter.handleIncomingEvent({
      sender: {
        sender_id: { open_id: 'ou_123' },
        sender_type: 'user',
      },
      message: {
        message_id: 'img-msg-fail',
        chat_id: 'group-image-fail',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img-key-fail' }),
        create_time: String(Date.now()),
      },
    });

    await adapter.handleIncomingEvent({
      sender: {
        sender_id: { open_id: 'ou_123' },
        sender_type: 'user',
      },
      message: {
        message_id: 'txt-msg-fail',
        chat_id: 'group-image-fail',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '继续分析' }),
        create_time: String(Date.now()),
        parent_id: 'img-msg-fail',
      },
    });

    assert.equal((adapter as any).queue.length, 0);
    assert.match(replies[0] || '', /图片下载失败/);
    assert.match(replies[1] || '', /图片下载失败/);
  });

  it('degrades multi-select structured input questions to text input with comma guidance', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const adapter = new FeishuAdapter() as any;
    let payloadContent = '';
    adapter.restClient = {
      im: {
        message: {
          reply: async (payload: { data: { content: string } }) => {
            payloadContent = payload.data.content;
            return { code: 0, data: { message_id: 'msg-input-2', open_message_id: 'open-input-2' } };
          },
        },
      },
    };

    const result = await adapter.sendStructuredInputRequest(
      { channelType: 'feishu', chatId: 'group-structured', threadId: 'thread-1' },
      {
        requestId: 'req-2',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        questions: [
          {
            id: 'q1',
            header: '特性',
            question: '要启用哪些特性？',
            isOther: true,
            isSecret: false,
            multiSelect: true,
            options: [
              { label: 'A', description: 'A 功能' },
              { label: 'B', description: 'B 功能' },
            ],
          },
        ],
      },
      'reply-1',
    );

    const card = JSON.parse(payloadContent);
    const elements = card.body.elements[0].elements;
    assert.equal(result.ok, true);
    assert.equal(elements[2].tag, 'markdown');
    assert.match(elements[2].content, /可选项/);
    assert.equal(elements[3].tag, 'input');
    assert.equal(elements[3].name, 'structured-input_req_2_other_q1');
    assert.match(elements[3].placeholder.content, /逗号分隔/);
    assert.equal(elements[4].tag, 'markdown');
    assert.match(elements[4].content, /多个预设选项/);
  });

  it('acknowledges structured input field interactions without blocking on callbacks', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const adapter = new FeishuAdapter() as any;

    const result = await adapter.handleCardAction({
      open_id: 'ou_123',
      tenant_key: 'tenant',
      token: 'token',
      open_message_id: 'open-input-1',
      operator: { open_id: 'ou_123' },
      action: {
        tag: 'select_static',
        value: {},
        option: '偏科技感',
      },
    });

    assert.equal(result.toast.type, 'success');
    assert.match(result.toast.content, /已记录选择/);
  });

  it('submits structured input answers from interactive card actions', async () => {
    const store = new JsonFileStore(makeSettings());
    let resolvedPayload: unknown = null;
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: () => true,
        resolvePendingStructuredInput: (_requestId: string, answers: unknown) => {
          resolvedPayload = answers;
          return true;
        },
      },
      lifecycle: {},
    });
    store.upsertStructuredInputRequest({
      requestId: 'req-submit',
      channelType: 'feishu',
      chatId: 'group-submit',
      codepilotSessionId: 'session-1',
      address: { channelType: 'feishu', chatId: 'group-submit', threadId: 'thread-1' },
      routeKey: 'group-submit:thread:thread-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [
        {
          id: 'q1',
          header: '页面风格',
          question: '选一个风格',
          isOther: true,
          isSecret: false,
          options: [{ label: '极简', description: '推荐' }],
        },
      ],
      messageId: 'msg-submit-1',
      openMessageId: 'open-submit-1',
      resolved: false,
    });

    const adapter = new FeishuAdapter() as any;
    let patchCalls = 0;
    let patchedCard: Record<string, unknown> | null = null;
    adapter.restClient = {
      im: {
        message: {
          patch: async (payload: { data: { content: string } }) => {
            patchCalls += 1;
            patchedCard = JSON.parse(payload.data.content) as Record<string, unknown>;
            return { code: 0, data: {} };
          },
        },
      },
    };

    const result = await adapter.handleCardAction({
      open_id: 'ou_123',
      tenant_key: 'tenant',
      token: 'token',
      open_message_id: 'open-submit-1',
      operator: { open_id: 'ou_123' },
      action: {
        tag: 'button',
        value: {
          callback_data: 'input:submit:req-submit',
        },
        form_value: {
          'structured-input_req_submit_answer_q1': '极简',
        },
      },
    });

    assert.equal(result.toast.type, 'success');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(patchCalls, 1);
    assert.deepEqual(resolvedPayload, {
      answers: {
        q1: {
          answers: ['极简'],
        },
      },
    });
    assert.ok(patchedCard);
    const resolvedCard = patchedCard as { body?: { elements?: Array<Record<string, unknown>> } };
    const bodyElements = resolvedCard.body?.elements || [];
    assert.equal(bodyElements[0]?.tag, 'div');
    assert.equal(bodyElements[1]?.tag, 'div');
    assert.equal(bodyElements[2]?.tag, 'div');
    assert.equal((bodyElements[2]?.text as { content?: string } | undefined)?.content, '已提交：极简 (推荐)');
  });

  it('keeps multi-select answers split for bridge storage', async () => {
    const store = new JsonFileStore(makeSettings());
    let resolvedPayload: unknown = null;
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: () => true,
        resolvePendingStructuredInput: (_requestId: string, answers: unknown) => {
          resolvedPayload = answers;
          return true;
        },
      },
      lifecycle: {},
    });
    store.upsertStructuredInputRequest({
      requestId: 'req-submit-multi',
      channelType: 'feishu',
      chatId: 'group-submit',
      codepilotSessionId: 'session-1',
      address: { channelType: 'feishu', chatId: 'group-submit', threadId: 'thread-1' },
      routeKey: 'group-submit:thread:thread-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      questions: [
        {
          id: 'q1',
          header: '特性',
          question: '选多个特性',
          isOther: true,
          isSecret: false,
          multiSelect: true,
          options: [
            { label: 'A', description: 'A 功能' },
            { label: 'B', description: 'B 功能' },
          ],
        },
      ],
      messageId: 'msg-submit-multi',
      openMessageId: 'open-submit-multi',
      resolved: false,
    });

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          patch: async () => ({ code: 0, data: {} }),
        },
      },
    };

    const result = await adapter.handleCardAction({
      open_id: 'ou_123',
      tenant_key: 'tenant',
      token: 'token',
      open_message_id: 'open-submit-multi',
      operator: { open_id: 'ou_123' },
      action: {
        tag: 'button',
        value: {
          callback_data: 'input:submit:req-submit-multi',
        },
        form_value: {
          'structured-input_req_submit_multi_other_q1': 'A,B',
        },
      },
    });

    assert.equal(result.toast.type, 'success');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resolvedPayload, {
      answers: {
        q1: {
          answers: ['A', 'B'],
        },
      },
    });
  });

  it('skips empty preview updates instead of sending invalid empty CardKit content', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const adapter = new FeishuAdapter() as any;
    let createCalls = 0;
    let streamCalls = 0;
    adapter.restClient = {
      cardkit: {
        v1: {
          card: {
            create: async () => {
              createCalls += 1;
              return { code: 0, data: { card_id: 'card-empty' } };
            },
          },
          cardElement: {
            content: async () => {
              streamCalls += 1;
              return { code: 0, data: {} };
            },
          },
        },
      },
      im: {
        message: {
          create: async () => ({ code: 0, data: { message_id: 'msg-empty' } }),
          reply: async () => ({ code: 0, data: { message_id: 'msg-empty' } }),
        },
      },
    };

    const result = await adapter.sendPreview(
      { channelType: 'feishu', chatId: 'group-empty', threadId: 'thread-1' },
      '   ',
      9,
    );

    assert.equal(result, 'skip');
    assert.equal(createCalls, 0);
    assert.equal(streamCalls, 0);
  });

  it('rejects cross-thread messages while a PLAN workflow is waiting for input', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-conflict',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-conflict',
      codepilotSessionId: session.id,
      status: 'awaiting_input',
      previousMode: 'code',
      requestText: '',
      address: { channelType: 'feishu', chatId: 'group-conflict', threadId: 'thread-1' },
      routeKey: 'group-conflict:thread:thread-1',
      requestMessageId: 'cmd-1',
      resolved: true,
    });

    const replies: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          create: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
          reply: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: 'msg-1' } };
          },
        },
      },
    };

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'user-2',
        address: { channelType: 'feishu', chatId: 'group-conflict', threadId: 'thread-2' },
        text: '别的线程消息',
        timestamp: Date.now(),
      },
    );

    assert.equal((adapter as any).queue.length, 0);
    assert.match(replies[0], /另一条线程/);
  });

  it('treats codex replies after native plan confirmation as plan adjustments instead of blocking on the card', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-plan-adjust',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-adjust',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-plan-adjust',
      codepilotSessionId: session.id,
      status: 'awaiting_confirmation',
      previousMode: 'code',
      requestText: '先做个方案',
      address: { channelType: 'feishu', chatId: 'group-plan-adjust', threadId: 'thread-1' },
      routeKey: 'group-plan-adjust:thread:thread-1',
      requestMessageId: 'user-1',
      planMessageId: 'plan-msg-1',
      actionCardMessageId: 'card-msg-1',
      actionCardOpenMessageId: 'open-card-1',
      resolved: false,
    });

    const replies: string[] = [];
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        message: {
          create: async () => ({ code: 0, data: { message_id: 'msg-1' } }),
          reply: async (payload: { data: { content: string } }) => {
            replies.push(payload.data.content);
            return { code: 0, data: { message_id: 'msg-2' } };
          },
        },
      },
    };

    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'user-2',
        address: { channelType: 'feishu', chatId: 'group-plan-adjust', threadId: 'thread-1' },
        text: 'html 语言改成英文',
        timestamp: Date.now(),
      },
    );

    assert.equal(replies.length, 0);
    assert.equal((adapter as any).queue.length, 1);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.kind, 'native_plan_request');
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.collaborationMode, 'plan');
    assert.equal((adapter as any).queue[0].text, 'html 语言改成英文');
    assert.equal(store.getPlanWorkflow('wf-adjust')?.status, 'planning');
    assert.equal(store.getPlanWorkflow('wf-adjust')?.requestText, 'html 语言改成英文');
    assert.equal(store.getPlanWorkflow('wf-adjust')?.resolved, true);
    assert.equal(store.getPlanWorkflow('wf-adjust')?.actionCardMessageId, '');
  });

  it('executes confirmed plan cards by switching back to code and queueing a synthetic execution request', async () => {
    const store = new JsonFileStore(makeSettings());
    installContext(store, {});
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-execute',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'gpt-5-codex',
    });
    store.updateChannelBinding(binding.id, { mode: 'ask' });
    const workflow = store.upsertPlanWorkflow({
      workflowId: 'wf-1',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-execute',
      codepilotSessionId: session.id,
      status: 'awaiting_confirmation',
      previousMode: 'ask',
      requestText: '修复这个问题',
      address: { channelType: 'feishu', chatId: 'group-execute', threadId: 'thread-1' },
      routeKey: 'group-execute:thread:thread-1',
      requestMessageId: 'user-1',
      planMessageId: 'plan-msg-1',
      actionCardMessageId: 'card-msg-1',
      resolved: false,
    });

    let patchedCard: Record<string, unknown> | null = null;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
        },
        message: {
          patch: async (payload: { data: { content: string } }) => {
            patchedCard = JSON.parse(payload.data.content);
            return { code: 0, data: {} };
          },
        },
      },
    };

    const result = await adapter.handlePlanCardAction(
      {
        open_id: 'ou_123',
        tenant_key: 'tenant',
        token: 'token',
        open_message_id: 'card-msg-1',
        action: {
          value: { callback_data: 'plan:execute:wf-1' },
          tag: 'button',
        },
      },
      'plan:execute:wf-1',
    );

    assert.equal(result.toast.type, 'success');
    assert.equal(store.getChannelBinding('feishu', 'group-execute')?.mode, 'code');
    assert.equal(store.getPlanWorkflow(workflow.workflowId), null);
    assert.equal((adapter as any).queue.length, 1);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.kind, 'plan_execute');
    assert.match((adapter as any).queue[0].bridgeMeta.planWorkflow.promptText, /开始实施/);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.collaborationMode, 'default');
    assert.equal((patchedCard as any)?.header?.title?.content, '计划已确认');
    assert.match((patchedCard as any)?.body?.elements?.[0]?.content || '', /开始执行已确认计划/);
    assert.equal((patchedCard as any)?.body?.elements?.length, 1);
  });

  it('approves Claude ExitPlanMode with manual approvals and keeps requested prompt rules', async () => {
    const store = new JsonFileStore(makeSettings());
    const resolutions: unknown[] = [];
    let patchedBeforeResolve = false;
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: (_id: string, resolution: unknown) => {
          patchedBeforeResolve = patchedCard !== null;
          resolutions.push(resolution);
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
      channelType: 'feishu',
      chatId: 'group-claude-plan',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.updateChannelBinding(binding.id, { mode: 'ask' });
    store.upsertPlanWorkflow({
      workflowId: 'wf-claude-manual',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-claude-plan',
      codepilotSessionId: session.id,
      status: 'awaiting_confirmation',
      previousMode: 'ask',
      requestText: '生成单文件页面',
      address: { channelType: 'feishu', chatId: 'group-claude-plan', threadId: 'thread-1' },
      routeKey: 'group-claude-plan:thread:thread-1',
      requestMessageId: 'user-1',
      actionCardMessageId: 'card-msg-1',
      actionCardOpenMessageId: 'open-card-1',
      approvalRequestId: 'perm-exit-1',
      planText: '# Plan\n\n1. Create the HTML file\n2. Capture a screenshot',
      allowedPrompts: [{ tool: 'Bash', prompt: '在浏览器中打开 HTML 文件' }],
      resolved: false,
    });

    let patchedCard: Record<string, unknown> | null = null;
    let patchTarget = '';
    let patchParams: Record<string, unknown> | undefined;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
        },
        message: {
          patch: async (payload: { path: { message_id: string }; params?: Record<string, unknown>; data: { content: string } }) => {
            patchTarget = payload.path.message_id;
            patchParams = payload.params;
            patchedCard = JSON.parse(payload.data.content);
            return { code: 0, data: {} };
          },
        },
      },
    };

    const result = await adapter.handleClaudePlanExitCardAction(
      {
        open_id: 'ou_123',
        tenant_key: 'tenant',
        token: 'token',
        context: {
          open_message_id: 'open-card-1',
        },
        action: {
          value: { callback_data: 'planexit:approve:manual:wf-claude-manual' },
          tag: 'button',
        },
      },
      'planexit:approve:manual:wf-claude-manual',
    );

    assert.equal(result.toast.type, 'success');
    assert.equal(patchTarget, 'open-card-1');
    assert.deepEqual(patchParams, { message_id_type: 'open_message_id' });
    assert.equal(store.getChannelBinding('feishu', 'group-claude-plan')?.mode, 'code');
    assert.equal(store.getChannelBinding('feishu', 'group-claude-plan')?.claudePermissionMode, 'default');
    assert.equal((adapter as any).queue.length, 0);
    assert.equal(store.getPlanWorkflow('wf-claude-manual')?.status, 'planning');
    assert.equal(store.getPlanWorkflow('wf-claude-manual')?.approvalRequestId, '');
    assert.equal(store.getPlanWorkflow('wf-claude-manual')?.actionCardMessageId, '');
    assert.equal(store.getPlanWorkflow('wf-claude-manual')?.actionCardOpenMessageId, '');
    assert.equal(patchedBeforeResolve, true);
    assert.deepEqual(resolutions[0], {
      behavior: 'allow',
      updatedPermissions: buildClaudePlanModeUpdates('default', [{ tool: 'Bash', prompt: '在浏览器中打开 HTML 文件' }]),
    });
    assert.equal((patchedCard as any)?.header?.title?.content, '计划已就绪');
    assert.match((patchedCard as any)?.body?.elements?.[1]?.content || '', /Create the HTML file/);
    assert.equal((patchedCard as any)?.body?.elements?.at(-1)?.tag, 'column_set');
    const actionColumns = (patchedCard as any)?.body?.elements?.at(-1)?.columns || [];
    assert.equal(actionColumns.length, 3);
    assert.equal(actionColumns[0]?.elements?.[0]?.disabled, true);
    assert.equal(actionColumns[1]?.elements?.[0]?.disabled, true);
    assert.equal(actionColumns[2]?.elements?.[0]?.disabled, true);
    assert.equal(actionColumns[1]?.elements?.[0]?.type, 'primary');
    assert.equal(actionColumns[1]?.elements?.[0]?.text?.content, 'Yes, manually approve edits');
    assert.equal((patchedCard as any)?.body?.elements?.length, 5);
  });

  it('executes a Claude follow-up plan confirmation card even when no pending ExitPlanMode request remains', async () => {
    const store = new JsonFileStore(makeSettings());
    const resolutions: unknown[] = [];
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: (_id: string, resolution: unknown) => {
          resolutions.push(resolution);
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
      channelType: 'feishu',
      chatId: 'group-claude-followup-confirm',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.updateChannelBinding(binding.id, { mode: 'plan' });
    store.upsertPlanWorkflow({
      workflowId: 'wf-claude-followup-confirm',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-claude-followup-confirm',
      codepilotSessionId: session.id,
      status: 'awaiting_confirmation',
      previousMode: 'plan',
      requestText: '生成单文件页面',
      address: { channelType: 'feishu', chatId: 'group-claude-followup-confirm', threadId: 'thread-1' },
      routeKey: 'group-claude-followup-confirm:thread:thread-1',
      requestMessageId: 'user-1',
      actionCardMessageId: 'card-msg-1',
      approvalRequestId: '',
      planText: '# 更新后的计划\n\n1. 创建 about.html\n2. 截图验证',
      resolved: false,
    });

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
        },
      },
    };

    const result = await adapter.handleClaudePlanExitCardAction(
      {
        open_id: 'ou_123',
        tenant_key: 'tenant',
        token: 'token',
        open_message_id: 'card-msg-1',
        action: {
          value: { callback_data: 'planexit:approve:bypass:wf-claude-followup-confirm' },
          tag: 'button',
        },
      },
      'planexit:approve:bypass:wf-claude-followup-confirm',
    );

    assert.equal(result.toast.type, 'success');
    assert.equal(store.getChannelBinding('feishu', 'group-claude-followup-confirm')?.mode, 'code');
    assert.equal(store.getChannelBinding('feishu', 'group-claude-followup-confirm')?.claudePermissionMode, 'bypassPermissions');
    assert.equal(store.getPlanWorkflow('wf-claude-followup-confirm'), null);
    assert.equal((adapter as any).queue.length, 1);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.kind, 'plan_execute');
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.permissionMode, 'bypassPermissions');
    assert.deepEqual(resolutions, []);
  });

  it('treats Claude replies after plan confirmation as plan adjustments in the same thread', async () => {
    const store = new JsonFileStore(makeSettings());
    const resolutions: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: (_id: string, resolution: any) => {
          resolutions.push(resolution);
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
      channelType: 'feishu',
      chatId: 'group-claude-continue',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-claude-continue',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-claude-continue',
      codepilotSessionId: session.id,
      status: 'awaiting_confirmation',
      previousMode: 'code',
      requestText: '生成单文件页面',
      address: { channelType: 'feishu', chatId: 'group-claude-continue', threadId: 'thread-1' },
      routeKey: 'group-claude-continue:thread:thread-1',
      requestMessageId: 'user-1',
      actionCardMessageId: 'card-msg-1',
      approvalRequestId: 'perm-exit-2',
      planText: '# 当前计划\n\n1. 创建 about.html\n2. 截图验证',
      planFilePath: '/Users/shesong/.claude/plans/demo.md',
      resolved: false,
    });

    const adapter = new FeishuAdapter() as any;
    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'user-2',
        address: { channelType: 'feishu', chatId: 'group-claude-continue', threadId: 'thread-1' },
        text: '把计划压缩成两步，并去掉多余样式',
        timestamp: Date.now(),
      },
    );

    assert.equal(store.getPlanWorkflow('wf-claude-continue')?.status, 'planning');
    assert.equal(store.getPlanWorkflow('wf-claude-continue')?.requestText, '把计划压缩成两步，并去掉多余样式');
    assert.equal(resolutions[0].behavior, 'deny');
    assert.equal(resolutions[0].message, CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE);
    assert.equal(resolutions[0].interrupt, true);
    assert.equal((adapter as any).queue.length, 1);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.kind, 'plan_request');
    assert.match((adapter as any).queue[0].bridgeMeta.planWorkflow.promptText, /上一轮已生成的计划文本/);
    assert.match((adapter as any).queue[0].bridgeMeta.planWorkflow.promptText, /创建 about\.html/);
    assert.match((adapter as any).queue[0].bridgeMeta.planWorkflow.promptText, /不要读取、查找、编辑或依赖任何“计划文件”/);
    assert.match((adapter as any).queue[0].bridgeMeta.planWorkflow.promptText, /demo\.md/);
  });

  it('restarts Claude planning with a fresh plan turn when the confirmation request already expired', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-claude-replan',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-claude-replan',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-claude-replan',
      codepilotSessionId: session.id,
      status: 'awaiting_confirmation',
      previousMode: 'code',
      requestText: '生成单文件页面',
      address: { channelType: 'feishu', chatId: 'group-claude-replan', threadId: 'thread-1' },
      routeKey: 'group-claude-replan:thread:thread-1',
      requestMessageId: 'user-1',
      actionCardMessageId: 'card-msg-1',
      approvalRequestId: 'perm-exit-4',
      planText: '# 当前计划\n\n1. 创建页面\n2. 浏览器打开验证',
      resolved: false,
    });

    const adapter = new FeishuAdapter() as any;
    await adapter.handleGroupMessage(
      { id: 'ou_123', type: 'open_id' },
      {
        messageId: 'user-2',
        address: { channelType: 'feishu', chatId: 'group-claude-replan', threadId: 'thread-1' },
        text: '把步骤改成两步',
        timestamp: Date.now(),
      },
    );

    assert.equal(store.getPlanWorkflow('wf-claude-replan')?.status, 'planning');
    assert.equal((adapter as any).queue.length, 1);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.kind, 'plan_request');
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.permissionMode, 'plan');
    assert.match((adapter as any).queue[0].bridgeMeta.planWorkflow.promptText, /上一轮已生成的计划文本/);
  });

  it('clears context for Claude plan approval by rotating the session and queueing a fresh execution turn', async () => {
    const store = new JsonFileStore(makeSettings());
    const resolutions: Array<Record<string, unknown>> = [];
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: (_id: string, resolution: any) => {
          resolutions.push(resolution);
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
      channelType: 'feishu',
      chatId: 'group-claude-clear',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.upsertPlanWorkflow({
      workflowId: 'wf-claude-clear',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-claude-clear',
      codepilotSessionId: session.id,
      status: 'awaiting_confirmation',
      previousMode: 'code',
      requestText: '生成单文件页面',
      address: { channelType: 'feishu', chatId: 'group-claude-clear', threadId: 'thread-1' },
      routeKey: 'group-claude-clear:thread:thread-1',
      requestMessageId: 'user-1',
      actionCardMessageId: 'card-msg-1',
      approvalRequestId: 'perm-exit-3',
      planText: '# 计划\n\n1. 创建 HTML\n2. 打开浏览器截图',
      resolved: false,
    });

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
        },
      },
    };

    const result = await adapter.handleClaudePlanExitCardAction(
      {
        open_id: 'ou_123',
        tenant_key: 'tenant',
        token: 'token',
        open_message_id: 'card-msg-1',
        action: {
          value: { callback_data: 'planexit:clear:bypass:wf-claude-clear' },
          tag: 'button',
        },
      },
      'planexit:clear:bypass:wf-claude-clear',
    );

    assert.equal(result.toast.type, 'success');
    const updatedBinding = store.getChannelBinding('feishu', 'group-claude-clear');
    assert.ok(updatedBinding);
    assert.notEqual(updatedBinding!.codepilotSessionId, binding.codepilotSessionId);
    assert.equal(updatedBinding!.mode, 'code');
    assert.equal(updatedBinding!.claudePermissionMode, 'bypassPermissions');
    assert.equal(updatedBinding!.sdkSessionId, '');
    assert.equal(store.getPlanWorkflow('wf-claude-clear'), null);
    assert.equal((adapter as any).queue.length, 1);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.kind, 'plan_execute');
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.permissionMode, 'bypassPermissions');
    assert.match((adapter as any).queue[0].bridgeMeta.planWorkflow.promptText, /已确认计划/);
    assert.deepEqual(resolutions[0], {
      behavior: 'deny',
      message: 'The user approved the plan but wants execution to restart in a fresh session with cleared context. Stop planning here.',
      interrupt: true,
    });
  });

  it('falls back to a fresh execution turn when Claude bypass approval has already expired', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext({
      store,
      llm: {} as any,
      permissions: {
        resolvePendingPermission: () => false,
      },
      lifecycle: {},
    });

    const session = store.createRuntimeSession({
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      cwd: '/tmp/test-cwd',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'group-claude-bypass-expired',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'claude-sonnet-4-6',
    });
    store.updateChannelBinding(binding.id, { mode: 'ask' });
    store.upsertPlanWorkflow({
      workflowId: 'wf-claude-bypass-expired',
      bindingId: binding.id,
      channelType: 'feishu',
      chatId: 'group-claude-bypass-expired',
      codepilotSessionId: session.id,
      status: 'awaiting_confirmation',
      previousMode: 'ask',
      requestText: '生成单文件页面',
      address: { channelType: 'feishu', chatId: 'group-claude-bypass-expired', threadId: 'thread-1' },
      routeKey: 'group-claude-bypass-expired:thread:thread-1',
      requestMessageId: 'user-1',
      actionCardMessageId: 'card-msg-1',
      approvalRequestId: 'perm-exit-5',
      planText: '# 计划\n\n1. 创建 HTML\n2. 浏览器打开并截图',
      resolved: false,
    });

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
        },
      },
    };

    const result = await adapter.handleClaudePlanExitCardAction(
      {
        open_id: 'ou_123',
        tenant_key: 'tenant',
        token: 'token',
        open_message_id: 'card-msg-1',
        action: {
          value: { callback_data: 'planexit:approve:bypass:wf-claude-bypass-expired' },
          tag: 'button',
        },
      },
      'planexit:approve:bypass:wf-claude-bypass-expired',
    );

    assert.equal(result.toast.type, 'success');
    assert.equal(store.getChannelBinding('feishu', 'group-claude-bypass-expired')?.mode, 'code');
    assert.equal(store.getChannelBinding('feishu', 'group-claude-bypass-expired')?.claudePermissionMode, 'bypassPermissions');
    assert.equal(store.getPlanWorkflow('wf-claude-bypass-expired'), null);
    assert.equal((adapter as any).queue.length, 1);
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.kind, 'plan_execute');
    assert.equal((adapter as any).queue[0].bridgeMeta.planWorkflow.permissionMode, 'bypassPermissions');
    assert.match((adapter as any).queue[0].bridgeMeta.planWorkflow.promptText, /已确认计划/);
  });

  it('rejects card actions from senders outside the allowlist', async () => {
    const settings = makeSettings();
    settings.set('bridge_feishu_allowed_users', 'ou_authorized');
    const store = new JsonFileStore(settings);
    installContext(store, {
      ensureRuntimeAvailable: async () => {},
    });

    let chatCreateCalls = 0;
    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          create: async () => {
            chatCreateCalls += 1;
            return { code: 0, data: { chat_id: 'should-not-create' } };
          },
        },
        message: {
          create: async () => ({ code: 0, data: { message_id: 'never' } }),
          patch: async () => ({ code: 0, data: {} }),
        },
      },
    };

    const result = await adapter.handleCardAction({
      open_id: 'ou_attacker',
      tenant_key: 'tenant',
      token: 'token',
      open_message_id: 'open-card-attacker',
      operator: { open_id: 'ou_attacker' },
      context: { open_chat_id: 'chat-shared' },
      action: {
        tag: 'button',
        value: { callback_data: 'new-session:codex:plan' },
        form_value: { new_session_workdir: '/tmp/codex-plan' },
      },
    });

    assert.equal(result.toast.type, 'warning');
    assert.equal(chatCreateCalls, 0);
    assert.equal(store.listChannelBindings().length, 0);
  });

  it('accepts card actions from senders inside the allowlist', async () => {
    const settings = makeSettings();
    settings.set('bridge_feishu_allowed_users', 'ou_authorized');
    const store = new JsonFileStore(settings);
    installContext(store, {
      ensureRuntimeAvailable: async () => {},
    });

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          create: async () => ({ code: 0, data: { chat_id: 'chat-allowed' } }),
        },
        message: {
          create: async () => ({ code: 0, data: { message_id: 'group-msg-1' } }),
          patch: async () => ({ code: 0, data: {} }),
        },
      },
    };

    const result = await adapter.handleCardAction({
      open_id: 'ou_authorized',
      tenant_key: 'tenant',
      token: 'token',
      open_message_id: 'open-card-allowed',
      operator: { open_id: 'ou_authorized' },
      context: { open_chat_id: 'chat-allowed' },
      action: {
        tag: 'button',
        value: { callback_data: 'new-session:codex:plan' },
        form_value: { new_session_workdir: '/tmp/codex-plan' },
      },
    });

    assert.equal(result.toast.type, 'success');
    assert.ok(store.getChannelBinding('feishu', 'chat-allowed'));
  });
});
