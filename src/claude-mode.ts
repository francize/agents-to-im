import fs from 'node:fs';
import path from 'node:path';
import { createRequire as nodeCreateRequire } from 'node:module';

export type ClaudePermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk';

export interface ClaudeModeOption {
  mode: ClaudePermissionMode;
  title: string;
}

export interface ClaudeModeMetadata {
  options: ClaudeModeOption[];
  packageVersion?: string;
  source: 'sdk' | 'snapshot';
}

export const SNAPSHOT_CLAUDE_MODE_OPTIONS: ClaudeModeOption[] = [
  { mode: 'default', title: 'Default' },
  { mode: 'plan', title: 'Plan Mode' },
  { mode: 'acceptEdits', title: 'Accept edits' },
  { mode: 'bypassPermissions', title: 'Bypass Permissions' },
  { mode: 'dontAsk', title: "Don't Ask" },
];

const KNOWN_MODES = new Set<ClaudePermissionMode>(
  SNAPSHOT_CLAUDE_MODE_OPTIONS.map((option) => option.mode),
);

let cachedMetadata: ClaudeModeMetadata | null = null;

function isClaudePermissionMode(value: string): value is ClaudePermissionMode {
  return KNOWN_MODES.has(value as ClaudePermissionMode);
}

function readInstalledClaudeSdkFiles(): { cliSource: string; packageVersion?: string } | null {
  try {
    const require = nodeCreateRequire(import.meta.url);
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const sdkRoot = path.dirname(sdkEntry);
    const cliSource = fs.readFileSync(path.join(sdkRoot, 'cli.js'), 'utf8');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8'),
    ) as { version?: string };
    return {
      cliSource,
      packageVersion: packageJson.version,
    };
  } catch {
    return null;
  }
}

export function extractClaudeModeOptionsFromCliSource(cliSource: string): ClaudeModeOption[] | null {
  const metadataIndex = cliSource.indexOf('dPA={');
  if (metadataIndex === -1) return null;
  const metadataSource = cliSource.slice(metadataIndex);
  const matches = [
    ...metadataSource.matchAll(
      /(default|plan|acceptEdits|bypassPermissions|dontAsk):\{title:"([^"]+)"/g,
    ),
  ];
  if (matches.length !== SNAPSHOT_CLAUDE_MODE_OPTIONS.length) {
    return null;
  }
  const seen = new Set<string>();
  const options: ClaudeModeOption[] = [];
  for (const match of matches) {
    const mode = match[1];
    const title = match[2];
    if (!mode || !title || !isClaudePermissionMode(mode) || seen.has(mode)) {
      return null;
    }
    seen.add(mode);
    options.push({ mode, title });
  }
  return options.length === SNAPSHOT_CLAUDE_MODE_OPTIONS.length ? options : null;
}

export function resolveClaudeModeMetadata(options?: {
  cliSource?: string;
  packageVersion?: string;
  warn?: (message: string) => void;
}): ClaudeModeMetadata {
  const warn = options?.warn || ((message: string) => console.warn(message));
  let cliSource = options?.cliSource;
  let packageVersion = options?.packageVersion;

  if (!cliSource) {
    const installed = readInstalledClaudeSdkFiles();
    cliSource = installed?.cliSource;
    packageVersion = packageVersion || installed?.packageVersion;
  }

  if (cliSource) {
    const extracted = extractClaudeModeOptionsFromCliSource(cliSource);
    if (extracted) {
      return {
        options: extracted,
        packageVersion,
        source: 'sdk',
      };
    }
  }

  warn(
    `[claude-mode] Failed to parse Claude permission mode metadata${
      packageVersion ? ` from @anthropic-ai/claude-agent-sdk@${packageVersion}` : ''
    }; falling back to snapshot titles.`,
  );
  return {
    options: [...SNAPSHOT_CLAUDE_MODE_OPTIONS],
    packageVersion,
    source: 'snapshot',
  };
}

export function getClaudeModeMetadata(): ClaudeModeMetadata {
  if (!cachedMetadata) {
    cachedMetadata = resolveClaudeModeMetadata();
  }
  return cachedMetadata;
}

export function getClaudeModeOptions(): ClaudeModeOption[] {
  return [...getClaudeModeMetadata().options];
}

export function normalizeClaudePermissionMode(
  value: string | null | undefined,
): ClaudePermissionMode | undefined {
  if (!value) return undefined;
  return isClaudePermissionMode(value) ? value : undefined;
}

export function getClaudeModeTitle(
  mode: ClaudePermissionMode | null | undefined,
): string {
  const resolvedMode = mode || 'default';
  return getClaudeModeMetadata().options.find((option) => option.mode === resolvedMode)?.title
    || SNAPSHOT_CLAUDE_MODE_OPTIONS.find((option) => option.mode === resolvedMode)?.title
    || 'Default';
}

export function getClaudeModeSuffix(
  mode: ClaudePermissionMode | null | undefined,
): string {
  if (!mode || mode === 'default') return '';
  return ` [${getClaudeModeTitle(mode)}]`;
}
