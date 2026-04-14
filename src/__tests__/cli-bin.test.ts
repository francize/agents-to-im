import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

describe('CLI bin entrypoint', () => {
  it('executes help output through dist/cli-bin.mjs', () => {
    const build = spawnSync('node', ['scripts/build-cli.js'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const result = spawnSync('node', ['dist/cli-bin.mjs', 'help'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Usage: agents-to-im \[command\]/);
    assert.match(result.stdout, /Commands:/);
  });

  it('keeps dist/cli.mjs executable as a compatibility wrapper', () => {
    const build = spawnSync('node', ['scripts/build-cli.js'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const result = spawnSync('node', ['dist/cli.mjs', 'help'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Usage: agents-to-im \[command\]/);
    assert.match(result.stdout, /Commands:/);
  });
});
