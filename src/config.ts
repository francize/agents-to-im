import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeName } from './runtime-types.js';

export const DEFAULT_FEISHU_PROFILE_ID = 'default';
const PROFILE_ID_RE = /^[a-z0-9_]+$/;

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

export interface RuntimeFeishuProfileMap {
  claude: string;
  codex: string;
}

export interface Config {
  defaultWorkDir: string;
  defaultMode: 'code' | 'plan' | 'ask';
  feishuProfiles: FeishuProfileConfig[];
  runtimeFeishuProfiles: RuntimeFeishuProfileMap;
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

function normalizeProfileId(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || !PROFILE_ID_RE.test(normalized)) return null;
  return normalized;
}

function defaultProfileLabel(profileId: string): string {
  return profileId === DEFAULT_FEISHU_PROFILE_ID ? '默认 Bot' : profileId;
}

function getProfileValue(env: Map<string, string>, profileId: string, suffix: string): string | undefined {
  return env.get(`CTI_FEISHU_PROFILE_${profileId.toUpperCase()}_${suffix}`) || undefined;
}

function buildFeishuProfile(
  env: Map<string, string>,
  profileId: string,
  fallback?: Partial<FeishuProfileConfig>,
): FeishuProfileConfig {
  return {
    id: profileId,
    label: getProfileValue(env, profileId, 'LABEL') || fallback?.label || defaultProfileLabel(profileId),
    appId: getProfileValue(env, profileId, 'APP_ID') || fallback?.appId || undefined,
    appSecret: getProfileValue(env, profileId, 'APP_SECRET') || fallback?.appSecret || undefined,
    domain: (getProfileValue(env, profileId, 'DOMAIN') || fallback?.domain) === 'lark' ? 'lark' : undefined,
    allowedUsers: splitCsv(getProfileValue(env, profileId, 'ALLOWED_USERS')) || fallback?.allowedUsers,
    toolOutputCards: parseBoolean(
      getProfileValue(env, profileId, 'TOOL_OUTPUT_CARDS'),
      fallback?.toolOutputCards ?? true,
    ),
    autoImageSend: parseBoolean(
      getProfileValue(env, profileId, 'AUTO_IMAGE_SEND'),
      fallback?.autoImageSend ?? true,
    ),
  };
}

function loadFeishuProfiles(env: Map<string, string>): FeishuProfileConfig[] {
  const explicitProfileIds = splitCsv(env.get('CTI_FEISHU_PROFILE_IDS'))
    ?.map((value) => normalizeProfileId(value))
    .filter((value): value is string => !!value);
  if (explicitProfileIds && explicitProfileIds.length > 0) {
    return explicitProfileIds.map((profileId) => buildFeishuProfile(env, profileId));
  }

  const hasLegacyFeishuConfig = [
    env.get('CTI_FEISHU_APP_ID'),
    env.get('CTI_FEISHU_APP_SECRET'),
    env.get('CTI_FEISHU_DOMAIN'),
    env.get('CTI_FEISHU_ALLOWED_USERS'),
    env.get('CTI_FEISHU_TOOL_OUTPUT_CARDS'),
    env.get('CTI_FEISHU_AUTO_IMAGE_SEND'),
  ].some((value) => value !== undefined);

  if (hasLegacyFeishuConfig) {
    return [
      {
        id: DEFAULT_FEISHU_PROFILE_ID,
        label: defaultProfileLabel(DEFAULT_FEISHU_PROFILE_ID),
        appId: env.get('CTI_FEISHU_APP_ID') || undefined,
        appSecret: env.get('CTI_FEISHU_APP_SECRET') || undefined,
        domain: env.get('CTI_FEISHU_DOMAIN') === 'lark' ? 'lark' : undefined,
        allowedUsers: splitCsv(env.get('CTI_FEISHU_ALLOWED_USERS')),
        toolOutputCards: parseBoolean(env.get('CTI_FEISHU_TOOL_OUTPUT_CARDS'), true),
        autoImageSend: parseBoolean(env.get('CTI_FEISHU_AUTO_IMAGE_SEND'), true),
      },
    ];
  }

  return [buildFeishuProfile(env, DEFAULT_FEISHU_PROFILE_ID)];
}

function resolveRuntimeProfileMapping(
  env: Map<string, string>,
  profiles: FeishuProfileConfig[],
): RuntimeFeishuProfileMap {
  const knownIds = new Set(profiles.map((profile) => profile.id));
  const defaultProfileId = profiles.find((profile) => profile.id === DEFAULT_FEISHU_PROFILE_ID)?.id || profiles[0]?.id || DEFAULT_FEISHU_PROFILE_ID;

  const pick = (value: string | undefined): string => {
    const profileId = normalizeProfileId(value);
    if (profileId && knownIds.has(profileId)) return profileId;
    return defaultProfileId;
  };

  return {
    claude: pick(env.get('CTI_RUNTIME_CLAUDE_FEISHU_PROFILE')),
    codex: pick(env.get('CTI_RUNTIME_CODEX_FEISHU_PROFILE')),
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

  const feishuProfiles = loadFeishuProfiles(env);
  return {
    defaultWorkDir: env.get('CTI_DEFAULT_WORKDIR') || process.cwd(),
    defaultMode: ((env.get('CTI_DEFAULT_MODE') || 'code') as Config['defaultMode']),
    feishuProfiles,
    runtimeFeishuProfiles: resolveRuntimeProfileMapping(env, feishuProfiles),
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

function formatProfileLines(profile: FeishuProfileConfig): string {
  const prefix = `CTI_FEISHU_PROFILE_${profile.id.toUpperCase()}_`;
  let out = '';
  out += formatEnvLine(`${prefix}APP_ID`, profile.appId);
  out += formatEnvLine(`${prefix}APP_SECRET`, profile.appSecret);
  out += formatEnvLine(`${prefix}DOMAIN`, profile.domain);
  out += formatEnvLine(`${prefix}ALLOWED_USERS`, profile.allowedUsers?.join(','));
  out += formatEnvLine(`${prefix}TOOL_OUTPUT_CARDS`, String(profile.toolOutputCards));
  out += formatEnvLine(`${prefix}AUTO_IMAGE_SEND`, String(profile.autoImageSend));
  out += formatEnvLine(`${prefix}LABEL`, profile.label);
  return out;
}

export function saveConfig(config: Config): void {
  let out = '';
  out += formatEnvLine('CTI_DEFAULT_WORKDIR', config.defaultWorkDir);
  out += formatEnvLine('CTI_DEFAULT_MODE', config.defaultMode);
  out += formatEnvLine(
    'CTI_FEISHU_PROFILE_IDS',
    config.feishuProfiles
      .map((profile) => normalizeProfileId(profile.id))
      .filter((profileId): profileId is string => !!profileId)
      .join(','),
  );
  for (const profile of config.feishuProfiles) {
    const profileId = normalizeProfileId(profile.id);
    if (!profileId) continue;
    out += formatProfileLines({ ...profile, id: profileId });
  }
  out += formatEnvLine('CTI_RUNTIME_CLAUDE_FEISHU_PROFILE', config.runtimeFeishuProfiles.claude);
  out += formatEnvLine('CTI_RUNTIME_CODEX_FEISHU_PROFILE', config.runtimeFeishuProfiles.codex);
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

export function getFeishuProfile(
  config: Config,
  profileId: string,
): FeishuProfileConfig | null {
  return config.feishuProfiles.find((profile) => profile.id === profileId) || null;
}

export function getRuntimeFeishuProfile(
  config: Config,
  runtime: RuntimeName,
): FeishuProfileConfig | null {
  return getFeishuProfile(config, config.runtimeFeishuProfiles[runtime]);
}

export function configToSettings(config: Config): Map<string, string> {
  const settings = new Map<string, string>();
  settings.set('remote_bridge_enabled', 'true');
  settings.set('bridge_feishu_enabled', config.feishuProfiles.length > 0 ? 'true' : 'false');
  settings.set('bridge_default_work_dir', config.defaultWorkDir);
  settings.set('bridge_default_mode', config.defaultMode);
  settings.set('bridge_default_runtime', config.legacyRuntime || 'claude');
  settings.set('bridge_feishu_profile_ids', config.feishuProfiles.map((profile) => profile.id).join(','));
  settings.set('bridge_runtime_claude_feishu_profile', config.runtimeFeishuProfiles.claude);
  settings.set('bridge_runtime_codex_feishu_profile', config.runtimeFeishuProfiles.codex);

  const defaultProfile = getRuntimeFeishuProfile(config, 'claude')
    || getFeishuProfile(config, DEFAULT_FEISHU_PROFILE_ID)
    || config.feishuProfiles[0];

  for (const profile of config.feishuProfiles) {
    const prefix = `bridge_feishu_profile_${profile.id}_`;
    if (profile.appId) settings.set(`${prefix}app_id`, profile.appId);
    if (profile.appSecret) settings.set(`${prefix}app_secret`, profile.appSecret);
    if (profile.domain) settings.set(`${prefix}domain`, profile.domain);
    if (profile.allowedUsers) settings.set(`${prefix}allowed_users`, profile.allowedUsers.join(','));
    settings.set(`${prefix}tool_output_cards`, profile.toolOutputCards ? 'true' : 'false');
    settings.set(`${prefix}auto_image_send`, profile.autoImageSend ? 'true' : 'false');
    settings.set(`${prefix}label`, profile.label);
  }

  if (defaultProfile) {
    if (defaultProfile.appId) settings.set('bridge_feishu_app_id', defaultProfile.appId);
    if (defaultProfile.appSecret) settings.set('bridge_feishu_app_secret', defaultProfile.appSecret);
    if (defaultProfile.domain) settings.set('bridge_feishu_domain', defaultProfile.domain);
    if (defaultProfile.allowedUsers) {
      settings.set('bridge_feishu_allowed_users', defaultProfile.allowedUsers.join(','));
    }
    settings.set('bridge_feishu_tool_output_cards', defaultProfile.toolOutputCards ? 'true' : 'false');
    settings.set('bridge_feishu_auto_image_send', defaultProfile.autoImageSend ? 'true' : 'false');
  }

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
