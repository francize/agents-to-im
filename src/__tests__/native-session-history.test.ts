import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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
});
