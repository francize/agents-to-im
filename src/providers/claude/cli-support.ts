import fs from 'node:fs';
import { execSync } from 'node:child_process';

import type { Config } from '../../config/config.js';

// ── Environment isolation ──

/** Env vars always passed through to the CLI subprocess. */
const ENV_WHITELIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  'TMPDIR', 'TEMP', 'TMP',
  'TERM', 'COLORTERM',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK',
]);

/** Prefixes that are always stripped (even in inherit mode). */
const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

/**
 * Build a clean env for the CLI subprocess.
 *
 * CTI_ENV_ISOLATION (default "inherit"):
 *   "inherit" — full parent env minus CLAUDECODE (recommended; daemon
 *               already runs in a clean launchd/setsid environment)
 *   "strict"  — only whitelist + CTI_* + ANTHROPIC_* / OPENAI_* / CODEX_* from config.env
 */
export function buildSubprocessEnv(): Record<string, string> {
  const mode = process.env.CTI_ENV_ISOLATION || 'inherit';
  const out: Record<string, string> = {};

  if (mode === 'inherit') {
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_ALWAYS_STRIP.includes(k)) continue;
      out[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (ENV_WHITELIST.has(k)) { out[k] = v; continue; }
      if (k.startsWith('CTI_')) { out[k] = v; continue; }
    }
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (k.startsWith('ANTHROPIC_') || k.startsWith('OPENAI_') || k.startsWith('CODEX_')) {
        out[k] = v;
      }
    }
  }

  return out;
}

/** Minimum major version of Claude CLI required by the SDK. */
const MIN_CLI_MAJOR = 2;

/**
 * Parse a version string like "2.3.1" or "claude 2.3.1" into a major number.
 * Returns undefined if parsing fails.
 */
export function parseCliMajorVersion(versionOutput: string): number | undefined {
  const m = versionOutput.match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

export function buildCliExecCommand(cliPath: string, args: string[]): string {
  const quotedArgs = args.map(arg => `"${arg}"`).join(' ');
  if (/\.[cm]?js$/i.test(cliPath)) {
    return `"${process.execPath}" "${cliPath}"${quotedArgs ? ` ${quotedArgs}` : ''}`;
  }
  return `"${cliPath}"${quotedArgs ? ` ${quotedArgs}` : ''}`;
}

function getCliVersion(cliPath: string, env?: Record<string, string>): string | undefined {
  try {
    return execSync(buildCliExecCommand(cliPath, ['--version']), {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

const REQUIRED_CLI_FLAGS = ['output-format', 'input-format', 'permission-mode', 'setting-sources'];

function checkRequiredFlags(cliPath: string, env?: Record<string, string>): string[] {
  let helpText: string;
  try {
    helpText = execSync(buildCliExecCommand(cliPath, ['--help']), {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  return REQUIRED_CLI_FLAGS.filter(flag => !helpText.includes(flag));
}

export function checkCliCompatibility(cliPath: string, env?: Record<string, string>): {
  compatible: boolean;
  version: string;
  major: number | undefined;
  missingFlags?: string[];
} | undefined {
  const version = getCliVersion(cliPath, env);
  if (!version) return undefined;
  const major = parseCliMajorVersion(version);
  if (major === undefined || major < MIN_CLI_MAJOR) {
    return { compatible: false, version, major };
  }
  const missing = checkRequiredFlags(cliPath, env);
  return {
    compatible: missing.length === 0,
    version,
    major,
    missingFlags: missing.length > 0 ? missing : undefined,
  };
}

export function preflightCheck(cliPath: string): { ok: boolean; version?: string; error?: string } {
  const cleanEnv = buildSubprocessEnv();
  const compat = checkCliCompatibility(cliPath, cleanEnv);
  if (!compat) {
    return { ok: false, error: `claude CLI at "${cliPath}" failed to execute` };
  }
  if (compat.major !== undefined && compat.major < MIN_CLI_MAJOR) {
    /* node:coverage ignore next 5 */
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI version ${compat.version} is too old (need >= ${MIN_CLI_MAJOR}.x). ` +
        `This is likely an npm-installed 1.x CLI. Install the native CLI: https://docs.anthropic.com/en/docs/claude-code`,
    };
  }
  if (compat.missingFlags) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI ${compat.version} is missing required flags: ${compat.missingFlags.join(', ')}. ` +
        `Update the CLI: npm update -g @anthropic-ai/claude-code`,
    };
  }
  return { ok: true, version: compat.version };
}

/* node:coverage disable */
export function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
/* node:coverage enable */

export function resolveWindowsNpmClaudeCliShim(
  cliPath: string,
  pathExists: (path: string) => boolean = fs.existsSync,
): string {
  const normalized = cliPath.replace(/\\/g, '/');
  if (!/\/npm\/claude(\.cmd)?$/i.test(normalized)) {
    return cliPath;
  }
  const cliJs = normalized
    .replace(/\/claude(\.cmd)?$/i, '/node_modules/@anthropic-ai/claude-code/cli.js')
    .replace(/\//g, '\\');
  return pathExists(cliJs) ? cliJs : cliPath;
}

export function parseWindowsWhereClaudeOutput(
  output: string,
  pathExists: (path: string) => boolean = fs.existsSync,
): string[] {
  return output
    .trim()
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(candidate => resolveWindowsNpmClaudeCliShim(candidate, pathExists));
}

function findAllInPath(): string[] {
  /* node:coverage disable */
  if (process.platform === 'win32') {
    try {
      return parseWindowsWhereClaudeOutput(
        execSync('where claude', { encoding: 'utf-8', timeout: 3000 }),
      );
    } catch {
      return [];
    }
  }
  /* node:coverage enable */
  try {
    return execSync('which -a claude', { encoding: 'utf-8', timeout: 3000 })
      .trim()
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function resolveClaudeCliPath(config?: Pick<Config, 'claudeCliExecutable'>): string | undefined {
  const configuredPath = config?.claudeCliExecutable?.trim();
  if (configuredPath) {
    if (process.platform === 'win32') {
      return resolveWindowsNpmClaudeCliShim(configuredPath);
    }
    return configuredPath;
  }

  const isWindows = process.platform === 'win32';
  const pathCandidates = findAllInPath();
  const wellKnown = isWindows
    ? [
        process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\claude\\claude.exe` : '',
        'C:\\Program Files\\claude\\claude.exe',
      ].filter(Boolean)
    : [
        `${process.env.HOME}/.claude/local/claude`,
        `${process.env.HOME}/.local/bin/claude`,
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        `${process.env.HOME}/.npm-global/bin/claude`,
      ];

  const seen = new Set<string>();
  const allCandidates: string[] = [];
  for (const candidate of [...pathCandidates, ...wellKnown]) {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      allCandidates.push(candidate);
    }
  }

  let firstUnverifiable: string | undefined;
  for (const candidate of allCandidates) {
    if (!isExecutable(candidate)) continue;

    const compat = checkCliCompatibility(candidate);
    if (compat?.compatible) {
      if (candidate !== pathCandidates[0] && pathCandidates.length > 0) {
        console.log(
          `[llm-provider] Skipping incompatible CLI at "${pathCandidates[0]}", using "${candidate}" (${compat.version})`,
        );
      }
      return candidate;
    }
    if (compat) {
      console.warn(
        `[llm-provider] CLI at "${candidate}" is version ${compat.version} (need >= ${MIN_CLI_MAJOR}.x), skipping`,
      );
    } else if (!firstUnverifiable) {
      firstUnverifiable = candidate;
    }
  }

  return firstUnverifiable;
}
