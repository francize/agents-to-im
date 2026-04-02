import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildBannerLines, getDisplayWidth } from '../cli.js';

describe('CLI banner', () => {
  it('keeps every banner row at the same display width', () => {
    const lines = buildBannerLines().filter(Boolean);
    const widths = lines.map((line) => getDisplayWidth(line));

    assert.equal(lines.length, 4);
    assert.deepEqual(widths, [widths[0], widths[0], widths[0], widths[0]]);
  });
});
