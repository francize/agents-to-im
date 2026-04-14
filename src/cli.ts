#!/usr/bin/env node
/**
 * Interactive CLI for agents-to-im.
 *
 * Daily usage:
 *   agents-to-im onboard → Interactive onboarding wizard
 *   agents-to-im start   → Start the bridge
 *   agents-to-im restart → Restart the bridge
 *   agents-to-im stop    → Stop the bridge
 *   agents-to-im status  → Show bridge status
 *   agents-to-im doctor  → Run diagnostics
 *   agents-to-im upgrade → Upgrade the local installation
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildUpgradePlan,
  findAgentsToImPackageRoot,
  readAgentsToImVersion,
} from './cli-upgrade.js';
import { FEISHU_SCOPES_IMPORT_JSON } from './feishu-scopes.js';

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.agents-to-im');
const CONFIG_PATH = path.join(CTI_HOME, 'config.env');
const PID_FILE = path.join(CTI_HOME, 'runtime', 'bridge.pid');
const STATUS_FILE = path.join(CTI_HOME, 'runtime', 'status.json');
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_COMMAND = 'agents-to-im';
const NPM_INSTALL_SPEC = 'agents-to-im';
const MACOS_LAUNCHD_LABEL = 'com.agents-to-im.bridge';
const FEISHU_OPEN_BASE_URL = 'https://open.feishu.cn';
const LARK_OPEN_BASE_URL = 'https://open.larksuite.com';
const SETUP_GUIDE_URL = 'https://github.com/francize/agents-to-im/blob/main/references/setup-guides.md';

function cliCommand(command?: string): string {
  return command
    ? `${CLI_COMMAND} ${command}`
    : CLI_COMMAND;
}

function npmInstallCommand(): string {
  return `npm install -g ${NPM_INSTALL_SPEC}`;
}

function getPlatformLabel(domain: string): string {
  return domain === 'lark' ? 'Lark' : 'Feishu';
}

function getPlatformConsoleUrl(domain: string): string {
  return `${domain === 'lark' ? LARK_OPEN_BASE_URL : FEISHU_OPEN_BASE_URL}/app`;
}

function buildPlatformAppUrl(domain: string, appId: string, suffix: string): string {
  const trimmed = appId.trim();
  if (!trimmed) return getPlatformConsoleUrl(domain);
  const baseUrl = domain === 'lark' ? LARK_OPEN_BASE_URL : FEISHU_OPEN_BASE_URL;
  return `${baseUrl}/app/${encodeURIComponent(trimmed)}${suffix}`;
}

export function buildPlatformAuthUrl(domain: string, appId: string): string {
  return buildPlatformAppUrl(domain, appId, '/auth');
}

export function buildPlatformEventUrl(domain: string, appId: string, tab: 'event' | 'callback'): string {
  return buildPlatformAppUrl(domain, appId, `/event?tab=${tab}`);
}

export function buildPlatformBotUrl(domain: string, appId: string): string {
  return buildPlatformAppUrl(domain, appId, '/bot');
}

function tryCopyToClipboard(text: string): boolean {
  const attempts = process.platform === 'darwin'
    ? [{ command: 'pbcopy', args: [] as string[] }]
    : process.platform === 'win32'
      ? [
        { command: 'clip', args: [] as string[] },
        { command: 'powershell', args: ['-NoProfile', '-Command', 'Set-Clipboard'] },
      ]
      : [
        { command: 'wl-copy', args: [] as string[] },
        { command: 'xclip', args: ['-selection', 'clipboard'] },
        { command: 'xsel', args: ['--clipboard', '--input'] },
      ];

  for (const attempt of attempts) {
    const result = spawnSync(resolveExecutable(attempt.command), attempt.args, {
      input: text,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env,
    });
    if (result.status === 0) return true;
  }
  return false;
}

function tryOpenExternalUrl(url: string): boolean {
  const attempts = process.platform === 'darwin'
    ? [{ command: 'open', args: [url] }]
    : process.platform === 'win32'
      ? [
        { command: 'powershell', args: ['-NoProfile', '-Command', `Start-Process '${url.replace(/'/g, "''")}'`] },
      ]
      : [{ command: 'xdg-open', args: [url] }];

  for (const attempt of attempts) {
    const result = spawnSync(resolveExecutable(attempt.command), attempt.args, {
      stdio: 'ignore',
      env: process.env,
      timeout: 5000,
    });
    if (result.status === 0) return true;
  }
  return false;
}

// ── Colors ──

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
};

const ANSI_ESCAPE_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const BANNER_SIDE_PADDING = 2;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}

function isWideCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function getDisplayWidth(value: string): number {
  const text = stripAnsi(value);
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (!codePoint) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    if (codePoint === 0xfe0e || codePoint === 0xfe0f || /\p{Mark}/u.test(char)) continue;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function ok(msg: string) { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function warn(msg: string) { console.log(`  ${c.yellow}⚠${c.reset} ${msg}`); }
function fail(msg: string) { console.log(`  ${c.red}✗${c.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${c.blue}ℹ${c.reset} ${msg}`); }
function heading(msg: string) { console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}\n`); }

// ── Readline helpers ──

type OnboardLocale = 'zh' | 'en';

type MenuOption<T> = {
  label: string;
  value: T;
};

function t(locale: OnboardLocale, zh: string, en: string): string {
  return locale === 'zh' ? zh : en;
}

export function detectDefaultOnboardLocale(env: NodeJS.ProcessEnv = process.env): OnboardLocale {
  const locale = `${env.LC_ALL || env.LC_MESSAGES || env.LANG || ''}`.toLowerCase();
  return locale.includes('zh') ? 'zh' : 'en';
}

function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

async function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` ${c.dim}(${defaultValue})${c.reset}` : '';
  return new Promise((resolve) => {
    rl.question(`  ${c.white}${question}${suffix}: ${c.reset}`, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function chooseOption<T>(
  rl: readline.Interface,
  question: string,
  options: MenuOption<T>[],
  config?: {
    defaultIndex?: number;
    fallbackQuestion?: string;
    hint?: string;
  },
): Promise<T> {
  if (!options.length) {
    throw new Error('chooseOption requires at least one option');
  }

  const defaultIndex = Math.min(Math.max(config?.defaultIndex ?? 0, 0), options.length - 1);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`  ${c.white}${question}${c.reset}`);
    options.forEach((option, index) => {
      console.log(`    ${c.cyan}${index + 1}.${c.reset} ${option.label}`);
    });
    const answer = await ask(rl, config?.fallbackQuestion || 'Choose');
    const parsed = parseInt(answer, 10) - 1;
    return options[parsed]?.value ?? options[defaultIndex].value;
  }

  rl.pause();

  const input = process.stdin as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const output = process.stdout;
  const hint = config?.hint || 'Use ↑/↓ to move, Enter to choose';
  let selectedIndex = defaultIndex;
  let renderedLines = 0;
  const previousRawMode = Boolean(input.isRaw);

  readline.emitKeypressEvents(input);
  if (input.setRawMode) input.setRawMode(true);
  input.resume();

  return new Promise<T>((resolve, reject) => {
    const render = () => {
      if (renderedLines > 0) {
        readline.moveCursor(output, 0, -renderedLines);
        readline.clearScreenDown(output);
      }

      const lines = [`  ${c.white}${question}${c.reset}`];
      for (let index = 0; index < options.length; index += 1) {
        const option = options[index];
        const cursor = index === selectedIndex ? `${c.cyan}›${c.reset}` : ' ';
        const label = index === selectedIndex ? `${c.bold}${option.label}${c.reset}` : option.label;
        lines.push(`  ${cursor} ${label}`);
      }
      lines.push(`  ${c.dim}${hint}${c.reset}`);

      output.write(`${lines.join('\n')}\n`);
      renderedLines = lines.length;
    };

    const cleanup = () => {
      input.off('keypress', onKeyPress);
      if (input.setRawMode) input.setRawMode(previousRawMode);
      rl.resume();
    };

    const onKeyPress = (_value: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new Error('Interrupted'));
        return;
      }
      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
        return;
      }
      if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(options[selectedIndex].value);
      }
    };

    input.on('keypress', onKeyPress);
    render();
  });
}

async function confirm(
  rl: readline.Interface,
  question: string,
  defaultYes = true,
  labels?: { yes: string; no: string; hint?: string },
): Promise<boolean> {
  return chooseOption(rl, question, [
    { label: labels?.yes || 'Yes', value: true },
    { label: labels?.no || 'No', value: false },
  ], {
    defaultIndex: defaultYes ? 0 : 1,
    fallbackQuestion: 'Choose',
    hint: labels?.hint,
  });
}

async function select(
  rl: readline.Interface,
  question: string,
  options: string[],
  defaultIndex = 0,
  hint?: string,
): Promise<number> {
  return chooseOption(rl, question, options.map((option, index) => ({
    label: option,
    value: index,
  })), {
    defaultIndex,
    fallbackQuestion: 'Choose',
    hint,
  });
}

// ── Agent detection ──

interface AgentInfo {
  name: string;
  installed: boolean;
  version?: string;
  path?: string;
}

function detectAgent(cmd: string, name: string): AgentInfo {
  try {
    const version = execSync(`${cmd} --version 2>&1`, { encoding: 'utf-8', timeout: 5000 }).trim();
    const agentPath = execSync(`which ${cmd} 2>/dev/null || where ${cmd} 2>nul`, {
      encoding: 'utf-8', timeout: 3000,
    }).trim().split('\n')[0];
    return { name, installed: true, version, path: agentPath };
  } catch {
    return { name, installed: false };
  }
}

function detectAgents(): AgentInfo[] {
  return [
    detectAgent('claude', 'Claude Code'),
    detectAgent('codex', 'Codex'),
  ];
}

// ── Banner ──

type BannerLine = {
  text: string;
  format: (value: string) => string;
};

const BANNER_LINES: BannerLine[] = [
  { text: 'agents-to-im', format: (value) => `${c.bold}${value}${c.reset}` },
  { text: 'Feishu/Lark bridge for AI coding agents', format: (value) => `${c.dim}${value}${c.reset}` },
];

export function buildBannerLines(): string[] {
  const contentWidth = Math.max(...BANNER_LINES.map((line) => getDisplayWidth(line.text)));
  const innerWidth = contentWidth + (BANNER_SIDE_PADDING * 2);
  const border = `${c.bold}${c.magenta}`;
  const top = `  ${border}+${'-'.repeat(innerWidth)}+${c.reset}`;
  const bottom = `  ${border}+${'-'.repeat(innerWidth)}+${c.reset}`;
  const body = BANNER_LINES.map(({ text, format }) => {
    const trailingSpaces = innerWidth - BANNER_SIDE_PADDING - getDisplayWidth(text);
    return (
      `  ${border}|${c.reset}` +
      `${' '.repeat(BANNER_SIDE_PADDING)}` +
      `${format(text)}` +
      `${' '.repeat(trailingSpaces)}` +
      `${border}|${c.reset}`
    );
  });
  return ['', top, ...body, bottom, ''];
}

function showSetupStep(title: string, lines: string[]) {
  heading(title);
  for (const line of lines) {
    console.log(`  ${c.cyan}-${c.reset} ${line}`);
  }
  console.log('');
}

async function waitForStepCompletion(
  rl: readline.Interface,
  prompt: string,
  options?: { allowLater?: boolean; hint?: string },
): Promise<'continue' | 'later'> {
  const allowLater = options?.allowLater !== false;
  const hint = options?.hint || (allowLater
    ? 'Press Enter when done, or type later to finish onboarding for now'
    : 'Press Enter when done');
  return new Promise((resolve) => {
    rl.question(
      `  ${c.white}${prompt}${c.reset}\n  ${c.dim}${hint}${c.reset}\n  ${c.cyan}> ${c.reset}`,
      (answer) => {
        const normalized = answer.trim().toLowerCase();
        if (allowLater && normalized === 'later') {
          resolve('later');
          return;
        }
        resolve('continue');
      },
    );
  });
}

function showOnboardClosing(locale: OnboardLocale = 'en') {
  info(`${t(locale, '重新进入引导:', 'Onboard again:')}     ${c.cyan}${cliCommand('onboard')}${c.reset}`);
  info(`${t(locale, '启动 bridge:', 'Start the bridge:')}  ${c.cyan}${cliCommand('start')}${c.reset}`);
  info(`${t(locale, '快速重启:', 'Quick restart:')}     ${c.cyan}${cliCommand('restart')}${c.reset}`);
  info(`${t(locale, '查看状态:', 'Check status:')}      ${c.cyan}${cliCommand('status')}${c.reset}`);
  info(`${t(locale, '运行诊断:', 'Run diagnostics:')}    ${c.cyan}${cliCommand('doctor')}${c.reset}`);
  console.log('');
}

async function maybePauseOnboarding(
  rl: readline.Interface,
  prompt: string,
  options?: { hint?: string; finishLaterMessage?: string },
): Promise<boolean> {
  const result = await waitForStepCompletion(rl, prompt, {
    allowLater: true,
    hint: options?.hint,
  });
  if (result === 'continue') return true;
  warn(options?.finishLaterMessage || `Finish the remaining steps later with ${c.cyan}${cliCommand('onboard')}${c.reset}`);
  console.log('');
  showOnboardClosing();
  return false;
}

export function buildPlatformSetupChecklist(domain: string, nextCommand: 'start' | 'restart', appId = ''): string[] {
  const nextAction = nextCommand === 'restart' ? 'Restart' : 'Start';
  return [
    `Open ${getPlatformLabel(domain)} auth page: ${buildPlatformAuthUrl(domain, appId)}`,
    'Enable the Bot capability if you have not already',
    `Import the full scopes JSON from: ${SETUP_GUIDE_URL}`,
    'Publish one app version after scopes and Bot changes',
    `${nextAction} the bridge before saving Long Connection events`,
    `Open Events page: ${buildPlatformEventUrl(domain, appId, 'event')}`,
    'Switch Events & Callbacks to Long Connection',
    'Add event: im.message.receive_v1',
    'Add event: im.message.message_read_v1',
    'Add event: im.chat.updated_v1',
    'Add event: im.chat.member.bot.added_v1',
    `Open Callback page: ${buildPlatformEventUrl(domain, appId, 'callback')}`,
    'Add callback: card.action.trigger',
    'Publish again so events and callbacks go live',
    `Optional: open Bot menu page: ${buildPlatformBotUrl(domain, appId)}`,
    'Add floating menu shortcuts: /new:claude and /new:codex',
    'Publish again if you changed the Bot menu',
  ];
}

function showBanner() {
  for (const line of buildBannerLines()) {
    console.log(line);
  }
}

export function parseLaunchdPid(output: string): string {
  const match = output.match(/^\s*pid = ([^\s]+)\s*$/m);
  if (!match) return '';
  const pid = match[1].trim();
  if (!pid || pid === '0' || pid === '-') return '';
  return pid;
}

function getLaunchdPid(): string {
  if (process.platform !== 'darwin') return '';
  try {
    const uid = execSync('id -u', { encoding: 'utf-8', timeout: 3000 }).trim();
    const output = execSync(`launchctl print gui/${uid}/${MACOS_LAUNCHD_LABEL}`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return parseLaunchdPid(output);
  } catch {
    return '';
  }
}

function getBridgeStatusSnapshot(): { running: boolean; pid: string; statusJson: Record<string, unknown> } {
  let pid = '';
  try { pid = fs.readFileSync(PID_FILE, 'utf-8').trim(); } catch { /* */ }

  let statusJson: Record<string, unknown> = {};
  try { statusJson = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* */ }

  const launchdPid = getLaunchdPid();
  if (launchdPid) {
    return { running: true, pid: launchdPid, statusJson };
  }

  if (statusJson.running !== true || !pid) {
    return { running: false, pid, statusJson };
  }

  try {
    process.kill(parseInt(pid, 10), 0);
    return { running: true, pid, statusJson };
  } catch {
    return { running: false, pid, statusJson };
  }
}

function resolveExecutable(command: string): string {
  if (process.platform === 'win32' && command === 'npm') {
    return 'npm.cmd';
  }
  return command;
}

function ensureCommandAvailable(command: string) {
  const result = spawnSync(resolveExecutable(command), ['--version'], {
    stdio: 'ignore',
    env: process.env,
  });
  if (result.status === 0) return;
  const detail = result.error instanceof Error ? `: ${result.error.message}` : '';
  throw new Error(`Required command not found or not working: ${command}${detail}`);
}

function runChild(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveExecutable(command), args, {
      stdio: 'inherit',
      cwd: options?.cwd,
      env: options?.env || process.env,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if ((code || 0) === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
  });
}

// ── Setup wizard ──

async function setupWizard() {
  showBanner();
  const rl = createRl();
  const locale = await chooseOption(rl, 'Language / 语言', [
    { label: '中文', value: 'zh' as const },
    { label: 'English', value: 'en' as const },
  ], {
    defaultIndex: detectDefaultOnboardLocale() === 'zh' ? 0 : 1,
    fallbackQuestion: 'Choose',
    hint: 'Use ↑/↓ to move, Enter to choose',
  });

  const menuHint = t(locale, '使用 ↑/↓ 选择，按 Enter 确认', 'Use ↑/↓ to move, Enter to choose');
  const continueHint = t(
    locale,
    '完成后按回车；如果想先结束这次引导，输入 later',
    'Press Enter when done, or type later to finish onboarding for now',
  );
  const finishLaterMessage = t(
    locale,
    `剩余步骤可以稍后通过 ${c.cyan}${cliCommand('onboard')}${c.reset} 继续`,
    `Finish the remaining steps later with ${c.cyan}${cliCommand('onboard')}${c.reset}`,
  );
  const platformConsoleUrlHint = `${c.cyan}https://open.feishu.cn/app${c.reset} / ${c.cyan}https://open.larksuite.com/app${c.reset}`;

  try {
    heading(t(locale, '🔍 检测已安装 agent...', '🔍 Detecting installed agents...'));

    const agents = detectAgents();
    for (const agent of agents) {
      if (agent.installed) {
        ok(`${agent.name} ${c.dim}${agent.version}${c.reset}`);
      } else {
        warn(`${agent.name} ${c.dim}${t(locale, '未找到', 'not found')}${c.reset}`);
      }
    }

    const hasAnyAgent = agents.some((agent) => agent.installed);
    if (!hasAnyAgent) {
      console.log('');
      fail(t(locale, '没有检测到可用的 AI agent。', 'No AI agents detected.'));
      info(t(locale, '至少先安装一个：', 'Install at least one:'));
      info(`  Claude Code: ${c.cyan}npm install -g @anthropic-ai/claude-code${c.reset}`);
      info(`  Codex:       ${c.cyan}npm install -g @openai/codex${c.reset}`);
      console.log('');
      const shouldContinue = await confirm(
        rl,
        t(locale, '仍然继续配置？', 'Continue setup anyway?'),
        false,
        {
          yes: t(locale, '继续', 'Continue'),
          no: t(locale, '退出', 'Exit'),
          hint: menuHint,
        },
      );
      if (!shouldContinue) return;
    }

    heading(t(locale, '🔧 飞书 / Lark 配置', '🔧 Feishu / Lark Configuration'));

    let existing: Record<string, string> = {};
    try {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        existing[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
    } catch {
      // no existing config
    }

    info(t(
      locale,
      '需要准备一个启用了 Bot 能力的飞书 / Lark 自建应用。',
      'You need a Feishu/Lark custom app with bot capability.',
    ));
    info(`${t(locale, '创建入口：', 'Create one at:')} ${platformConsoleUrlHint}`);
    console.log('');

    const existingAppId = existing.CTI_FEISHU_APP_ID || '';
    const existingAppSecret = existing.CTI_FEISHU_APP_SECRET || '';
    const existingDomain = existing.CTI_FEISHU_DOMAIN || '';
    const existingAllowedUsers = existing.CTI_FEISHU_ALLOWED_USERS || '';

    const appId = await ask(rl, t(locale, 'App ID', 'App ID'), existingAppId);
    const appSecret = await ask(
      rl,
      t(locale, 'App Secret', 'App Secret'),
      existingAppSecret ? `****${existingAppSecret.slice(-4)}` : undefined,
    );
    const actualSecret = appSecret.startsWith('****') ? existingAppSecret : appSecret;

    const domainIdx = await select(
      rl,
      t(locale, '选择平台：', 'Platform:'),
      [
        t(locale, '飞书（中国大陆）', 'Feishu (China)'),
        'Lark (international)',
      ],
      existingDomain === 'lark' ? 1 : 0,
      menuHint,
    );
    const domain = domainIdx === 1 ? 'lark' : '';
    const platformName = domain === 'lark' ? 'Lark' : t(locale, '飞书', 'Feishu');

    heading(t(locale, '📁 工作目录', '📁 Working Directory'));

    const defaultWorkDir = existing.CTI_DEFAULT_WORKDIR || process.cwd();
    const workDir = await ask(rl, t(locale, '默认工作目录', 'Default working directory'), defaultWorkDir);
    const detectedClaudeCliPath = agents.find((agent) => agent.name === 'Claude Code')?.path || '';
    const existingClaudeCliPath = existing.CTI_CLAUDE_CODE_EXECUTABLE || '';
    const claudeCliPath = await ask(
      rl,
      t(locale, 'Claude CLI 路径（可选）', 'Claude CLI path (optional)'),
      existingClaudeCliPath || detectedClaudeCliPath || undefined,
    );

    console.log('');
    const restrictUsers = await confirm(
      rl,
      t(locale, `限制特定${platformName}用户使用？`, `Restrict to specific ${platformName} users?`),
      false,
      {
        yes: t(locale, '是', 'Yes'),
        no: t(locale, '否', 'No'),
        hint: menuHint,
      },
    );
    let allowedUsers = '';
    if (restrictUsers) {
      allowedUsers = await ask(
        rl,
        t(locale, '允许的用户 ID（逗号分隔）', 'Allowed user IDs (comma-separated)'),
        existingAllowedUsers,
      );
    }

    heading(t(locale, '📝 写入配置...', '📝 Writing configuration...'));

    const lines: string[] = [
      '# agents-to-im configuration',
      `# Generated at ${new Date().toISOString()}`,
      '',
      '# Working directory',
      `CTI_DEFAULT_WORKDIR=${workDir}`,
      '',
      '# Feishu / Lark bot',
      `CTI_FEISHU_APP_ID=${appId}`,
      `CTI_FEISHU_APP_SECRET=${actualSecret || ''}`,
    ];

    if (domain) lines.push(`CTI_FEISHU_DOMAIN=${domain}`);
    if (allowedUsers) lines.push(`CTI_FEISHU_ALLOWED_USERS=${allowedUsers}`);
    if (claudeCliPath) {
      lines.push('', '# Claude runtime', `CTI_CLAUDE_CODE_EXECUTABLE=${claudeCliPath}`);
    }

    lines.push('');

    fs.mkdirSync(CTI_HOME, { recursive: true });
    fs.mkdirSync(path.join(CTI_HOME, 'data'), { recursive: true });
    fs.mkdirSync(path.join(CTI_HOME, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(CTI_HOME, 'runtime'), { recursive: true });

    const tmpPath = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmpPath, lines.join('\n'), { mode: 0o600 });
    fs.renameSync(tmpPath, CONFIG_PATH);

    ok(t(locale, `配置已保存到 ${c.cyan}${CONFIG_PATH}${c.reset}`, `Config saved to ${c.cyan}${CONFIG_PATH}${c.reset}`));

    heading(t(locale, '✅ 配置完成', '✅ Setup Complete'));
    console.log(`  ${c.dim}${t(locale, 'App ID:', 'App ID:')}${c.reset}     ${appId || t(locale, '(未设置)', '(not set)')}`);
    console.log(`  ${c.dim}${t(locale, '平台:', 'Platform:')}${c.reset}     ${domain || 'feishu'}`);
    console.log(`  ${c.dim}${t(locale, '工作目录:', 'Work dir:')}${c.reset}   ${workDir}`);
    console.log(`  ${c.dim}${t(locale, '配置文件:', 'Config:')}${c.reset}   ${CONFIG_PATH}`);
    console.log('');

    const bridge = getBridgeStatusSnapshot();
    const nextCommand = bridge.running ? 'restart' : 'start';
    const nextActionLabel = bridge.running
      ? t(locale, '立即重启 bridge', 'Restart bridge now')
      : t(locale, '立即启动 bridge', 'Start bridge now');

    if (appId) {
      const authUrl = buildPlatformAuthUrl(domain, appId);
      showSetupStep(`1/6 ${platformName} ${t(locale, 'Bot、权限与首次发布', 'Bot + Scopes + First Publish')}`, [
        t(locale, '在权限页启用 Bot 能力', 'Enable the Bot capability on the app auth page'),
        t(locale, '使用“导入权限”一次性导入 scopes JSON', 'Use Import Permissions to paste the scopes JSON in one shot'),
        t(locale, '完成 Bot 和权限后，先发布一次版本', 'Publish one app version after the Bot and scopes changes'),
        `${t(locale, '权限页：', 'Auth page:')} ${c.cyan}${authUrl}${c.reset}`,
      ]);

      const copyAction = await chooseOption(rl, t(locale, '先处理 scopes JSON？', 'Scopes JSON helper'), [
        { label: t(locale, '复制 scopes JSON 到剪贴板', 'Copy scopes JSON to clipboard'), value: 'copy' as const },
        { label: t(locale, '暂时跳过（Skip Now）', 'Skip Now'), value: 'skip' as const },
      ], {
        defaultIndex: 0,
        fallbackQuestion: 'Choose',
        hint: menuHint,
      });
      if (copyAction === 'copy') {
        if (tryCopyToClipboard(FEISHU_SCOPES_IMPORT_JSON)) {
          ok(t(locale, 'Scopes JSON 已复制到剪贴板', 'Scopes JSON copied to clipboard'));
        } else {
          warn(t(
            locale,
            `无法访问剪贴板，请稍后从 ${SETUP_GUIDE_URL} 手动复制`,
            `Could not access the clipboard. Copy it manually from ${SETUP_GUIDE_URL}`,
          ));
        }
      } else {
        info(t(
          locale,
          `这一步先跳过，稍后可从 ${SETUP_GUIDE_URL} 手动复制`,
          `Skipping clipboard copy for now. You can copy it later from ${SETUP_GUIDE_URL}`,
        ));
      }

      const openAuthAction = await chooseOption(rl, t(locale, '现在打开权限页？', 'Open the auth page now?'), [
        { label: t(locale, '打开权限页', 'Open auth page'), value: 'open' as const },
        { label: t(locale, '暂时跳过（Skip Now）', 'Skip Now'), value: 'skip' as const },
      ], {
        defaultIndex: 0,
        fallbackQuestion: 'Choose',
        hint: menuHint,
      });
      if (openAuthAction === 'open') {
        if (tryOpenExternalUrl(authUrl)) {
          ok(t(locale, `已打开权限页：${c.cyan}${authUrl}${c.reset}`, `Opened auth page: ${c.cyan}${authUrl}${c.reset}`));
        } else {
          warn(t(locale, `无法自动打开，请手动访问：${c.cyan}${authUrl}${c.reset}`, `Could not open the auth page automatically. Open this URL manually: ${c.cyan}${authUrl}${c.reset}`));
        }
      } else {
        info(t(locale, '先跳过自动打开，按上面的链接手动进入即可', 'Skipping auto-open for now. Open the URL above when you are ready.'));
      }

      console.log('');
      if (!(await maybePauseOnboarding(
        rl,
        t(locale, '完成 Bot、权限导入和首次发布后按回车继续', 'Press Enter after Bot, scopes, and the first publish are done'),
        {
          hint: continueHint,
          finishLaterMessage,
        },
      ))) {
        return;
      }
    }

    showSetupStep(`2/6 ${t(locale, '启动本地 bridge', 'Run the local bridge')}`, [
      t(
        locale,
        `${bridge.running ? '重启' : '启动'}本地 bridge，然后再去保存 Long Connection 事件配置`,
        `${bridge.running ? 'Restart' : 'Start'} the local bridge before you save Long Connection events`,
      ),
      t(
        locale,
        `${platformName} 会在保存事件配置时校验应用连接状态`,
        `${platformName} validates the app connection while saving event settings`,
      ),
    ]);

    const bridgeAction = await chooseOption(rl, t(locale, '这一项怎么处理？', 'How do you want to handle this step?'), [
      { label: nextActionLabel, value: 'run' as const },
      { label: t(locale, '我自己手动执行', "I'll run it myself"), value: 'manual' as const },
      { label: t(locale, '稍后继续整个引导', 'Finish onboarding later'), value: 'later' as const },
    ], {
      defaultIndex: 0,
      fallbackQuestion: 'Choose',
      hint: menuHint,
    });

    if (bridgeAction === 'run') {
      info(`${nextActionLabel}...`);
      await runDaemonCommand(nextCommand);
      ok(t(locale, `Bridge 已${bridge.running ? '重启' : '启动'}`, `Bridge ${bridge.running ? 'restarted' : 'started'}`));
      console.log('');
    } else if (bridgeAction === 'manual') {
      info(`${t(locale, '请在另一个终端执行：', 'Run this in another terminal:')} ${c.cyan}${cliCommand(nextCommand)}${c.reset}`);
      console.log('');
      if (!(await maybePauseOnboarding(
        rl,
        t(locale, '手动执行完成后按回车继续', `Press Enter after ${cliCommand(nextCommand)} has completed`),
        {
          hint: continueHint,
          finishLaterMessage,
        },
      ))) {
        return;
      }
    } else {
      warn(finishLaterMessage);
      console.log('');
      showOnboardClosing(locale);
      return;
    }

    if (appId) {
      const eventUrl = buildPlatformEventUrl(domain, appId, 'event');
      showSetupStep(`3/6 ${platformName} ${t(locale, '长连接事件', 'Long Connection Events')}`, [
        t(locale, '把 Events & Callbacks 切到 Long Connection', 'Switch Events & Callbacks to Long Connection'),
        t(locale, '把下面 4 个事件一起加上：', 'Add these 4 events together:'),
        'im.message.receive_v1',
        'im.message.message_read_v1',
        'im.chat.updated_v1',
        'im.chat.member.bot.added_v1',
        `${t(locale, '事件页：', 'Events page:')} ${c.cyan}${eventUrl}${c.reset}`,
      ]);

      const openEventsAction = await chooseOption(rl, t(locale, '现在打开事件页？', 'Open the Events page now?'), [
        { label: t(locale, '打开事件页', 'Open Events page'), value: 'open' as const },
        { label: t(locale, '暂时跳过（Skip Now）', 'Skip Now'), value: 'skip' as const },
      ], {
        defaultIndex: 0,
        fallbackQuestion: 'Choose',
        hint: menuHint,
      });
      if (openEventsAction === 'open') {
        if (tryOpenExternalUrl(eventUrl)) {
          ok(t(locale, `已打开事件页：${c.cyan}${eventUrl}${c.reset}`, `Opened Events page: ${c.cyan}${eventUrl}${c.reset}`));
        } else {
          warn(t(locale, `无法自动打开，请手动访问：${c.cyan}${eventUrl}${c.reset}`, `Could not open the Events page automatically. Open this URL manually: ${c.cyan}${eventUrl}${c.reset}`));
        }
      } else {
        info(t(locale, '先跳过自动打开，稍后手动进入事件页即可', 'Skipping auto-open for now. Open the Events page when you are ready.'));
      }

      console.log('');
      if (!(await maybePauseOnboarding(
        rl,
        t(locale, '完成 Long Connection 和 3 个事件配置后按回车继续', 'Press Enter after Long Connection and the 3 events are saved'),
        {
          hint: continueHint,
          finishLaterMessage,
        },
      ))) {
        return;
      }

      const callbackUrl = buildPlatformEventUrl(domain, appId, 'callback');
      showSetupStep(`4/6 ${platformName} ${t(locale, '卡片回调', 'Callback')}`, [
        t(locale, '在 Callback 页签添加下面这个回调：', 'Add the callback below on the Callback tab'),
        'card.action.trigger',
        `${t(locale, '回调页：', 'Callback page:')} ${c.cyan}${callbackUrl}${c.reset}`,
      ]);

      const openCallbackAction = await chooseOption(rl, t(locale, '现在打开回调页？', 'Open the Callback page now?'), [
        { label: t(locale, '打开回调页', 'Open Callback page'), value: 'open' as const },
        { label: t(locale, '暂时跳过（Skip Now）', 'Skip Now'), value: 'skip' as const },
      ], {
        defaultIndex: 0,
        fallbackQuestion: 'Choose',
        hint: menuHint,
      });
      if (openCallbackAction === 'open') {
        if (tryOpenExternalUrl(callbackUrl)) {
          ok(t(locale, `已打开回调页：${c.cyan}${callbackUrl}${c.reset}`, `Opened Callback page: ${c.cyan}${callbackUrl}${c.reset}`));
        } else {
          warn(t(locale, `无法自动打开，请手动访问：${c.cyan}${callbackUrl}${c.reset}`, `Could not open the Callback page automatically. Open this URL manually: ${c.cyan}${callbackUrl}${c.reset}`));
        }
      } else {
        info(t(locale, '先跳过自动打开，稍后手动进入回调页即可', 'Skipping auto-open for now. Open the Callback page when you are ready.'));
      }

      console.log('');
      if (!(await maybePauseOnboarding(
        rl,
        t(locale, '完成回调配置并保存后按回车继续', 'Press Enter after the callback has been added and saved'),
        {
          hint: continueHint,
          finishLaterMessage,
        },
      ))) {
        return;
      }

      const botUrl = buildPlatformBotUrl(domain, appId);
      showSetupStep(`5/6 ${t(locale, '可选：Bot 悬浮菜单', 'Optional: Bot Menu')}`, [
        t(locale, '建议配置两个悬浮菜单快捷入口：', 'Recommended: add floating menu shortcuts for fast DM entry points'),
        '/new:claude',
        '/new:codex',
        `${t(locale, 'Bot 菜单页：', 'Bot menu page:')} ${c.cyan}${botUrl}${c.reset}`,
      ]);

      const botMenuAction = await chooseOption(rl, t(locale, '这一项怎么处理？', 'How do you want to handle this step?'), [
        { label: t(locale, '打开 Bot 菜单页', 'Open Bot menu page'), value: 'open' as const },
        { label: t(locale, '暂时跳过（Skip Now）', 'Skip Now'), value: 'skip' as const },
      ], {
        defaultIndex: 0,
        fallbackQuestion: 'Choose',
        hint: menuHint,
      });
      if (botMenuAction === 'open') {
        if (tryOpenExternalUrl(botUrl)) {
          ok(t(locale, `已打开 Bot 菜单页：${c.cyan}${botUrl}${c.reset}`, `Opened Bot menu page: ${c.cyan}${botUrl}${c.reset}`));
        } else {
          warn(t(locale, `无法自动打开，请手动访问：${c.cyan}${botUrl}${c.reset}`, `Could not open the Bot menu page automatically. Open this URL manually: ${c.cyan}${botUrl}${c.reset}`));
        }
        console.log('');
        if (!(await maybePauseOnboarding(
          rl,
          t(locale, '配置完悬浮菜单后按回车继续', 'Press Enter after the floating menu has been configured'),
          {
            hint: continueHint,
            finishLaterMessage,
          },
        ))) {
          return;
        }
      } else {
        info(t(locale, '这一步先跳过，需要时可以稍后再配', 'Skipping Bot menu for now. You can configure it later if needed.'));
        console.log('');
      }

      showSetupStep(`6/6 ${t(locale, '最终发布', 'Final Publish')}`, [
        t(locale, '进入 Version Management & Release', 'Go to Version Management & Release'),
        t(locale, '把事件、回调和可选的 Bot 菜单改动再发布一次', 'Publish the remaining changes for events, callback, and optional Bot menu'),
      ]);
      if (!(await maybePauseOnboarding(
        rl,
        t(locale, '完成最终发布后按回车结束引导', 'Press Enter after the final publish has been submitted or approved'),
        {
          hint: continueHint,
          finishLaterMessage,
        },
      ))) {
        return;
      }
    }

    heading(t(locale, '✅ 平台引导完成', '✅ Platform Setup Guided'));
    info(t(
      locale,
      '飞书 / Lark 平台侧已经走完。现在可以私聊 Bot 发送 /new:claude 或 /new:codex。',
      'The Feishu/Lark platform steps are complete. You can now DM the bot with /new:claude or /new:codex.',
    ));
    console.log('');
    showOnboardClosing(locale);
  } finally {
    rl.close();
  }
}

// ── Status command ──

function showStatus() {
  showBanner();
  heading('📊 Bridge Status');

  // Check PID file
  let pid = '';
  try { pid = fs.readFileSync(PID_FILE, 'utf-8').trim(); } catch { /* */ }

  let statusJson: Record<string, unknown> = {};
  try { statusJson = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* */ }

  const running = statusJson.running === true;
  const startedAt = statusJson.startedAt as string || '';

  if (running && pid) {
    // Verify process is actually alive
    try {
      process.kill(parseInt(pid, 10), 0);
      ok(`Bridge is ${c.green}running${c.reset} (PID: ${pid})`);
    } catch {
      warn(`Bridge status file says running, but PID ${pid} is dead`);
    }
  } else {
    fail(`Bridge is ${c.red}not running${c.reset}`);
  }

  if (startedAt) info(`Started at: ${startedAt}`);
  if (statusJson.lastExitReason) warn(`Last exit: ${statusJson.lastExitReason}`);

  const channels = statusJson.channels as string[] || [];
  if (channels.length) info(`Channels: ${channels.join(', ')}`);

  // Check config
  console.log('');
  if (fs.existsSync(CONFIG_PATH)) {
    ok(`Config: ${CONFIG_PATH}`);
  } else {
    fail(`Config not found: ${CONFIG_PATH}`);
    info(`Run onboarding: ${c.cyan}${cliCommand('onboard')}${c.reset}`);
  }

  // Dashboard URL
  const port = process.env.CTI_DASHBOARD_PORT || '13578';
  if (running) {
    info(`Dashboard: ${c.cyan}http://127.0.0.1:${port}${c.reset}`);
  }
  console.log('');
}

// ── Doctor command ──

function runDoctor() {
  showBanner();
  heading('🩺 Diagnostics');

  // 1. Node.js version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  if (major >= 20) {
    ok(`Node.js ${nodeVersion}`);
  } else {
    fail(`Node.js ${nodeVersion} — need >= 20`);
  }

  // 2. Agents
  const agents = detectAgents();
  for (const agent of agents) {
    if (agent.installed) {
      ok(`${agent.name}: ${agent.version} (${agent.path})`);
    } else {
      warn(`${agent.name}: not found`);
    }
  }

  // 3. Config file
  if (fs.existsSync(CONFIG_PATH)) {
    ok(`Config exists: ${CONFIG_PATH}`);
    // Check required fields
    try {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const hasAppId = (
        content.includes('CTI_FEISHU_APP_ID=')
        && !content.includes('CTI_FEISHU_APP_ID=your-app-id')
      );
      const hasSecret = (
        content.includes('CTI_FEISHU_APP_SECRET=')
        && !content.includes('CTI_FEISHU_APP_SECRET=your-app-secret')
      );
      if (hasAppId) { ok('Feishu App ID configured'); } else { fail('Feishu App ID missing or placeholder'); }
      if (hasSecret) { ok('Feishu App Secret configured'); } else { fail('Feishu App Secret missing or placeholder'); }
    } catch { fail('Cannot read config file'); }
  } else {
    fail(`Config not found: ${CONFIG_PATH}`);
    info(`Run onboarding: ${c.cyan}${cliCommand('onboard')}${c.reset}`);
  }

  // 4. Data directory
  const dataDir = path.join(CTI_HOME, 'data');
  if (fs.existsSync(dataDir)) {
    ok(`Data directory: ${dataDir}`);
  } else {
    warn(`Data directory not found (will be created on first start)`);
  }

  // 5. Process status
  let pid = '';
  try { pid = fs.readFileSync(PID_FILE, 'utf-8').trim(); } catch { /* */ }
  if (pid) {
    try {
      process.kill(parseInt(pid, 10), 0);
      ok(`Bridge process alive (PID: ${pid})`);
    } catch {
      warn(`Stale PID file (PID ${pid} not running)`);
    }
  } else {
    info('Bridge not running');
  }

  // 6. Log file
  const logFile = path.join(CTI_HOME, 'logs', 'bridge.log');
  if (fs.existsSync(logFile)) {
    const stat = fs.statSync(logFile);
    ok(`Log file: ${logFile} (${(stat.size / 1024).toFixed(1)} KB)`);
    console.log('');
    info('Last 10 log lines:');
    try {
      const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
      const last = lines.slice(-10);
      for (const line of last) {
        console.log(`    ${c.dim}${line}${c.reset}`);
      }
    } catch { /* */ }
  } else {
    info('No log file yet');
  }

  console.log('');
}

// ── Start/Stop (delegate to daemon.sh) ──

function findDaemonScript(): string | null {
  // Look relative to this script's location
  const candidates = [
    path.join(CLI_DIR, '..', 'scripts', 'daemon.sh'),
    path.join(CLI_DIR, 'scripts', 'daemon.sh'),
    path.join(process.cwd(), 'scripts', 'daemon.sh'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function runDaemonCommand(command: string): Promise<void> {
  const script = findDaemonScript();
  if (!script) {
    throw new Error('Cannot find daemon.sh script');
  }
  await runChild('bash', [script, command], {
    env: { ...process.env, CTI_HOME },
  });
}

function delegateToDaemon(command: string) {
  runDaemonCommand(command).then(() => {
    process.exit(0);
  }).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    const packageRoot = findAgentsToImPackageRoot(CLI_DIR) || findAgentsToImPackageRoot(process.cwd());
    if (packageRoot && fs.existsSync(path.join(packageRoot, '.git'))) {
      info('If running from source, make sure you are in the project directory');
    } else {
      info(`If this is a packaged install, refresh it with ${c.cyan}${npmInstallCommand()}${c.reset}`);
    }
    process.exit(1);
  });
}

async function runUpgrade() {
  showBanner();
  heading('⬆️ Upgrade agents-to-im');

  const packageRoot = findAgentsToImPackageRoot(CLI_DIR) || findAgentsToImPackageRoot(process.cwd());
  if (!packageRoot) {
    fail('Cannot determine the agents-to-im package root from the current installation.');
    process.exit(1);
  }

  const currentVersion = readAgentsToImVersion(packageRoot);
  const isSourceCheckout = fs.existsSync(path.join(packageRoot, '.git'));
  const bridge = getBridgeStatusSnapshot();

  let gitStatusOutput = '';
  if (isSourceCheckout) {
    ensureCommandAvailable('git');
    try {
      gitStatusOutput = execSync('git status --porcelain', {
        cwd: packageRoot,
        encoding: 'utf-8',
        timeout: 5000,
      });
    } catch (error) {
      fail(`Cannot inspect git worktree: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  const result = buildUpgradePlan({
    packageRoot,
    currentVersion,
    isSourceCheckout,
    bridgeRunning: bridge.running,
    gitStatusOutput,
  });

  if (!result.ok) {
    fail(result.reason);
    if (isSourceCheckout) {
      info('Commit or stash local changes, then rerun the upgrade command.');
    }
    process.exit(1);
  }

  const { plan } = result;
  for (const command of new Set(plan.steps.map((step) => step.command))) {
    ensureCommandAvailable(command);
  }
  info(`Current version: ${plan.currentVersion}`);
  info(`Install mode: ${plan.mode === 'source' ? 'source checkout' : 'global npm package'}`);
  info(`Package root: ${plan.packageRoot}`);
  info(`Bridge running: ${bridge.running ? `yes${bridge.pid ? ` (PID: ${bridge.pid})` : ''}` : 'no'}`);
  console.log('');
  info('Upgrade steps:');
  for (const step of plan.steps) {
    const location = step.cwd ? ` ${c.dim}(cwd: ${step.cwd})${c.reset}` : '';
    console.log(`    ${c.cyan}$ ${step.command} ${step.args.join(' ')}${c.reset}${location}`);
  }
  if (plan.restartBridge) {
    info('Bridge will be restarted after the upgrade completes.');
  }
  console.log('');

  for (const step of plan.steps) {
    info(`${step.description}...`);
    await runChild(step.command, step.args, {
      cwd: step.cwd,
      env: { ...process.env, CTI_HOME },
    });
    ok(step.description);
  }

  if (plan.restartBridge) {
    info('Restarting bridge...');
    await runDaemonCommand('restart');
    ok('Bridge restarted');
  } else {
    info(`Upgrade complete. Use ${c.cyan}${cliCommand('start')}${c.reset} when you want to run the bridge.`);
  }

  console.log('');
}

function isCliEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

export function runCli(args = process.argv.slice(2)): void {
  const command = args[0] || '';

  switch (command) {
    case 'onboard':
    case 'setup':
      setupWizard().catch((err) => {
        console.error('Setup error:', err);
        process.exit(1);
      });
      break;
    case 'start':
      delegateToDaemon('start');
      break;
    case 'restart':
      delegateToDaemon('restart');
      break;
    case 'stop':
      delegateToDaemon('stop');
      break;
    case 'status':
      showStatus();
      break;
    case 'doctor':
      runDoctor();
      break;
    case 'upgrade':
      runUpgrade().catch((error) => {
        fail(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
      break;
    case 'logs': {
      const n = parseInt(args[1] || '50', 10);
      const logFile = path.join(CTI_HOME, 'logs', 'bridge.log');
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
        console.log(lines.slice(-n).join('\n'));
      } else {
        fail('No log file found');
      }
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      showBanner();
      console.log(`  Usage: ${cliCommand()} [command]`);
      console.log('');
      console.log('  Commands:');
      console.log(`    ${c.cyan}(none)${c.reset}    Interactive onboarding wizard`);
      console.log(`    ${c.cyan}onboard${c.reset}   Run the onboarding wizard explicitly`);
      console.log(`    ${c.cyan}start${c.reset}     Start the bridge daemon`);
      console.log(`    ${c.cyan}restart${c.reset}   Restart the bridge daemon`);
      console.log(`    ${c.cyan}stop${c.reset}      Stop the bridge daemon`);
      console.log(`    ${c.cyan}status${c.reset}    Show bridge status`);
      console.log(`    ${c.cyan}doctor${c.reset}    Run diagnostics`);
      console.log(`    ${c.cyan}upgrade${c.reset}   Upgrade the local installation`);
      console.log(`    ${c.cyan}logs${c.reset} [n]  Show last n log lines (default 50)`);
      console.log(`    ${c.cyan}help${c.reset}      Show this help`);
      console.log('');
      break;
    default:
      if (command && !command.startsWith('-')) {
        fail(`Unknown command: ${command}`);
        info('Run with --help for usage');
        process.exit(1);
      }
      // No command = interactive onboarding
      setupWizard().catch((err) => {
        console.error('Setup error:', err);
        process.exit(1);
      });
  }
}

if (isCliEntrypoint()) {
  runCli();
}
