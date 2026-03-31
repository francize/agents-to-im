import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeName } from '../runtime/types.js';

export const DEFAULT_FEISHU_PROFILE_ID = 'default';

export interface FeishuProfileConfig {
  id: string;
  label: string;
  appId?: string;
  appSecret?: string;
  domain?: 'lark';
  allowedUsers?: string[];
  toolOutputCards: boolean;
  autoImageSend: boolean;
}

export interface Config {
  defaultWorkDir: string;
  defaultMode: 'code' | 'plan' | 'ask';
  feishu: FeishuProfileConfig;
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

function defaultProfileLabel(profileId: string): string {
  return profileId === DEFAULT_FEISHU_PROFILE_ID ? '默认 Bot' : profileId;
}

function getProfileValue(env: Map<string, string>, profileId: string, suffix: string): string | undefined {
  return env.get(`CTI_FEISHU_PROFILE_${profileId.toUpperCase()}_${suffix}`) || undefined;
}

function getSingleFeishuValue(
  env: Map<string, string>,
  profileId: string,
  suffix: string,
): string | undefined {
  return env.get(`CTI_FEISHU_${suffix}`)
    || getProfileValue(env, profileId, suffix)
    || undefined;
}

function loadFeishuConfig(env: Map<string, string>): FeishuProfileConfig {
  const profileId = DEFAULT_FEISHU_PROFILE_ID;
  return {
    id: profileId,
    label: getSingleFeishuValue(env, profileId, 'LABEL') || defaultProfileLabel(profileId),
    appId: getSingleFeishuValue(env, profileId, 'APP_ID'),
    appSecret: getSingleFeishuValue(env, profileId, 'APP_SECRET'),
    domain: getSingleFeishuValue(env, profileId, 'DOMAIN') === 'lark' ? 'lark' : undefined,
    allowedUsers: splitCsv(getSingleFeishuValue(env, profileId, 'ALLOWED_USERS')),
    toolOutputCards: parseBoolean(getSingleFeishuValue(env, profileId, 'TOOL_OUTPUT_CARDS'), true),
    autoImageSend: parseBoolean(getSingleFeishuValue(env, profileId, 'AUTO_IMAGE_SEND'), true),
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
    defaultMode: ((env.get('CTI_DEFAULT_MODE') || 'code') as Config['defaultMode']),
    feishu: loadFeishuConfig(env),
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

function formatFeishuLines(profile: FeishuProfileConfig): string {
  let out = '';
  out += formatEnvLine('CTI_FEISHU_APP_ID', profile.appId);
  out += formatEnvLine('CTI_FEISHU_APP_SECRET', profile.appSecret);
  out += formatEnvLine('CTI_FEISHU_DOMAIN', profile.domain);
  out += formatEnvLine('CTI_FEISHU_ALLOWED_USERS', profile.allowedUsers?.join(','));
  out += formatEnvLine('CTI_FEISHU_TOOL_OUTPUT_CARDS', String(profile.toolOutputCards));
  out += formatEnvLine('CTI_FEISHU_AUTO_IMAGE_SEND', String(profile.autoImageSend));
  out += formatEnvLine('CTI_FEISHU_LABEL', profile.label);
  return out;
}

export function saveConfig(config: Config): void {
  let out = '';
  out += formatEnvLine('CTI_DEFAULT_WORKDIR', config.defaultWorkDir);
  out += formatEnvLine('CTI_DEFAULT_MODE', config.defaultMode);
  out += formatFeishuLines(config.feishu);
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
  const feishu = config.feishu;
  settings.set('remote_bridge_enabled', 'true');
  settings.set('bridge_feishu_enabled', 'true');
  settings.set('bridge_default_work_dir', config.defaultWorkDir);
  settings.set('bridge_default_mode', config.defaultMode);
  settings.set('bridge_default_runtime', config.legacyRuntime || 'claude');
  if (feishu.appId) settings.set('bridge_feishu_app_id', feishu.appId);
  if (feishu.appSecret) settings.set('bridge_feishu_app_secret', feishu.appSecret);
  if (feishu.domain) settings.set('bridge_feishu_domain', feishu.domain);
  if (feishu.allowedUsers) {
    settings.set('bridge_feishu_allowed_users', feishu.allowedUsers.join(','));
  }
  settings.set('bridge_feishu_tool_output_cards', feishu.toolOutputCards ? 'true' : 'false');
  settings.set('bridge_feishu_auto_image_send', feishu.autoImageSend ? 'true' : 'false');

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
