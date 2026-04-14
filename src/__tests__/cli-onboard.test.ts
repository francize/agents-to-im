import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPlatformAuthUrl,
  buildPlatformBotUrl,
  buildPlatformEventUrl,
  buildPlatformSetupChecklist,
  detectDefaultOnboardLocale,
} from '../cli.js';
import { FEISHU_SCOPES_IMPORT_JSON } from '../feishu-scopes.js';

const CLI_PATH = fileURLToPath(new URL('../cli.ts', import.meta.url));
const PROJECT_ROOT = path.resolve(path.dirname(CLI_PATH), '..');

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function installFakeCodex(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\necho codex 0.1.0\r\n');
    return;
  }
  const codexPath = path.join(binDir, 'codex');
  fs.writeFileSync(codexPath, '#!/bin/sh\necho codex 0.1.0\n');
  fs.chmodSync(codexPath, 0o755);
}

async function runOnboardCli(inputLines: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  ctiHome: string;
  tempRoot: string;
}> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-onboard-'));
  const ctiHome = path.join(tempRoot, 'cti-home');
  const binDir = path.join(tempRoot, 'bin');
  installFakeCodex(binDir);

  return new Promise((resolve, reject) => {
    const scriptedPrompts = [
      /Choose:\s*$/,
      /App ID:\s*$/,
      /App Secret:\s*$/,
      /Choose:\s*$/,
      /Default working directory.*:\s*$/,
      /Claude CLI path \(optional\).*\s*:\s*$/,
      /Choose:\s*$/,
      /Choose:\s*$/,
      /Choose:\s*$/,
      /Choose:\s*$/,
    ];
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, 'onboard'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        LANG: 'en_US.UTF-8',
      },
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let promptBuffer = '';
    let stepIndex = 0;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for onboarding prompt ${stepIndex + 1}`));
    }, 15000);

    const maybeAnswerPrompt = () => {
      if (stepIndex >= scriptedPrompts.length) return;
      if (!scriptedPrompts[stepIndex].test(promptBuffer)) return;
      child.stdin.write(`${inputLines[stepIndex]}\n`);
      stepIndex += 1;
      promptBuffer = '';
      if (stepIndex >= inputLines.length) {
        child.stdin.end();
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      promptBuffer += stripAnsi(text);
      maybeAnswerPrompt();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, ctiHome, tempRoot });
    });
  });
}

describe('CLI onboarding checklist', () => {
  it('includes scopes, publish, and long-connection guidance for a fresh Feishu install', () => {
    const checklist = buildPlatformSetupChecklist('', 'start', 'cli_test_app');

    assert.equal(checklist[0], 'Open Feishu auth page: https://open.feishu.cn/app/cli_test_app/auth');
    assert.ok(checklist.some((item) => item.includes('Import the full scopes JSON')));
    assert.ok(checklist.some((item) => item.includes('Publish one app version')));
    assert.ok(checklist.some((item) => item.includes('Start the bridge before saving Long Connection events')));
    assert.ok(checklist.some((item) => item.includes('Add event: im.message.receive_v1')));
    assert.ok(checklist.some((item) => item.includes('Add event: im.message.message_read_v1')));
    assert.ok(checklist.some((item) => item.includes('Add event: im.chat.updated_v1')));
    assert.ok(checklist.some((item) => item.includes('Add event: im.chat.member.bot.added_v1')));
    assert.ok(checklist.some((item) => item.includes('Open Events page: https://open.feishu.cn/app/cli_test_app/event?tab=event')));
    assert.ok(checklist.some((item) => item.includes('Open Callback page: https://open.feishu.cn/app/cli_test_app/event?tab=callback')));
    assert.ok(checklist.some((item) => item.includes('Add callback: card.action.trigger')));
    assert.ok(checklist.some((item) => item.includes('Optional: open Bot menu page: https://open.feishu.cn/app/cli_test_app/bot')));
    assert.ok(checklist.some((item) => item.includes('Add floating menu shortcuts: /new:claude and /new:codex')));
    assert.equal(checklist.at(-1), 'Publish again if you changed the Bot menu');
  });

  it('switches the platform URL and restart wording for Lark with a running bridge', () => {
    const checklist = buildPlatformSetupChecklist('lark', 'restart', 'cli_test_lark');

    assert.equal(checklist[0], 'Open Lark auth page: https://open.larksuite.com/app/cli_test_lark/auth');
    assert.ok(checklist.some((item) => item.includes('Restart the bridge before saving Long Connection events')));
  });

  it('builds the dynamic auth page URL from the app id', () => {
    assert.equal(buildPlatformAuthUrl('', 'cli_a903872cdbf95cd9'), 'https://open.feishu.cn/app/cli_a903872cdbf95cd9/auth');
    assert.equal(buildPlatformAuthUrl('lark', 'cli_lark_123'), 'https://open.larksuite.com/app/cli_lark_123/auth');
    assert.equal(buildPlatformEventUrl('', 'cli_a903872cdbf95cd9', 'event'), 'https://open.feishu.cn/app/cli_a903872cdbf95cd9/event?tab=event');
    assert.equal(buildPlatformEventUrl('', 'cli_a903872cdbf95cd9', 'callback'), 'https://open.feishu.cn/app/cli_a903872cdbf95cd9/event?tab=callback');
    assert.equal(buildPlatformBotUrl('', 'cli_a903872cdbf95cd9'), 'https://open.feishu.cn/app/cli_a903872cdbf95cd9/bot');
  });

  it('defaults onboarding language from locale env', () => {
    assert.equal(detectDefaultOnboardLocale({ LANG: 'zh_CN.UTF-8' } as NodeJS.ProcessEnv), 'zh');
    assert.equal(detectDefaultOnboardLocale({ LC_ALL: 'en_US.UTF-8' } as NodeJS.ProcessEnv), 'en');
  });

  it('ships a parseable scopes import payload for clipboard copy', () => {
    const parsed = JSON.parse(FEISHU_SCOPES_IMPORT_JSON) as {
      scopes?: { tenant?: string[]; user?: string[] };
    };
    assert.ok((parsed.scopes?.tenant?.length || 0) > 10);
    assert.ok((parsed.scopes?.user?.length || 0) > 10);
    assert.ok(parsed.scopes?.tenant?.includes('cardkit:card:write'));
    assert.ok(parsed.scopes?.tenant?.includes('im:message:update'));
  });

  it('writes the tool-card toggle and advances to step 2 immediately when step 1 is skipped', async () => {
    const result = await runOnboardCli([
      '2',
      'cli_test_app',
      'app-secret',
      '1',
      '/tmp/agents-to-im-test',
      '',
      '2',
      '2',
      '2',
      '3',
    ]);

    try {
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const output = stripAnsi(result.stdout);
      const config = fs.readFileSync(path.join(result.ctiHome, 'config.env'), 'utf-8');

      assert.match(output, /Show tool-call cards in sessions\?/);
      assert.match(output, /2\/6 Run the local bridge/);
      assert.doesNotMatch(output, /Open the auth page now\?/);
      assert.doesNotMatch(output, /Press Enter after Bot, scopes, and the first publish are done/);
      assert.match(config, /CTI_FEISHU_SHOW_TOOL_CALL_CARDS=false/);
    } finally {
      fs.rmSync(result.tempRoot, { recursive: true, force: true });
    }
  });
});
