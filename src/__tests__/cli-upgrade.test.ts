import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildUpgradePlan,
  findAgentsToImPackageRoot,
  hasDirtyGitWorktree,
  readAgentsToImVersion,
} from '../cli-upgrade.js';

describe('CLI upgrade helpers', () => {
  it('treats git porcelain output as dirty only when it contains entries', () => {
    assert.equal(hasDirtyGitWorktree(''), false);
    assert.equal(hasDirtyGitWorktree('\n\n'), false);
    assert.equal(hasDirtyGitWorktree(' M src/cli.ts\n'), true);
  });

  it('finds the nearest agents-to-im package root', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-cli-upgrade-'));
    const packageRoot = path.join(tmpRoot, 'repo');
    const nested = path.join(packageRoot, 'dist', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'agents-to-im', version: '0.1.0' }),
    );

    assert.equal(findAgentsToImPackageRoot(nested), packageRoot);
    assert.equal(readAgentsToImVersion(packageRoot), '0.1.0');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('builds a source checkout upgrade plan that rebuilds and restarts', () => {
    const result = buildUpgradePlan({
      packageRoot: '/tmp/agents-to-im',
      currentVersion: '0.1.0',
      isSourceCheckout: true,
      bridgeRunning: true,
      gitStatusOutput: '',
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.plan, {
      mode: 'source',
      packageRoot: '/tmp/agents-to-im',
      currentVersion: '0.1.0',
      restartBridge: true,
      steps: [
        {
          command: 'git',
          args: ['pull', '--ff-only'],
          cwd: '/tmp/agents-to-im',
          description: 'Pull latest source',
        },
        {
          command: 'npm',
          args: ['install'],
          cwd: '/tmp/agents-to-im',
          description: 'Sync dependencies',
        },
        {
          command: 'npm',
          args: ['run', 'build:all'],
          cwd: '/tmp/agents-to-im',
          description: 'Rebuild CLI and daemon',
        },
      ],
    });
  });

  it('refuses to upgrade a dirty source checkout', () => {
    const result = buildUpgradePlan({
      packageRoot: '/tmp/agents-to-im',
      currentVersion: '0.1.0',
      isSourceCheckout: true,
      bridgeRunning: false,
      gitStatusOutput: ' M src/cli.ts\n',
    });

    assert.deepEqual(result, {
      ok: false,
      reason: 'Source checkout has uncommitted changes. Commit or stash them before running upgrade.',
    });
  });

  it('builds an npx upgrade plan for packaged installs', () => {
    const result = buildUpgradePlan({
      packageRoot: '/opt/homebrew/lib/node_modules/agents-to-im',
      currentVersion: '0.1.0',
      isSourceCheckout: false,
      bridgeRunning: false,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.plan, {
      mode: 'npx',
      packageRoot: '/opt/homebrew/lib/node_modules/agents-to-im',
      currentVersion: '0.1.0',
      restartBridge: false,
      steps: [
        {
          command: 'npx',
          args: ['--yes', 'github:francize/agents-to-im', 'help'],
          description: 'Fetch latest package via npx',
        },
      ],
    });
  });

  it('uses npx restart when a packaged install upgrades a running bridge', () => {
    const result = buildUpgradePlan({
      packageRoot: '/opt/homebrew/lib/node_modules/agents-to-im',
      currentVersion: '0.1.0',
      isSourceCheckout: false,
      bridgeRunning: true,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.plan, {
      mode: 'npx',
      packageRoot: '/opt/homebrew/lib/node_modules/agents-to-im',
      currentVersion: '0.1.0',
      restartBridge: false,
      steps: [
        {
          command: 'npx',
          args: ['--yes', 'github:francize/agents-to-im', 'restart'],
          description: 'Fetch latest package via npx and restart bridge',
        },
      ],
    });
  });
});
