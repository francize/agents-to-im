import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_UPGRADE_PACKAGE_SPEC = 'agents-to-im@beta';

export interface UpgradeStep {
  command: string;
  args: string[];
  cwd?: string;
  description: string;
}

export interface UpgradePlan {
  mode: 'source' | 'npm';
  packageRoot: string;
  currentVersion: string;
  restartBridge: boolean;
  steps: UpgradeStep[];
}

export type UpgradePlanResult =
  | { ok: true; plan: UpgradePlan }
  | { ok: false; reason: string };

interface PackageManifest {
  name?: string;
  version?: string;
}

export function hasDirtyGitWorktree(statusOutput: string): boolean {
  return statusOutput
    .split(/\r?\n/)
    .some((line) => line.trim().length > 0);
}

export function findAgentsToImPackageRoot(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PackageManifest;
        if (pkg.name === 'agents-to-im') {
          return current;
        }
      } catch {
        // Ignore unreadable package manifests while walking upward.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function readAgentsToImVersion(packageRoot: string): string {
  const pkgPath = path.join(packageRoot, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as PackageManifest;
    return typeof pkg.version === 'string' && pkg.version.trim()
      ? pkg.version.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function buildUpgradePlan(options: {
  packageRoot: string;
  currentVersion: string;
  isSourceCheckout: boolean;
  bridgeRunning: boolean;
  gitStatusOutput?: string;
  packageSpec?: string;
}): UpgradePlanResult {
  const packageSpec = options.packageSpec || DEFAULT_UPGRADE_PACKAGE_SPEC;

  if (options.isSourceCheckout) {
    if (hasDirtyGitWorktree(options.gitStatusOutput || '')) {
      return {
        ok: false,
        reason: 'Source checkout has uncommitted changes. Commit or stash them before running upgrade.',
      };
    }

    return {
      ok: true,
      plan: {
        mode: 'source',
        packageRoot: options.packageRoot,
        currentVersion: options.currentVersion,
        restartBridge: options.bridgeRunning,
        steps: [
          {
            command: 'git',
            args: ['pull', '--ff-only'],
            cwd: options.packageRoot,
            description: 'Pull latest source',
          },
          {
            command: 'npm',
            args: ['install'],
            cwd: options.packageRoot,
            description: 'Sync dependencies',
          },
          {
            command: 'npm',
            args: ['run', 'build:all'],
            cwd: options.packageRoot,
            description: 'Rebuild CLI and daemon',
          },
        ],
      },
    };
  }

  return {
    ok: true,
    plan: {
      mode: 'npm',
      packageRoot: options.packageRoot,
      currentVersion: options.currentVersion,
      restartBridge: options.bridgeRunning,
      steps: [
        {
          command: 'npm',
          args: ['install', '-g', packageSpec],
          description: options.bridgeRunning
            ? 'Install latest npm package globally before restarting bridge'
            : 'Install latest npm package globally',
        },
      ],
    },
  };
}
