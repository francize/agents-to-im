import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  listClaudeNativeWorkspaces,
  listCodexNativeWorkspaces,
  listRecentNativeSessions,
  loadNativeSessionTranscript,
  readClaudeSessionTitle,
  writeClaudeSessionTitle,
} from '../infra/native-session-history.js';

function writeJsonl(filePath: string, records: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n'));
}

describe('native-session-history', () => {
  it('lists and replays codex sessions from raw history while filtering bridge metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-codex-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;

    try {
      const workdir = '/tmp/project';
      const sessionId = 'session-codex-1';
      fs.mkdirSync(path.join(tempDir, 'sessions', '2026', '03', '28'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'session_index.jsonl'),
        [
          JSON.stringify({
            id: sessionId,
            thread_name: '修复 bridge 卡片',
            updated_at: '2026-03-28T08:00:00.000Z',
          }),
          JSON.stringify({
            id: 'session-codex-2',
            thread_name: '忽略的其他工程',
            updated_at: '2026-03-28T07:00:00.000Z',
          }),
        ].join('\n'),
      );
      writeJsonl(
        path.join(tempDir, 'sessions', '2026', '03', '28', `rollout-2026-03-28-${sessionId}.jsonl`),
        [
          {
            type: 'session_meta',
            payload: { id: sessionId, cwd: workdir },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/tmp/project</cwd>\n</environment_context>' }],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '请修复卡片标题' }],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'reasoning', summary: '先分析一下问题' },
                { type: 'output_text', text: '我先检查适配层实现。' },
              ],
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'reasoning', summary: '这段内部思考不该回放' }],
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
              output: 'Exit code: 0\nOutput:\nREADME.md',
            },
          },
        ],
      );
      writeJsonl(
        path.join(tempDir, 'sessions', '2026', '03', '28', 'rollout-2026-03-28-session-codex-2.jsonl'),
        [
          {
            type: 'session_meta',
            payload: { id: 'session-codex-2', cwd: '/tmp/other-project' },
          },
        ],
      );

      const sessions = listRecentNativeSessions('codex', '/tmp/project', 5);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.title, '修复 bridge 卡片');

      const transcript = loadNativeSessionTranscript('codex', sessionId, '/tmp/project');
      assert.ok(transcript);
      assert.deepEqual(
        transcript!.items.map((item) => [item.kind, item.text]),
        [
          ['user_message', '请修复卡片标题'],
          ['assistant_message', '我先检查适配层实现。'],
          ['tool_result', 'shell_command\nExit code: 0\nOutput:\nREADME.md'],
        ],
      );
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lists and replays claude sessions using custom-title > ai-title > first prompt precedence', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-'));
    const previousClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = tempDir;

    try {
      const workdir = '/tmp/claude-project';
      const bucketDir = path.join(tempDir, 'projects', '-tmp-claude-project');
      const sessionFile = path.join(bucketDir, 'session-claude-1.jsonl');
      writeJsonl(sessionFile, [
        { type: 'queue-operation', operation: 'enqueue' },
        {
          type: 'ai-title',
          aiTitle: 'AI 生成标题',
        },
        {
          type: 'custom-title',
          customTitle: '手动改名后的标题',
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '请恢复最近的群聊历史' }],
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '这是一段内部思考' }],
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '我会先读取原始会话。' }],
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp/claude-project', is_error: false }],
          },
        },
      ]);
      fs.utimesSync(sessionFile, new Date('2026-03-28T09:00:00.000Z'), new Date('2026-03-28T09:00:00.000Z'));

      const sessions = listRecentNativeSessions('claude', workdir, 5);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]!.title, '手动改名后的标题');
      assert.equal(readClaudeSessionTitle('session-claude-1', workdir), '手动改名后的标题');

      const transcript = loadNativeSessionTranscript('claude', 'session-claude-1', workdir);
      assert.ok(transcript);
      assert.deepEqual(
        transcript!.items.map((item) => [item.kind, item.text]),
        [
          ['user_message', '请恢复最近的群聊历史'],
          ['assistant_message', '我会先读取原始会话。'],
          ['tool_result', '/tmp/claude-project'],
        ],
      );
    } finally {
      process.env.CLAUDE_HOME = previousClaudeHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('appends claude custom-title entries for manual renames', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-write-'));
    const previousClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = tempDir;

    try {
      const workdir = '/tmp/claude-project-write';
      const sessionFile = path.join(tempDir, 'projects', '-tmp-claude-project-write', 'session-claude-write.jsonl');
      writeJsonl(sessionFile, [
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '请同步这个标题' }],
          },
        },
      ]);

      assert.equal(readClaudeSessionTitle('session-claude-write', workdir), '请同步这个标题');
      assert.equal(writeClaudeSessionTitle('session-claude-write', workdir, '群聊手动改名'), true);
      assert.equal(readClaudeSessionTitle('session-claude-write', workdir), '群聊手动改名');

      const raw = fs.readFileSync(sessionFile, 'utf8');
      assert.match(raw, /"type":"custom-title"/);
      assert.match(raw, /"customTitle":"群聊手动改名"/);
    } finally {
      process.env.CLAUDE_HOME = previousClaudeHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lists claude native workspaces by parsing real cwd from jsonl, not from the encoded dir name', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-ws-'));
    const previousClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = tempDir;

    try {
      // Project A: normal path with `-` inside cwd (encoded dir name is lossy).
      const projectA = path.join(tempDir, 'projects', '-Users-me-codes-agents-to-im');
      writeJsonl(path.join(projectA, 'older.jsonl'), [
        { type: 'operation', timestamp: '2026-03-28T01:00:00.000Z' },
        { type: 'user', cwd: '/Users/me/codes/agents-to-im', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      ]);
      writeJsonl(path.join(projectA, 'newer.jsonl'), [
        { type: 'user', cwd: '/Users/me/codes/agents-to-im', message: { role: 'user', content: [{ type: 'text', text: 'later' }] } },
      ]);
      fs.utimesSync(
        path.join(projectA, 'older.jsonl'),
        new Date('2026-03-28T01:00:00.000Z'),
        new Date('2026-03-28T01:00:00.000Z'),
      );
      fs.utimesSync(
        path.join(projectA, 'newer.jsonl'),
        new Date('2026-03-28T05:00:00.000Z'),
        new Date('2026-03-28T05:00:00.000Z'),
      );

      // Project B: dir name with ambiguous dashes, real cwd contains non-ASCII.
      const projectB = path.join(tempDir, 'projects', '-Users-me-Documents-------');
      writeJsonl(path.join(projectB, 'session.jsonl'), [
        { type: 'summary', leafUuid: 'x' },
        { type: 'user', cwd: '/Users/me/Documents/小予踩打照片', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ]);
      fs.utimesSync(
        path.join(projectB, 'session.jsonl'),
        new Date('2026-03-28T03:00:00.000Z'),
        new Date('2026-03-28T03:00:00.000Z'),
      );

      // Project C: no cwd field anywhere — should be skipped silently.
      const projectC = path.join(tempDir, 'projects', '-tmp-legacy-without-cwd');
      writeJsonl(path.join(projectC, 'legacy.jsonl'), [
        { type: 'operation', timestamp: '2026-03-28T02:00:00.000Z' },
        { type: 'operation', timestamp: '2026-03-28T02:00:01.000Z' },
      ]);

      // Project D: empty directory — should be skipped.
      fs.mkdirSync(path.join(tempDir, 'projects', '-tmp-empty'), { recursive: true });

      const workspaces = listClaudeNativeWorkspaces();
      const values = workspaces.map((item) => item.workingDirectory).sort();
      assert.deepEqual(values, [
        path.resolve('/Users/me/Documents/小予踩打照片'),
        path.resolve('/Users/me/codes/agents-to-im'),
      ]);

      const projectAEntry = workspaces.find(
        (item) => item.workingDirectory === path.resolve('/Users/me/codes/agents-to-im'),
      );
      assert.equal(projectAEntry?.updatedAt, new Date('2026-03-28T05:00:00.000Z').toISOString());
    } finally {
      process.env.CLAUDE_HOME = previousClaudeHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty list when claude projects root does not exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-empty-'));
    const previousClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = tempDir;
    try {
      assert.deepEqual(listClaudeNativeWorkspaces(), []);
    } finally {
      process.env.CLAUDE_HOME = previousClaudeHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lists codex native workspaces from session_meta, spanning sessions and archived_sessions, picking the newest mtime per cwd', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-codex-ws-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;

    try {
      const activeDir = path.join(tempDir, 'sessions', '2026', '03', '28');
      const archivedDir = path.join(tempDir, 'archived_sessions');

      // Two sessions in active dir pointing at the same cwd — expect the newer mtime to win.
      const olderActive = path.join(activeDir, 'rollout-older.jsonl');
      writeJsonl(olderActive, [
        { type: 'session_meta', payload: { id: 'codex-older', cwd: '/tmp/codex-project' } },
      ]);
      fs.utimesSync(
        olderActive,
        new Date('2026-03-28T02:00:00.000Z'),
        new Date('2026-03-28T02:00:00.000Z'),
      );

      const newerActive = path.join(activeDir, 'rollout-newer.jsonl');
      writeJsonl(newerActive, [
        { type: 'session_meta', payload: { id: 'codex-newer', cwd: '/tmp/codex-project' } },
      ]);
      fs.utimesSync(
        newerActive,
        new Date('2026-03-28T07:00:00.000Z'),
        new Date('2026-03-28T07:00:00.000Z'),
      );

      // Archived session for a different cwd — should also surface.
      const archived = path.join(archivedDir, 'rollout-archived.jsonl');
      writeJsonl(archived, [
        { type: 'session_meta', payload: { id: 'codex-archived', cwd: '/tmp/codex-old-project' } },
      ]);
      fs.utimesSync(
        archived,
        new Date('2026-03-28T04:00:00.000Z'),
        new Date('2026-03-28T04:00:00.000Z'),
      );

      // Malformed file (no session_meta) — should be ignored silently.
      const malformed = path.join(activeDir, 'rollout-malformed.jsonl');
      writeJsonl(malformed, [
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
      ]);

      const workspaces = listCodexNativeWorkspaces();
      const sorted = [...workspaces].sort((left, right) =>
        left.workingDirectory.localeCompare(right.workingDirectory),
      );
      assert.deepEqual(
        sorted.map((item) => item.workingDirectory),
        [path.resolve('/tmp/codex-old-project'), path.resolve('/tmp/codex-project')],
      );
      const active = sorted.find(
        (item) => item.workingDirectory === path.resolve('/tmp/codex-project'),
      );
      assert.equal(active?.updatedAt, new Date('2026-03-28T07:00:00.000Z').toISOString());
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty list when codex sessions roots do not exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-codex-empty-'));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;
    try {
      assert.deepEqual(listCodexNativeWorkspaces(), []);
    } finally {
      process.env.CODEX_HOME = previousCodexHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
