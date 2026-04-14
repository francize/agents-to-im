import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_FEISHU_PROFILE_ID = 'default';

export interface FeishuProfileConfig {
  id: string;
  appId?: string;
  appSecret?: string;
  domain?: 'lark';
  allowedUsers?: string[];
  showToolCallCards?: boolean;
}

export interface Config {
  defaultWorkDir: string;
  feishu: FeishuProfileConfig;
  claudeCliExecutable?: string;
}

export const DEFAULT_CTI_HOME = path.join(os.homedir(), '.agents-to-im');
export const CTI_HOME = process.env.CTI_HOME || DEFAULT_CTI_HOME;
export const CONFIG_PATH = path.join(CTI_HOME, 'config.env');

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function loadFeishuConfig(env: Map<string, string>): FeishuProfileConfig {
  return {
    id: DEFAULT_FEISHU_PROFILE_ID,
    appId: env.get('CTI_FEISHU_APP_ID') || undefined,
    appSecret: env.get('CTI_FEISHU_APP_SECRET') || undefined,
    domain: env.get('CTI_FEISHU_DOMAIN') === 'lark' ? 'lark' : undefined,
    allowedUsers: splitCsv(env.get('CTI_FEISHU_ALLOWED_USERS') || undefined),
    showToolCallCards: parseBoolean(env.get('CTI_FEISHU_SHOW_TOOL_CALL_CARDS')) ?? false,
  };
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults.
  }

  return {
    defaultWorkDir: env.get('CTI_DEFAULT_WORKDIR') || process.cwd(),
    feishu: loadFeishuConfig(env),
    claudeCliExecutable: env.get('CTI_CLAUDE_CODE_EXECUTABLE') || undefined,
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return `${key}=${value}\n`;
}

function formatBooleanEnvLine(key: string, value: boolean | undefined): string {
  if (value === undefined) return '';
  return `${key}=${value ? 'true' : 'false'}\n`;
}

function formatFeishuLines(profile: FeishuProfileConfig): string {
  let out = '';
  out += formatEnvLine('CTI_FEISHU_APP_ID', profile.appId);
  out += formatEnvLine('CTI_FEISHU_APP_SECRET', profile.appSecret);
  out += formatEnvLine('CTI_FEISHU_DOMAIN', profile.domain);
  out += formatEnvLine('CTI_FEISHU_ALLOWED_USERS', profile.allowedUsers?.join(','));
  out += formatBooleanEnvLine('CTI_FEISHU_SHOW_TOOL_CALL_CARDS', profile.showToolCallCards);
  return out;
}

export function saveConfig(config: Config): void {
  let out = '';
  out += formatEnvLine('CTI_DEFAULT_WORKDIR', config.defaultWorkDir);
  out += formatFeishuLines(config.feishu);
  out += formatEnvLine('CTI_CLAUDE_CODE_EXECUTABLE', config.claudeCliExecutable);

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const settings = new Map<string, string>();
  const feishu = config.feishu;
  settings.set('remote_bridge_enabled', 'true');
  settings.set('bridge_feishu_enabled', 'true');
  settings.set('bridge_default_work_dir', config.defaultWorkDir);
  if (feishu.appId) settings.set('bridge_feishu_app_id', feishu.appId);
  if (feishu.appSecret) settings.set('bridge_feishu_app_secret', feishu.appSecret);
  if (feishu.domain) settings.set('bridge_feishu_domain', feishu.domain);
  if (feishu.allowedUsers) {
    settings.set('bridge_feishu_allowed_users', feishu.allowedUsers.join(','));
  }
  return settings;
}
