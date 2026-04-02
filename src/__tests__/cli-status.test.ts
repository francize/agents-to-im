import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseLaunchdPid } from '../cli.js';

describe('CLI status helpers', () => {
  it('parses a live launchd pid from launchctl print output', () => {
    const output = `
gui/501/com.agents-to-im.bridge = {
  state = running
  pid = 45601
}
`;
    assert.equal(parseLaunchdPid(output), '45601');
  });

  it('ignores empty or zero launchd pid values', () => {
    assert.equal(parseLaunchdPid('pid = 0\n'), '');
    assert.equal(parseLaunchdPid('pid = -\n'), '');
    assert.equal(parseLaunchdPid('state = waiting\n'), '');
  });
});
