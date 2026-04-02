import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');

describe('package metadata', () => {
  it('exposes a built CLI bin and npm publish metadata', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      bin?: Record<string, string>;
      files?: string[];
      publishConfig?: Record<string, string>;
      scripts?: Record<string, string>;
      version?: string;
    };

    assert.match(packageJson.version || '', /^0\.0\.1-beta(?:\.\d+)?$/);
    assert.equal(packageJson.bin?.['agents-to-im'], 'dist/cli-bin.mjs');
    assert.deepEqual(packageJson.files, [
      'dist',
      'scripts/daemon.sh',
      'scripts/daemon.ps1',
      'scripts/doctor.sh',
      'scripts/supervisor-linux.sh',
      'scripts/supervisor-macos.sh',
      'scripts/supervisor-windows.ps1',
      'config.env.example',
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
    ]);
    assert.deepEqual(packageJson.publishConfig, {
      access: 'public',
      registry: 'https://registry.npmjs.org/',
      tag: 'beta',
    });
    assert.equal(packageJson.scripts?.prepare, 'npm run build:all');
  });
});
