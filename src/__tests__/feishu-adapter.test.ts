import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { initBridgeContext } from '../bridge/context.js';

import { CTI_HOME } from '../config.js';
import { FeishuAdapter, findMissingAppScopes } from '../feishu/adapter.js';
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
    assert.equal(card.body.elements[0].elements[3].tag, 'input');
    assert.equal(card.body.elements[0].elements[3].name, 'structured-input_req_1_other_q1');
    assert.equal(card.body.elements[0].elements[4].tag, 'markdown');
    assert.match(card.body.elements[0].elements[4].content, /可填写上面的自定义输入框/);
    assert.equal(card.body.elements[0].elements.at(-1).tag, 'column_set');
    assert.equal(card.body.elements[0].elements.at(-1).columns[0].elements[0].tag, 'button');
    assert.equal(card.body.elements[0].elements.at(-1).columns[0].elements[0].form_action_type, 'submit');
    assert.equal(
      card.body.elements[0].elements.at(-1).columns[0].elements[0].behaviors[0].value.callback_data,
      'input:submit:req-1',
    );
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
    assert.equal((bodyElements[2]?.text as { content?: string } | undefined)?.content, '已提交：极简');
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

    const adapter = new FeishuAdapter() as any;
    adapter.restClient = {
      im: {
        chat: {
          update: async () => ({ code: 0, data: {} }),
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
  });
});
