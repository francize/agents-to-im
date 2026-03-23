import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeName } from './runtime-types.js';

export interface Config {
  defaultWorkDir: string;
  defaultMode: 'code' | 'plan' | 'ask';
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  feishuToolOutputCards?: boolean;
  autoApprove?: boolean;
  claudeDefaultModel?: string;
  codexDefaultModel?: string;
  claudeCliExecutable?: string;
  legacyRuntime?: RuntimeName;
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
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
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

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return defaultValue;
}

function parseRuntime(value: string | undefined): RuntimeName | undefined {
  if (value === 'claude' || value === 'codex') return value;
  if (value === 'auto') return 'claude';
  return undefined;
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
    defaultMode: ((env.get('CTI_DEFAULT_MODE') || 'code') as Config['defaultMode']),
    feishuAppId: env.get('CTI_FEISHU_APP_ID') || undefined,
    feishuAppSecret: env.get('CTI_FEISHU_APP_SECRET') || undefined,
    feishuDomain: env.get('CTI_FEISHU_DOMAIN') || undefined,
    feishuAllowedUsers: splitCsv(env.get('CTI_FEISHU_ALLOWED_USERS')),
    feishuToolOutputCards: parseBoolean(env.get('CTI_FEISHU_TOOL_OUTPUT_CARDS'), true),
    autoApprove: env.get('CTI_AUTO_APPROVE') === 'true',
    claudeDefaultModel: env.get('CTI_CLAUDE_DEFAULT_MODEL') || undefined,
    codexDefaultModel: env.get('CTI_CODEX_DEFAULT_MODEL') || undefined,
    claudeCliExecutable: env.get('CTI_CLAUDE_CODE_EXECUTABLE') || undefined,
    legacyRuntime: parseRuntime(env.get('CTI_RUNTIME')),
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = '';
  out += formatEnvLine('CTI_DEFAULT_WORKDIR', config.defaultWorkDir);
  out += formatEnvLine('CTI_DEFAULT_MODE', config.defaultMode);
  out += formatEnvLine('CTI_FEISHU_APP_ID', config.feishuAppId);
  out += formatEnvLine('CTI_FEISHU_APP_SECRET', config.feishuAppSecret);
  out += formatEnvLine('CTI_FEISHU_DOMAIN', config.feishuDomain);
  out += formatEnvLine('CTI_FEISHU_ALLOWED_USERS', config.feishuAllowedUsers?.join(','));
  out += formatEnvLine(
    'CTI_FEISHU_TOOL_OUTPUT_CARDS',
    config.feishuToolOutputCards === undefined ? undefined : String(config.feishuToolOutputCards),
  );
  out += formatEnvLine('CTI_AUTO_APPROVE', config.autoApprove ? 'true' : undefined);
  out += formatEnvLine('CTI_CLAUDE_DEFAULT_MODEL', config.claudeDefaultModel);
  out += formatEnvLine('CTI_CODEX_DEFAULT_MODEL', config.codexDefaultModel);
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
  settings.set('remote_bridge_enabled', 'true');
  settings.set('bridge_feishu_enabled', 'true');
  settings.set('bridge_default_work_dir', config.defaultWorkDir);
  settings.set('bridge_default_mode', config.defaultMode);
  settings.set('bridge_default_runtime', config.legacyRuntime || 'claude');

  if (config.feishuAppId) settings.set('bridge_feishu_app_id', config.feishuAppId);
  if (config.feishuAppSecret) settings.set('bridge_feishu_app_secret', config.feishuAppSecret);
  if (config.feishuDomain) settings.set('bridge_feishu_domain', config.feishuDomain);
  if (config.feishuAllowedUsers) {
    settings.set('bridge_feishu_allowed_users', config.feishuAllowedUsers.join(','));
  }
  settings.set('bridge_feishu_tool_output_cards', config.feishuToolOutputCards === false ? 'false' : 'true');

  if (config.claudeDefaultModel) {
    settings.set('bridge_default_model', config.claudeDefaultModel);
    settings.set('default_model', config.claudeDefaultModel);
    settings.set('bridge_claude_default_model', config.claudeDefaultModel);
  }
  if (config.codexDefaultModel) {
    settings.set('bridge_codex_default_model', config.codexDefaultModel);
  }

  return settings;
}
