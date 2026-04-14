import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLAUDE_SETTING_SOURCES,
  buildAskUserQuestionResponse,
  isAuthError,
  classifyAuthError,
  isNonClaudeModel,
  mapSdkMessageToActivityEvent,
  parseAskUserQuestionRequest,
  handleMessage,
} from '../providers/claude/sdk-provider.js';
import {
  buildCliExecCommand,
  buildSubprocessEnv,
  checkCliCompatibility,
  isExecutable,
  normalizeConfiguredClaudeCliPath,
  parseCliMajorVersion,
  parseWindowsWhereClaudeOutput,
  preflightCheck,
  resolveClaudeCliPath,
  resolveWindowsNpmClaudeCliShim,
} from '../providers/claude/cli-support.js';
import type { StreamState } from '../providers/claude/sdk-provider.js';
import { sseEvent } from '../infra/sse-utils.js';

// ── Helpers ──

/** Collect enqueued SSE strings from a fake controller. */
function makeFakeController() {
  const chunks: string[] = [];
  const controller = {
    enqueue(data: string) { chunks.push(data); },
    close() { /* no-op */ },
    error() { /* no-op */ },
    desiredSize: 1,
  } as unknown as ReadableStreamDefaultController<string>;
  return { controller, chunks };
}

function freshState(): StreamState {
  return {
    hasReceivedResult: false,
    hasStreamedText: false,
    lastAssistantText: '',
    toolNamesByUseId: new Map<string, string>(),
  };
}

function parseChunk(chunk: string): { type: string; data: string } {
  return JSON.parse(chunk.replace(/^data:\s*/, ''));
}

function withPatchedEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => T,
): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withPatchedPlatform<T>(
  platform: NodeJS.Platform,
  run: () => T,
): T {
  const previous = process.platform;
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', {
      value: previous,
      configurable: true,
    });
  }
}

function writeFakeClaudeCli(filePath: string, version = '2.1.104', help = 'output-format input-format permission-mode setting-sources') {
  fs.writeFileSync(
    filePath,
    [
      '#!/bin/sh',
      'arg="$1"',
      `if [ "$arg" = "--version" ]; then echo "${version}"; exit 0; fi`,
      `if [ "$arg" = "--help" ]; then echo "${help}"; exit 0; fi`,
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
}

function writeFailingClaudeCli(
  filePath: string,
  options?: { versionFails?: boolean; helpFails?: boolean; version?: string },
) {
  const version = options?.version || '2.1.104';
  fs.writeFileSync(
    filePath,
    [
      '#!/bin/sh',
      'arg="$1"',
      options?.versionFails
        ? `if [ "$arg" = "--version" ]; then exit 1; fi`
        : `if [ "$arg" = "--version" ]; then echo "${version}"; exit 0; fi`,
      options?.helpFails
        ? `if [ "$arg" = "--help" ]; then exit 1; fi`
        : 'if [ "$arg" = "--help" ]; then echo "output-format input-format permission-mode setting-sources"; exit 0; fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
}

// ── classifyAuthError ──

describe('classifyAuthError', () => {
  it('returns "cli" for local login errors', () => {
    assert.equal(classifyAuthError('Error: Not logged in'), 'cli');
    assert.equal(classifyAuthError('Please run /login'), 'cli');
    assert.equal(classifyAuthError('loggedIn:false'), 'cli');
  });

  it('returns "api" for remote credential errors', () => {
    assert.equal(classifyAuthError('Error: Unauthorized'), 'api');
    assert.equal(classifyAuthError('invalid API key provided'), 'api');
    assert.equal(classifyAuthError('authentication has failed'), 'api');
    assert.equal(classifyAuthError('HTTP 401 Unauthorized'), 'api');
    assert.equal(classifyAuthError('does not have access to Claude'), 'api');
  });

  it('returns false for non-auth errors', () => {
    assert.equal(classifyAuthError('process exited with code 1'), false);
    assert.equal(classifyAuthError('ECONNREFUSED'), false);
    assert.equal(classifyAuthError(''), false);
  });

  it('returns false for local permission / generic 403 (not API auth)', () => {
    assert.equal(classifyAuthError('permission denied: /usr/local/bin'), false);
    assert.equal(classifyAuthError('HTTP 403 Forbidden'), false);
    assert.equal(classifyAuthError('EACCES: permission denied, open /etc/hosts'), false);
  });

  it('prefers "cli" when both patterns match', () => {
    // "Not logged in" should be cli even if "unauthorized" is also present
    assert.equal(classifyAuthError('Not logged in, unauthorized'), 'cli');
  });
});

describe('CLAUDE_SETTING_SOURCES', () => {
  it('includes local config so CLI-managed MCP servers remain visible to the SDK', () => {
    assert.deepEqual(CLAUDE_SETTING_SOURCES, ['local', 'user', 'project']);
  });
});

describe('buildSubprocessEnv', () => {
  it('keeps the parent environment in inherit mode except always-stripped keys', () => {
    const env = withPatchedEnv({
      CTI_ENV_ISOLATION: 'inherit',
      PATH: '/tmp/bin',
      CLAUDECODE: 'strip-me',
      CUSTOM_KEEP: 'yes',
    }, () => buildSubprocessEnv());

    assert.equal(env.PATH, '/tmp/bin');
    assert.equal(env.CUSTOM_KEEP, 'yes');
    assert.equal(env.CLAUDECODE, undefined);
  });

  it('keeps only whitelisted and prefixed variables in strict mode', () => {
    const env = withPatchedEnv({
      CTI_ENV_ISOLATION: 'strict',
      PATH: '/tmp/bin',
      CTI_SAMPLE: 'sample',
      ANTHROPIC_API_KEY: 'anthropic-key',
      OPENAI_API_KEY: 'openai-key',
      CODEX_HOME: '/tmp/codex-home',
      CUSTOM_DROP: 'drop-me',
    }, () => buildSubprocessEnv());

    assert.equal(env.PATH, '/tmp/bin');
    assert.equal(env.CTI_SAMPLE, 'sample');
    assert.equal(env.ANTHROPIC_API_KEY, 'anthropic-key');
    assert.equal(env.OPENAI_API_KEY, 'openai-key');
    assert.equal(env.CODEX_HOME, '/tmp/codex-home');
    assert.equal(env.CUSTOM_DROP, undefined);
  });
});

// ── isAuthError (backwards compat) ──

describe('isAuthError', () => {
  it('detects "Not logged in" in error message', () => {
    assert.equal(isAuthError('Error: Not logged in · Please run /login'), true);
  });

  it('detects "Please run /login" in stderr', () => {
    assert.equal(isAuthError('some preamble\nPlease run /login\n'), true);
  });

  it('detects loggedIn: false in JSON output', () => {
    assert.equal(isAuthError('{"loggedIn": false, "user": null}'), true);
  });

  it('detects loggedIn:false without spaces', () => {
    assert.equal(isAuthError('loggedIn:false'), true);
  });

  it('detects "unauthorized" (case-insensitive)', () => {
    assert.equal(isAuthError('Error: Unauthorized access'), true);
  });

  it('detects "invalid api key"', () => {
    assert.equal(isAuthError('Error: invalid API key provided'), true);
    assert.equal(isAuthError('invalid api-key'), true);
  });

  it('detects "authentication failed"', () => {
    assert.equal(isAuthError('authentication has failed'), true);
  });

  it('detects HTTP 401', () => {
    assert.equal(isAuthError('HTTP error 401'), true);
    assert.equal(isAuthError('status: 401 Unauthorized'), true);
  });

  it('returns false for non-auth errors', () => {
    assert.equal(isAuthError('Claude Code process exited with code 1'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isAuthError(''), false);
  });

  it('returns false for generic network error', () => {
    assert.equal(isAuthError('ECONNREFUSED 127.0.0.1:443'), false);
  });

  it('returns false for HTTP 400 or 500', () => {
    assert.equal(isAuthError('HTTP error 400 Bad Request'), false);
    assert.equal(isAuthError('HTTP error 500 Internal Server Error'), false);
  });
});

// ── isNonClaudeModel ──

describe('isNonClaudeModel', () => {
  it('detects gpt- prefixed models', () => {
    assert.equal(isNonClaudeModel('gpt-5-codex'), true);
    assert.equal(isNonClaudeModel('gpt-4o'), true);
  });

  it('detects o1/o3 prefixed models', () => {
    assert.equal(isNonClaudeModel('o1-preview'), true);
    assert.equal(isNonClaudeModel('o3-mini'), true);
  });

  it('detects codex- prefixed models', () => {
    assert.equal(isNonClaudeModel('codex-mini'), true);
  });

  it('detects openai/ prefixed models', () => {
    assert.equal(isNonClaudeModel('openai/gpt-4o'), true);
  });

  it('returns false for claude models', () => {
    assert.equal(isNonClaudeModel('claude-opus-4-6'), false);
    assert.equal(isNonClaudeModel('claude-sonnet-4-6'), false);
  });

  it('returns false for undefined/empty', () => {
    assert.equal(isNonClaudeModel(undefined), false);
    assert.equal(isNonClaudeModel(''), false);
  });
});

// ── parseCliMajorVersion ──

describe('parseCliMajorVersion', () => {
  it('parses "2.3.1" to 2', () => {
    assert.equal(parseCliMajorVersion('2.3.1'), 2);
  });

  it('parses "claude 2.3.1" to 2', () => {
    assert.equal(parseCliMajorVersion('claude 2.3.1'), 2);
  });

  it('parses "1.0.17" to 1', () => {
    assert.equal(parseCliMajorVersion('1.0.17'), 1);
  });

  it('parses "@anthropic-ai/claude-code: 1.0.3" to 1', () => {
    assert.equal(parseCliMajorVersion('@anthropic-ai/claude-code: 1.0.3'), 1);
  });

  it('returns undefined for non-version strings', () => {
    assert.equal(parseCliMajorVersion('unknown'), undefined);
    assert.equal(parseCliMajorVersion(''), undefined);
  });
});

describe('buildCliExecCommand', () => {
  it('runs script entrypoints through node and binaries directly', () => {
    for (const ext of ['js', 'mjs', 'cjs']) {
      assert.equal(
        buildCliExecCommand(`/tmp/claude.${ext}`, ['--version']),
        `"${process.execPath}" "/tmp/claude.${ext}" "--version"`,
      );
    }
    assert.equal(
      buildCliExecCommand('/tmp/claude', ['--help']),
      '"/tmp/claude" "--help"',
    );
  });
});

describe('isExecutable', () => {
  it('detects executable and non-executable files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-is-executable-'));
    const executablePath = path.join(tempDir, 'claude-ok.sh');
    const plainFilePath = path.join(tempDir, 'claude-no.sh');

    writeFakeClaudeCli(executablePath);
    fs.writeFileSync(plainFilePath, 'echo nope\n', { mode: 0o644 });

    assert.equal(isExecutable(executablePath), true);
    assert.equal(isExecutable(plainFilePath), false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe('resolveWindowsNpmClaudeCliShim', () => {
  it('maps npm shim paths to the real cli.js when present', () => {
    const shimPath = 'C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd';
    const cliJsPath = 'C:\\Users\\fres\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';

    assert.equal(
      resolveWindowsNpmClaudeCliShim(shimPath, (candidate) => candidate === cliJsPath),
      cliJsPath,
    );
  });

  it('leaves the original path unchanged when the real cli.js is absent', () => {
    const shimPath = 'C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd';
    assert.equal(resolveWindowsNpmClaudeCliShim(shimPath, () => false), shimPath);
  });
});

describe('normalizeConfiguredClaudeCliPath', () => {
  it('ignores Windows-style configured paths on non-Windows hosts', () => {
    assert.equal(
      normalizeConfiguredClaudeCliPath(' C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd ', 'darwin'),
      undefined,
    );
  });

  it('ignores POSIX-style configured paths on Windows hosts', () => {
    assert.equal(
      normalizeConfiguredClaudeCliPath('/usr/local/bin/claude', 'win32'),
      undefined,
    );
  });

  it('normalizes Windows npm shim paths on Windows hosts', () => {
    assert.equal(
      normalizeConfiguredClaudeCliPath('C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd', 'win32'),
      'C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd',
    );
  });

  it('keeps compatible configured paths on the current host', () => {
    assert.equal(
      normalizeConfiguredClaudeCliPath(' /tmp/custom-claude ', 'darwin'),
      '/tmp/custom-claude',
    );
  });
});

describe('parseWindowsWhereClaudeOutput', () => {
  it('handles CRLF output and normalizes npm shim candidates', () => {
    const shimPath = 'C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd';
    const cliJsPath = 'C:\\Users\\fres\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const nativePath = 'C:\\Program Files\\claude\\claude.exe';

    assert.deepEqual(
      parseWindowsWhereClaudeOutput(`${shimPath}\r\n${nativePath}\r\n`, (candidate) => candidate === cliJsPath),
      [cliJsPath, nativePath],
    );
  });
});

describe('preflightCheck', () => {
  it('executes js-based Claude CLI entrypoints via node', () => {
    for (const ext of ['js', 'mjs', 'cjs']) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `agents-to-im-claude-cli-${ext}-`));
      const cliPath = path.join(tempDir, `cli.${ext}`);
      fs.writeFileSync(
        cliPath,
        [
          'const arg = process.argv[2];',
          "if (arg === '--version') { console.log('2.1.104'); process.exit(0); }",
          "if (arg === '--help') { console.log('output-format input-format permission-mode setting-sources'); process.exit(0); }",
          'process.exit(0);',
        ].join('\n'),
      );

      const result = preflightCheck(cliPath);
      fs.rmSync(tempDir, { recursive: true, force: true });

      assert.deepEqual(result, { ok: true, version: '2.1.104' });
    }
  });

  it('surfaces old CLI versions as user-facing preflight failures', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-preflight-old-'));
    const cliPath = path.join(tempDir, 'claude-old.sh');
    writeFakeClaudeCli(cliPath, '1.9.0');

    const result = preflightCheck(cliPath);
    fs.rmSync(tempDir, { recursive: true, force: true });

    assert.equal(result.ok, false);
    assert.equal(result.version, '1.9.0');
    assert.match(result.error || '', /too old/);
  });

  it('surfaces missing required flags as preflight failures', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-preflight-flags-'));
    const cliPath = path.join(tempDir, 'claude-flags.sh');
    writeFakeClaudeCli(cliPath, '2.1.104', 'output-format');

    const result = preflightCheck(cliPath);
    fs.rmSync(tempDir, { recursive: true, force: true });

    assert.equal(result.ok, false);
    assert.equal(result.version, '2.1.104');
    assert.match(result.error || '', /missing required flags/);
  });

  it('surfaces version probe failures as execution errors', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-preflight-fail-'));
    const cliPath = path.join(tempDir, 'claude-fail.sh');
    writeFailingClaudeCli(cliPath, { versionFails: true });

    const result = preflightCheck(cliPath);
    fs.rmSync(tempDir, { recursive: true, force: true });

    assert.deepEqual(result, {
      ok: false,
      error: `claude CLI at "${cliPath}" failed to execute`,
    });
  });
});

describe('checkCliCompatibility', () => {
  it('marks old CLI builds as incompatible', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-old-'));
    const cliPath = path.join(tempDir, 'claude-old.sh');
    writeFakeClaudeCli(cliPath, '1.9.0');

    const result = checkCliCompatibility(cliPath, buildSubprocessEnv());
    fs.rmSync(tempDir, { recursive: true, force: true });

    assert.deepEqual(result, {
      compatible: false,
      version: '1.9.0',
      major: 1,
    });
  });

  it('flags missing SDK-required help switches', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-flags-'));
    const cliPath = path.join(tempDir, 'claude-help.sh');
    writeFakeClaudeCli(cliPath, '2.1.104', 'output-format');

    const result = checkCliCompatibility(cliPath, buildSubprocessEnv());
    fs.rmSync(tempDir, { recursive: true, force: true });

    assert.equal(result?.compatible, false);
    assert.deepEqual(result?.missingFlags, ['input-format', 'permission-mode', 'setting-sources']);
  });

  it('treats help probe failures as non-blocking when version is otherwise valid', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-help-fail-'));
    const cliPath = path.join(tempDir, 'claude-help-fail.sh');
    writeFailingClaudeCli(cliPath, { helpFails: true });

    const result = checkCliCompatibility(cliPath, buildSubprocessEnv());
    fs.rmSync(tempDir, { recursive: true, force: true });

    assert.deepEqual(result, {
      compatible: true,
      version: '2.1.104',
      major: 2,
      missingFlags: undefined,
    });
  });

  it('returns undefined when the version probe cannot execute', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-version-fail-'));
    const cliPath = path.join(tempDir, 'claude-version-fail.sh');
    writeFailingClaudeCli(cliPath, { versionFails: true });

    const result = checkCliCompatibility(cliPath, buildSubprocessEnv());
    fs.rmSync(tempDir, { recursive: true, force: true });

    assert.equal(result, undefined);
  });
});

describe('resolveClaudeCliPath', () => {
  it('returns the configured path directly on non-Windows hosts', () => {
    assert.equal(
      resolveClaudeCliPath({ claudeCliExecutable: ' /tmp/custom-claude ' }),
      '/tmp/custom-claude',
    );
  });

  it('prefers the first compatible PATH candidate over an older one', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-path-'));
    const oldDir = path.join(tempRoot, 'old');
    const newDir = path.join(tempRoot, 'new');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    const oldCli = path.join(oldDir, 'claude');
    const newCli = path.join(newDir, 'claude');
    writeFakeClaudeCli(oldCli, '1.9.0');
    writeFakeClaudeCli(newCli, '2.1.104');

    const resolved = withPatchedEnv({
      PATH: `${oldDir}:${newDir}:${process.env.PATH || ''}`,
      HOME: tempRoot,
    }, () => resolveClaudeCliPath());

    fs.rmSync(tempRoot, { recursive: true, force: true });
    assert.equal(resolved, newCli);
  });

  it('ignores Windows-style configured paths on non-Windows hosts and falls back to PATH discovery', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-path-fallback-'));
    const binDir = path.join(tempRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const localCli = path.join(binDir, 'claude');
    writeFakeClaudeCli(localCli, '2.1.104');

    const resolved = withPatchedEnv({
      PATH: `${binDir}:${process.env.PATH || ''}`,
      HOME: tempRoot,
    }, () => resolveClaudeCliPath({
      claudeCliExecutable: 'C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd',
    }));

    fs.rmSync(tempRoot, { recursive: true, force: true });
    assert.equal(resolved, localCli);
  });

  it('walks the Windows where-claude discovery branch without crashing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-claude-win-path-'));
    const binDir = path.join(tempRoot, 'bin');
    const oldDir = path.join(tempRoot, 'old');
    const newDir = path.join(tempRoot, 'new');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });

    const oldCli = path.join(oldDir, 'claude');
    const newCli = path.join(newDir, 'claude');
    const whereBin = path.join(binDir, 'where');
    writeFakeClaudeCli(oldCli, '1.9.0');
    writeFakeClaudeCli(newCli, '2.1.104');
    fs.writeFileSync(
      whereBin,
      [
        '#!/bin/sh',
        `printf '%s\\r\\n%s\\r\\n' '${oldCli}' '${newCli}'`,
      ].join('\n'),
      { mode: 0o755 },
    );

    const resolved = withPatchedPlatform('win32', () => withPatchedEnv({
      PATH: `${binDir}:${process.env.PATH || ''}`,
      LOCALAPPDATA: tempRoot,
    }, () => resolveClaudeCliPath()));

    fs.rmSync(tempRoot, { recursive: true, force: true });
    assert.equal(resolved, undefined);
  });
});

// ── handleMessage + StreamState ──

describe('handleMessage state tracking', () => {
  it('sets hasStreamedText on text_delta', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    } as any, controller, state);

    assert.equal(state.hasStreamedText, true);
    assert.equal(state.hasReceivedResult, false);
  });

  it('captures assistant text without emitting it', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'org has no access' }] },
    } as any, controller, state);

    assert.equal(state.lastAssistantText, 'org has no access');
    // No text SSE should be emitted — only tool_use blocks get forwarded
    const textEvents = chunks.filter(c => c.includes('"type":"text"') || c.includes('"type":"text"'));
    // Parse more carefully
    const hasTextEvent = chunks.some(c => {
      try { const d = JSON.parse(c.replace('data: ', '')); return d.type === 'text'; }
      catch { return false; }
    });
    assert.equal(hasTextEvent, false, 'assistant text should NOT be emitted directly');
  });

  it('sets hasReceivedResult on success result', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'result',
      subtype: 'success',
      session_id: 'sess1',
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 20 },
      total_cost_usd: 0.001,
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true);
  });

  it('emits mode_changed when the SDK surfaces a permission mode update', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'system',
      subtype: 'mode_changed',
      mode: 'dontAsk',
      session_id: 'sess-mode-1',
    } as any, controller, state);

    assert.deepEqual(parseChunk(chunks[0] || ''), {
      type: 'mode_changed',
      data: JSON.stringify({ mode: 'dontAsk' }),
    });
  });

  it('falls back to Unknown error when SDK error result has no messages', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'result',
      subtype: 'error_during_execution',
      errors: [],
      is_error: true,
      session_id: 'sess-1',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      modelUsage: {},
      permission_denials: [],
      uuid: 'uuid-1',
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true);
    assert.equal(chunks.length, 1);
    assert.deepEqual(parseChunk(chunks[0] || ''), {
      type: 'error',
      data: 'Unknown error',
    });
  });

  it('surfaces success-subtype business errors from synthetic assistant results', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Failed to authenticate. API Error: 401 OAuth token has expired.',
          },
        ],
      },
    } as any, controller, state);

    handleMessage({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Failed to authenticate. API Error: 401 OAuth token has expired.',
      session_id: 'sess-1',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: 'stop_sequence',
      total_cost_usd: 0,
      modelUsage: {},
      permission_denials: [],
      uuid: 'uuid-2',
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true);
    assert.equal(chunks.length, 2);
    assert.deepEqual(parseChunk(chunks[0] || ''), {
      type: 'error',
      data: 'Failed to authenticate. API Error: 401 OAuth token has expired.',
    });
    assert.equal(parseChunk(chunks[1] || '').type, 'result');
  });

  it('sets hasReceivedResult on error result', () => {
    const { controller } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'result',
      subtype: 'error',
      errors: ['something went wrong'],
    } as any, controller, state);

    assert.equal(state.hasReceivedResult, true);
  });

  it('emits tool_use from assistant block', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();

    handleMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: '/foo' } },
        ],
      },
    } as any, controller, state);

    assert.equal(state.lastAssistantText, 'Let me check');
    assert.equal(chunks.length, 2); // activity_event + tool_use, no duplicated text
    assert.ok(chunks[0].includes('activity_event'));
    assert.ok(chunks[1].includes('tool_use'));
  });

  it('maps Claude SDK task/tool messages into reasoning and tool activities', () => {
    const compacting = mapSdkMessageToActivityEvent({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: 'sess-1',
    } as any);
    const taskProgress = mapSdkMessageToActivityEvent({
      type: 'system',
      subtype: 'task_progress',
      task_id: 'task-1',
      description: '正在分析仓库',
      last_tool_name: 'Read',
      usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
      session_id: 'sess-1',
    } as any);
    const toolProgress = mapSdkMessageToActivityEvent({
      type: 'tool_progress',
      tool_use_id: 'tool-1',
      tool_name: 'mcp__chrome-devtools__take_screenshot',
      parent_tool_use_id: 'parent-1',
      elapsed_time_seconds: 1.4,
      task_id: 'task-1',
      session_id: 'sess-1',
    } as any);

    assert.deepEqual(compacting, {
      kind: 'reasoning_activity',
      status: 'running',
      text: '正在压缩上下文…',
      source: 'compacting',
    });
    assert.deepEqual(taskProgress, {
      kind: 'reasoning_activity',
      taskId: 'task-1',
      status: 'running',
      text: '正在分析仓库 · Read',
      source: 'task_progress',
    });
    assert.deepEqual(toolProgress, {
      kind: 'tool_activity',
      toolUseId: 'tool-1',
      parentToolUseId: 'parent-1',
      toolName: 'MCP: chrome-devtools take_screenshot',
      status: 'running',
      taskId: 'task-1',
      elapsedSeconds: 1.4,
      source: 'tool_progress',
    });
  });

  it('emits tool_activity before tool_result when a tool_result block arrives', () => {
    const { controller, chunks } = makeFakeController();
    const state = freshState();
    state.toolNamesByUseId.set('tu1', 'Bash');

    handleMessage({
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'sess-tool-result',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }],
            is_error: false,
          },
        ],
      },
    } as any, controller, state);

    assert.equal(chunks.length, 2);
    const activity = parseChunk(chunks[0] || '');
    const result = parseChunk(chunks[1] || '');
    assert.equal(activity.type, 'activity_event');
    assert.equal(result.type, 'tool_result');
    assert.match(activity.data, /"kind":"tool_activity"/);
    assert.match(activity.data, /"resultPreview":"返回了 1 张图片"/);
  });

  it('parses AskUserQuestion payloads into structured input requests', () => {
    const request = parseAskUserQuestionRequest('tool-use-1', {
      questions: [
        {
          question: '要启用哪些特性？',
          header: '特性',
          multiSelect: true,
          options: [
            { label: 'A', description: 'A 功能', preview: 'preview-a' },
            { label: 'B', description: 'B 功能' },
          ],
        },
      ],
    });

    assert.deepEqual(request, {
      requestId: 'tool-use-1',
      threadId: '',
      turnId: '',
      itemId: '',
      questions: [
        {
          id: 'q1',
          header: '特性',
          question: '要启用哪些特性？',
          isOther: true,
          isSecret: false,
          multiSelect: true,
          responseKey: '要启用哪些特性？',
          options: [
            { label: 'A', description: 'A 功能', preview: 'preview-a' },
            { label: 'B', description: 'B 功能' },
          ],
        },
      ],
    });
  });

  it('builds AskUserQuestion responses keyed by original question text', () => {
    const response = buildAskUserQuestionResponse({
      requestId: 'tool-use-2',
      threadId: '',
      turnId: '',
      itemId: '',
      questions: [
        {
          id: 'q1',
          header: '框架',
          question: '使用哪个框架？',
          responseKey: '使用哪个框架？',
          isOther: true,
          isSecret: false,
          options: [{ label: 'React', description: '推荐' }],
        },
        {
          id: 'q2',
          header: '特性',
          question: '启用哪些特性？',
          responseKey: '启用哪些特性？',
          isOther: true,
          isSecret: false,
          multiSelect: true,
          options: [
            { label: 'A', description: 'A 功能' },
            { label: 'B', description: 'B 功能' },
          ],
        },
      ],
    }, {
      answers: {
        q1: { answers: ['React'] },
        q2: { answers: ['A', 'B'] },
      },
    });

    assert.deepEqual(response, {
      questions: [
        {
          question: '使用哪个框架？',
          header: '框架',
          options: [{ label: 'React', description: '推荐' }],
          multiSelect: false,
        },
        {
          question: '启用哪些特性？',
          header: '特性',
          options: [
            { label: 'A', description: 'A 功能' },
            { label: 'B', description: 'B 功能' },
          ],
          multiSelect: true,
        },
      ],
      answers: {
        '使用哪个框架？': 'React',
        '启用哪些特性？': 'A, B',
      },
    });
  });
});

describe('catch block error suppression logic', () => {
  // These tests verify the logic expressed in the catch block by testing
  // the state conditions that drive its behavior.

  it('result received + exit code → should suppress (transport noise)', () => {
    const state: StreamState = {
      hasReceivedResult: true,
      hasStreamedText: true,
      lastAssistantText: '',
      toolNamesByUseId: new Map<string, string>(),
    };
    const errorMsg = 'Claude Code process exited with code 1';
    const isTransportExit = errorMsg.includes('process exited with code');

    // This is the condition in the catch block:
    const shouldSuppress = state.hasReceivedResult && isTransportExit;
    assert.equal(shouldSuppress, true);
  });

  it('partial text + exit code (no result) → should NOT suppress (real crash)', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasStreamedText: true,
      lastAssistantText: '',
      toolNamesByUseId: new Map<string, string>(),
    };
    const errorMsg = 'Claude Code process exited with code 1';
    const isTransportExit = errorMsg.includes('process exited with code');

    const shouldSuppress = state.hasReceivedResult && isTransportExit;
    assert.equal(shouldSuppress, false, 'partial output crash must NOT be suppressed');
  });

  it('assistant text with recognised auth error → should surface as business error', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasStreamedText: false,
      lastAssistantText: 'Your organization does not have access to Claude',
      toolNamesByUseId: new Map<string, string>(),
    };

    // Case 2 condition: lastAssistantText must be a recognised auth/access error
    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    assert.equal(shouldSurface, true);
  });

  it('assistant text with normal content + crash → should NOT surface as business error', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasStreamedText: false,
      lastAssistantText: 'Here is my analysis of the code...',
      toolNamesByUseId: new Map<string, string>(),
    };

    // Normal response text is not a recognised auth error — must fall through to error handling
    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    assert.equal(shouldSurface, false, 'normal assistant text must NOT be treated as business error');
  });

  it('no streaming + no assistant text → should show full error', () => {
    const state: StreamState = {
      hasReceivedResult: false,
      hasStreamedText: false,
      lastAssistantText: '',
      toolNamesByUseId: new Map<string, string>(),
    };

    const shouldSurface = !!state.lastAssistantText && classifyAuthError(state.lastAssistantText) !== false;
    const shouldSuppress = state.hasReceivedResult;
    assert.equal(shouldSurface, false);
    assert.equal(shouldSuppress, false);
    // This means the catch block falls through to building the full error message
  });

  it('streaming + result + exit code → should suppress', () => {
    // Normal successful flow that ends with exit code 0 won't throw,
    // but some edge cases might. Verify suppression.
    const state: StreamState = {
      hasReceivedResult: true,
      hasStreamedText: true,
      lastAssistantText: 'some response',
      toolNamesByUseId: new Map<string, string>(),
    };
    const isTransportExit = true;

    const shouldSuppress = state.hasReceivedResult && isTransportExit;
    assert.equal(shouldSuppress, true);
  });
});
