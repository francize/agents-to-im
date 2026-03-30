import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  extractClaudeModeOptionsFromCliSource,
  resolveClaudeModeMetadata,
  SNAPSHOT_CLAUDE_MODE_OPTIONS,
} from '../runtime/claude-mode.js';

describe('claude-mode metadata', () => {
  it('extracts permission mode titles from the installed Claude SDK CLI bundle', () => {
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const cliSource = fs.readFileSync(path.join(path.dirname(sdkEntry), 'cli.js'), 'utf8');

    const options = extractClaudeModeOptionsFromCliSource(cliSource);

    assert.deepEqual(options, [
      { mode: 'default', title: 'Default' },
      { mode: 'plan', title: 'Plan Mode' },
      { mode: 'acceptEdits', title: 'Accept edits' },
      { mode: 'bypassPermissions', title: 'Bypass Permissions' },
      { mode: 'dontAsk', title: "Don't Ask" },
    ]);
  });

  it('falls back to snapshot metadata and warns when SDK parsing fails', () => {
    const warnings: string[] = [];

    const metadata = resolveClaudeModeMetadata({
      cliSource: 'not-a-valid-cli-bundle',
      packageVersion: '0.2.81',
      warn: (message) => warnings.push(message),
    });

    assert.equal(metadata.source, 'snapshot');
    assert.equal(metadata.packageVersion, '0.2.81');
    assert.deepEqual(metadata.options, SNAPSHOT_CLAUDE_MODE_OPTIONS);
    assert.match(warnings[0] || '', /falling back to snapshot titles/i);
  });
});
