import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');

describe('package metadata', () => {
  it('exposes a built CLI bin and prepares dist for git-based npx installs', () => {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    assert.equal(packageJson.bin?.['agents-to-im'], 'dist/cli-bin.mjs');
    assert.equal(packageJson.scripts?.prepare, 'npm run build:all');
  });
});
