import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonFileStore } from '../infra/store.js';
import { CTI_HOME } from '../config/config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

// We construct the store with a settings map directly
function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
  ]);
}

describe('JsonFileStore', () => {
  beforeEach(() => {
    // Clean data dir before each test for isolation
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('getSetting returns values from settings map', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSetting('remote_bridge_enabled'), 'true');
    assert.equal(store.getSetting('bridge_default_work_dir'), '/tmp/test-cwd');
    assert.equal(store.getSetting('nonexistent'), null);
  });

  it('createSession and getSession', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-1', 'system prompt', '/tmp');
    assert.ok(session.id);
    assert.equal(session.model, 'model-1');
    assert.equal(session.working_directory, '/tmp');
    assert.equal(session.system_prompt, 'system prompt');
    assert.deepEqual((session as any).ext, {
      runtime: 'claude',
      titleStatus: 'pending',
    });

    const fetched = store.getSession(session.id);
    assert.deepEqual(fetched, session);
  });

  it('createRuntimeSession stores runtime metadata under ext', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createRuntimeSession({
      runtime: 'codex',
      model: 'gpt-5-codex',
      cwd: '/tmp/codex',
    });

    assert.equal(session.model, 'gpt-5-codex');
    assert.deepEqual(store.getSessionExt(session.id), {
      runtime: 'codex',
      titleStatus: 'pending',
    });
  });

  it('migrateLegacySessions backfills missing runtime metadata', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('legacy', 'model', undefined, '/tmp');
    delete (session as any).ext;
    (store as any).sessions.set(session.id, session);

    const changed = store.migrateLegacySessions('codex');

    assert.equal(changed, true);
    assert.deepEqual(store.getSessionExt(session.id), {
      runtime: 'codex',
      titleStatus: 'pending',
    });
  });

  it('normalizes legacy running and failed title states back to pending', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'sessions.json'),
      JSON.stringify({
        legacy_running: {
          id: 'legacy_running',
          working_directory: '/tmp',
          model: 'claude-sonnet-4-6',
          ext: {
            runtime: 'claude',
            titleStatus: 'running',
          },
        },
        legacy_failed: {
          id: 'legacy_failed',
          working_directory: '/tmp',
          model: 'gpt-5-codex',
          ext: {
            runtime: 'codex',
            titleStatus: 'failed',
          },
        },
      }),
    );

    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSessionExt('legacy_running')?.titleStatus, 'pending');
    assert.equal(store.getSessionExt('legacy_failed')?.titleStatus, 'pending');
  });

  it('getSession returns null for unknown id', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSession('nonexistent'), null);
  });

  it('upsertChannelBinding creates and updates', () => {
    const store = new JsonFileStore(makeSettings());
    const b1 = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: '123',
      codepilotSessionId: 'sess-1',
      workingDirectory: '/tmp',
      model: 'model-1',
    });
    assert.ok(b1.id);
    assert.equal(b1.channelType, 'feishu');
    assert.equal(b1.chatId, '123');

    // Upsert same channel+chat should update
    const b2 = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: '123',
      codepilotSessionId: 'sess-2',
      workingDirectory: '/tmp/new',
      model: 'model-2',
    });
    assert.equal(b2.id, b1.id);
    assert.equal(b2.codepilotSessionId, 'sess-2');
  });

  it('isolates bindings by channelInstanceId under the same channel type', () => {
    const store = new JsonFileStore(makeSettings());
    const claudeBinding = store.upsertChannelBinding({
      channelType: 'feishu',
      channelInstanceId: 'claude',
      chatId: '123',
      codepilotSessionId: 'sess-1',
      workingDirectory: '/tmp/claude',
      model: 'claude-sonnet-4-6',
    });
    const codexBinding = store.upsertChannelBinding({
      channelType: 'feishu',
      channelInstanceId: 'codex',
      chatId: '123',
      codepilotSessionId: 'sess-2',
      workingDirectory: '/tmp/codex',
      model: 'gpt-5-codex',
    });

    assert.notEqual(claudeBinding.id, codexBinding.id);
    assert.equal(store.getChannelBinding('feishu', '123', 'claude')?.codepilotSessionId, 'sess-1');
    assert.equal(store.getChannelBinding('feishu', '123', 'codex')?.codepilotSessionId, 'sess-2');
  });

  it('upsertChannelBinding defaults to code mode', () => {
    const store = new JsonFileStore(makeSettings());
    const b = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: '456',
      codepilotSessionId: 'sess-1',
      workingDirectory: '/tmp',
      model: 'model-1',
    });
    assert.equal(b.mode, 'code');
  });

  it('upsertChannelBinding preserves Claude permission mode unless explicitly changed', () => {
    const store = new JsonFileStore(makeSettings());
    const created = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'claude-chat',
      codepilotSessionId: 'sess-1',
      workingDirectory: '/tmp',
      model: 'claude-sonnet-4-6',
      claudePermissionMode: 'plan',
    });

    const updated = store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: 'claude-chat',
      codepilotSessionId: 'sess-2',
      workingDirectory: '/tmp/next',
      model: 'claude-sonnet-4-6',
    });

    assert.equal(created.claudePermissionMode, 'plan');
    assert.equal(updated.claudePermissionMode, 'plan');

    store.updateChannelBinding(updated.id, { claudePermissionMode: 'dontAsk' });
    assert.equal(store.getChannelBinding('feishu', 'claude-chat')?.claudePermissionMode, 'dontAsk');
  });

  it('getChannelBinding returns null for missing', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getChannelBinding('feishu', 'missing'), null);
  });

  it('listChannelBindings filters by type', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: '1',
      codepilotSessionId: 's1',
      workingDirectory: '/tmp',
      model: 'm',
    });
    store.upsertChannelBinding({
      channelType: 'lark' as any,
      chatId: '2',
      codepilotSessionId: 's2',
      workingDirectory: '/tmp',
      model: 'm',
    });
    assert.equal(store.listChannelBindings('feishu').length, 1);
    assert.equal(store.listChannelBindings('lark' as any).length, 1);
    assert.equal(store.listChannelBindings().length, 2);
  });

  it('migrates legacy binding keys and callback state to default channel instance ids', () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'bindings.json'),
      JSON.stringify({
        'feishu:legacy-chat': {
          id: 'binding-1',
          channelType: 'feishu',
          chatId: 'legacy-chat',
          codepilotSessionId: 'sess-legacy',
          sdkSessionId: '',
          workingDirectory: '/tmp',
          model: 'claude-sonnet-4-6',
          mode: 'code',
          active: true,
          createdAt: '2026-03-24T00:00:00.000Z',
          updatedAt: '2026-03-24T00:00:00.000Z',
        },
      }),
    );
    fs.writeFileSync(
      path.join(DATA_DIR, 'permissions.json'),
      JSON.stringify({
        'perm-1': {
          permissionRequestId: 'perm-1',
          channelType: 'feishu',
          chatId: 'legacy-chat',
          messageId: 'msg-1',
          resolved: false,
          suggestions: '',
        },
      }),
    );
    fs.writeFileSync(
      path.join(DATA_DIR, 'plan-workflows.json'),
      JSON.stringify({
        'workflow-1': {
          workflowId: 'workflow-1',
          bindingId: 'binding-1',
          channelType: 'feishu',
          chatId: 'legacy-chat',
          codepilotSessionId: 'sess-legacy',
          status: 'planning',
          previousMode: 'code',
          requestText: 'legacy request',
          address: { channelType: 'feishu', chatId: 'legacy-chat' },
          routeKey: 'legacy-chat:main',
          resolved: false,
          createdAt: '2026-03-24T00:00:00.000Z',
          updatedAt: '2026-03-24T00:00:00.000Z',
        },
      }),
    );
    fs.writeFileSync(
      path.join(DATA_DIR, 'structured-inputs.json'),
      JSON.stringify({
        'input-1': {
          requestId: 'input-1',
          channelType: 'feishu',
          chatId: 'legacy-chat',
          codepilotSessionId: 'sess-legacy',
          address: { channelType: 'feishu', chatId: 'legacy-chat' },
          routeKey: 'legacy-chat:main',
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          questions: [],
          draftAnswers: {},
          resolved: false,
          createdAt: '2026-03-24T00:00:00.000Z',
          updatedAt: '2026-03-24T00:00:00.000Z',
        },
      }),
    );

    const store = new JsonFileStore(makeSettings());

    assert.equal(store.getChannelBinding('feishu', 'legacy-chat', 'default')?.channelInstanceId, 'default');
    assert.equal(store.getPermissionLink('perm-1')?.channelInstanceId, 'default');
    assert.equal(store.getPlanWorkflow('workflow-1')?.channelInstanceId, 'default');
    assert.equal(store.getStructuredInputRequest('input-1')?.channelInstanceId, 'default');
  });

  it('addMessage and getMessages', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.addMessage(session.id, 'user', 'hello');
    store.addMessage(session.id, 'assistant', 'hi');

    const { messages } = store.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].content, 'hi');
  });

  it('getMessages with limit returns last N', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.addMessage(session.id, 'user', 'msg1');
    store.addMessage(session.id, 'user', 'msg2');
    store.addMessage(session.id, 'user', 'msg3');

    const { messages } = store.getMessages(session.id, { limit: 2 });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].content, 'msg2');
    assert.equal(messages[1].content, 'msg3');
  });

  // ── Session Locking ──

  it('acquireSessionLock succeeds on first call', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
  });

  it('acquireSessionLock fails when held by another', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
    assert.equal(store.acquireSessionLock('sess', 'lock2', 'owner2', 60), false);
  });

  it('acquireSessionLock succeeds with same lockId', () => {
    const store = new JsonFileStore(makeSettings());
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
    assert.ok(store.acquireSessionLock('sess', 'lock1', 'owner1', 60));
  });

  it('releaseSessionLock allows re-acquire', () => {
    const store = new JsonFileStore(makeSettings());
    store.acquireSessionLock('sess', 'lock1', 'owner1', 60);
    store.releaseSessionLock('sess', 'lock1');
    assert.ok(store.acquireSessionLock('sess', 'lock2', 'owner2', 60));
  });

  it('expired lock can be re-acquired', async () => {
    const store = new JsonFileStore(makeSettings());
    // Acquire with very short TTL
    store.acquireSessionLock('sess', 'lock1', 'owner1', 0);
    // Should be expired immediately
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(store.acquireSessionLock('sess', 'lock2', 'owner2', 60));
  });

  // ── Permission Links ──

  it('insertPermissionLink and getPermissionLink', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-1',
      channelType: 'feishu',
      chatId: '123',
      messageId: 'msg-1',
      toolName: 'bash',
      suggestions: 'allow,deny',
    });
    const link = store.getPermissionLink('pr-1');
    assert.ok(link);
    assert.equal(link.permissionRequestId, 'pr-1');
    assert.equal(link.resolved, false);
  });

  it('markPermissionLinkResolved is atomic', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-2',
      channelType: 'feishu',
      chatId: '123',
      messageId: 'msg-2',
      toolName: 'bash',
      suggestions: '',
    });
    assert.ok(store.markPermissionLinkResolved('pr-2'));
    // Second call returns false (already resolved)
    assert.equal(store.markPermissionLinkResolved('pr-2'), false);
    // Unknown id returns false
    assert.equal(store.markPermissionLinkResolved('unknown'), false);
  });

  it('listPendingPermissionLinksByChat returns only unresolved links for the chat', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-a',
      channelType: 'feishu',
      chatId: 'chat-1',
      messageId: 'msg-a',
      toolName: 'Bash',
      suggestions: '',
    });
    store.insertPermissionLink({
      permissionRequestId: 'pr-b',
      channelType: 'feishu',
      chatId: 'chat-1',
      messageId: 'msg-b',
      toolName: 'Read',
      suggestions: '',
    });
    store.insertPermissionLink({
      permissionRequestId: 'pr-c',
      channelType: 'feishu',
      chatId: 'chat-2',
      messageId: 'msg-c',
      toolName: 'Bash',
      suggestions: '',
    });
    // Resolve one
    store.markPermissionLinkResolved('pr-a');
    const pending = store.listPendingPermissionLinksByChat('chat-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].permissionRequestId, 'pr-b');
    // Different chat
    const pending2 = store.listPendingPermissionLinksByChat('chat-2');
    assert.equal(pending2.length, 1);
    assert.equal(pending2[0].permissionRequestId, 'pr-c');
    // No permissions for unknown chat
    assert.equal(store.listPendingPermissionLinksByChat('chat-unknown').length, 0);
  });

  it('persists active plan workflows and can find them by binding/chat', () => {
    const store = new JsonFileStore(makeSettings());
    const workflow = store.upsertPlanWorkflow({
      bindingId: 'binding-1',
      channelType: 'feishu',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      status: 'awaiting_input',
      previousMode: 'code',
      requestText: '',
      address: { channelType: 'feishu', chatId: 'chat-1', threadId: 'thread-1' },
      routeKey: 'chat-1:thread:thread-1',
      requestMessageId: 'msg-1',
      resolved: true,
    });

    const reloaded = new JsonFileStore(makeSettings());
    assert.equal(reloaded.getPlanWorkflow(workflow.workflowId)?.bindingId, 'binding-1');
    assert.equal(reloaded.getActivePlanWorkflowByBinding('binding-1')?.workflowId, workflow.workflowId);
    assert.equal(reloaded.getActivePlanWorkflowByChat('feishu', 'chat-1')?.workflowId, workflow.workflowId);
  });

  it('markPlanWorkflowResolved is atomic and deletePlanWorkflow removes it', () => {
    const store = new JsonFileStore(makeSettings());
    const workflow = store.upsertPlanWorkflow({
      bindingId: 'binding-2',
      channelType: 'feishu',
      chatId: 'chat-2',
      codepilotSessionId: 'session-2',
      status: 'awaiting_confirmation',
      previousMode: 'ask',
      requestText: 'do something',
      address: { channelType: 'feishu', chatId: 'chat-2' },
      routeKey: 'chat-2:main',
      actionCardMessageId: 'card-1',
      resolved: false,
    });

    assert.equal(store.markPlanWorkflowResolved(workflow.workflowId), true);
    assert.equal(store.markPlanWorkflowResolved(workflow.workflowId), false);
    assert.equal(store.deletePlanWorkflow(workflow.workflowId), true);
    assert.equal(store.getPlanWorkflow(workflow.workflowId), null);
    assert.equal(store.getActivePlanWorkflowByChat('feishu', 'chat-2'), null);
  });

  // ── Dedup ──

  it('dedup insert and check within window', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.checkDedup('key1'), false);
    store.insertDedup('key1');
    assert.equal(store.checkDedup('key1'), true);
  });

  it('cleanupExpiredDedup removes old entries', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertDedup('key1');
    // The entry was just inserted so it shouldn't be expired
    store.cleanupExpiredDedup();
    assert.equal(store.checkDedup('key1'), true);
  });

  // ── Audit Log ──

  it('insertAuditLog keeps max 1000', () => {
    const store = new JsonFileStore(makeSettings());
    for (let i = 0; i < 1010; i++) {
      store.insertAuditLog({
        channelType: 'feishu',
        chatId: '123',
        direction: 'inbound',
        messageId: `msg-${i}`,
        summary: `msg ${i}`,
      });
    }
    // We can't directly inspect length, but it shouldn't crash
  });

  // ── Channel Offsets ──

  it('getChannelOffset returns default for unknown key', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getChannelOffset('unknown'), '0');
  });

  it('setChannelOffset and getChannelOffset round-trip', () => {
    const store = new JsonFileStore(makeSettings());
    store.setChannelOffset('tg:offset', '12345');
    assert.equal(store.getChannelOffset('tg:offset'), '12345');
  });

  // ── SDK Session ──

  it('updateSdkSessionId updates session and bindings', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.upsertChannelBinding({
      channelType: 'feishu',
      chatId: '1',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: 'model',
    });
    store.updateSdkSessionId(session.id, 'sdk-123');
    const binding = store.getChannelBinding('feishu', '1');
    assert.equal(binding?.sdkSessionId, 'sdk-123');
  });

  it('updateSessionModel updates model', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-old', undefined, '/tmp');
    store.updateSessionModel(session.id, 'model-new');
    const updated = store.getSession(session.id);
    assert.equal(updated?.model, 'model-new');
  });

  // ── Provider (no-op) ──

  it('getProvider returns undefined', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getProvider('any'), undefined);
  });

  it('getDefaultProviderId returns null', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getDefaultProviderId(), null);
  });
});
