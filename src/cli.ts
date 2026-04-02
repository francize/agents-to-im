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

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.agents-to-im');
const CONFIG_PATH = path.join(CTI_HOME, 'config.env');
const PID_FILE = path.join(CTI_HOME, 'runtime', 'bridge.pid');
const STATUS_FILE = path.join(CTI_HOME, 'runtime', 'status.json');
const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_COMMAND = 'agents-to-im';
const NPM_INSTALL_SPEC = 'agents-to-im@beta';
const MACOS_LAUNCHD_LABEL = 'com.agents-to-im.bridge';

function cliCommand(command?: string): string {
  return command
    ? `${CLI_COMMAND} ${command}`
    : CLI_COMMAND;
}

function npmInstallCommand(): string {
  return `npm install -g ${NPM_INSTALL_SPEC}`;
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

function ok(msg: string) { console.log(`  ${c.green}✓${c.reset} ${msg}`); }
function warn(msg: string) { console.log(`  ${c.yellow}⚠${c.reset} ${msg}`); }
function fail(msg: string) { console.log(`  ${c.red}✗${c.reset} ${msg}`); }
function info(msg: string) { console.log(`  ${c.blue}ℹ${c.reset} ${msg}`); }
function heading(msg: string) { console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}\n`); }

// ── Readline helpers ──

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

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await ask(rl, `${question} [${hint}]`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

async function select(
  rl: readline.Interface,
  question: string,
  options: string[],
  defaultIndex = 0,
): Promise<number> {
  console.log(`  ${c.white}${question}${c.reset}`);
  options.forEach((opt, i) => console.log(`    ${c.cyan}${i + 1}.${c.reset} ${opt}`));
  const answer = await ask(rl, 'Choose');
  const idx = parseInt(answer, 10) - 1;
  return (idx >= 0 && idx < options.length) ? idx : defaultIndex;
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

function showBanner() {
  console.log('');
  console.log(`  ${c.bold}${c.magenta}┌─────────────────────────────────────────┐${c.reset}`);
  console.log(`  ${c.bold}${c.magenta}│${c.reset}  ${c.bold}⚡ agents-to-im${c.reset}                        ${c.bold}${c.magenta}│${c.reset}`);
  console.log(`  ${c.bold}${c.magenta}│${c.reset}  ${c.dim}Feishu/Lark bridge for AI coding agents${c.reset}  ${c.bold}${c.magenta}│${c.reset}`);
  console.log(`  ${c.bold}${c.magenta}└─────────────────────────────────────────┘${c.reset}`);
  console.log('');
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
  heading('🔍 Detecting installed agents...');

  const agents = detectAgents();
  for (const agent of agents) {
    if (agent.installed) {
      ok(`${agent.name} ${c.dim}${agent.version}${c.reset}`);
    } else {
      warn(`${agent.name} ${c.dim}not found${c.reset}`);
    }
  }

  const hasAnyAgent = agents.some(a => a.installed);
  if (!hasAnyAgent) {
    console.log('');
    fail('No AI agents detected.');
    info('Install at least one:');
    info(`  Claude Code: ${c.cyan}npm install -g @anthropic-ai/claude-code${c.reset}`);
    info(`  Codex:       ${c.cyan}npm install -g @openai/codex${c.reset}`);
    console.log('');
    const rl = createRl();
    const cont = await confirm(rl, 'Continue setup anyway?', false);
    rl.close();
    if (!cont) process.exit(0);
  }

  heading('🔧 Feishu / Lark Configuration');

  const rl = createRl();

  // Load existing config if present
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
  } catch { /* no existing config */ }

  info('You need a Feishu/Lark custom app with bot capability.');
  info(`Create one at: ${c.cyan}https://open.feishu.cn/app${c.reset}`);
  console.log('');

  const existingAppId = existing.CTI_FEISHU_APP_ID || '';
  const existingAppSecret = existing.CTI_FEISHU_APP_SECRET || '';
  const existingDomain = existing.CTI_FEISHU_DOMAIN || '';
  const existingAllowedUsers = existing.CTI_FEISHU_ALLOWED_USERS || '';

  const appId = await ask(rl, 'Feishu App ID', existingAppId);
  const appSecret = await ask(rl, 'Feishu App Secret', existingAppSecret ? '****' + existingAppSecret.slice(-4) : undefined);
  const actualSecret = appSecret.startsWith('****') ? existingAppSecret : appSecret;

  const domainIdx = await select(rl, 'Platform:', ['Feishu (飞书)', 'Lark (international)'], existingDomain === 'lark' ? 1 : 0);
  const domain = domainIdx === 1 ? 'lark' : '';

  heading('📁 Working Directory');

  const defaultWorkDir = existing.CTI_DEFAULT_WORKDIR || process.cwd();
  const workDir = await ask(rl, 'Default working directory', defaultWorkDir);

  // Optional: allowed users
  console.log('');
  const restrictUsers = await confirm(rl, 'Restrict to specific Feishu users?', false);
  let allowedUsers = '';
  if (restrictUsers) {
    allowedUsers = await ask(rl, 'Allowed user IDs (comma-separated)', existingAllowedUsers);
  }

  rl.close();

  // Build config
  heading('📝 Writing configuration...');

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

  lines.push('');

  fs.mkdirSync(CTI_HOME, { recursive: true });
  fs.mkdirSync(path.join(CTI_HOME, 'data'), { recursive: true });
  fs.mkdirSync(path.join(CTI_HOME, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(CTI_HOME, 'runtime'), { recursive: true });

  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);

  ok(`Config saved to ${c.cyan}${CONFIG_PATH}${c.reset}`);

  // Summary
  heading('✅ Setup Complete');
  console.log(`  ${c.dim}App ID:${c.reset}     ${appId || '(not set)'}`);
  console.log(`  ${c.dim}Platform:${c.reset}   ${domain || 'feishu'}`);
  console.log(`  ${c.dim}Work dir:${c.reset}   ${workDir}`);
  console.log(`  ${c.dim}Config:${c.reset}     ${CONFIG_PATH}`);
  console.log('');

  const bridge = getBridgeStatusSnapshot();
  const nextCommand = bridge.running ? 'restart' : 'start';
  const nextLabel = bridge.running ? 'Restart bridge now' : 'Start bridge now';
  const actionRl = createRl();
  const nextStepIdx = await select(actionRl, 'Next step:', [nextLabel, 'Not now'], 0);
  actionRl.close();

  if (nextStepIdx === 0) {
    info(`${nextLabel}...`);
    await runDaemonCommand(nextCommand);
    ok(`Bridge ${bridge.running ? 'restarted' : 'started'}`);
    console.log('');
  }

  info(`Onboard again:     ${c.cyan}${cliCommand('onboard')}${c.reset}`);
  info(`Start the bridge:  ${c.cyan}${cliCommand('start')}${c.reset}`);
  info(`Quick restart:     ${c.cyan}${cliCommand('restart')}${c.reset}`);
  info(`Check status:      ${c.cyan}${cliCommand('status')}${c.reset}`);
  info(`Run diagnostics:   ${c.cyan}${cliCommand('doctor')}${c.reset}`);
  console.log('');
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
