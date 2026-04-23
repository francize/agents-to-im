import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { listRecentWorkspaces } from '../infra/recent-workspaces.js';

describe('listRecentWorkspaces', () => {
  it('deduplicates by normalized path, prepends default workdir when missing, and limits to 5', () => {
    const options = listRecentWorkspaces(
      [
        { workingDirectory: '/tmp/ws-a', updatedAt: '2026-03-28T01:00:00.000Z' },
        { workingDirectory: '/tmp/ws-b', updatedAt: '2026-03-28T03:00:00.000Z' },
        { workingDirectory: '/tmp/ws-a', updatedAt: '2026-03-28T02:00:00.000Z' },
        { workingDirectory: '/tmp/ws-c', updatedAt: '2026-03-28T04:00:00.000Z' },
        { workingDirectory: '/tmp/ws-d', updatedAt: '2026-03-28T05:00:00.000Z' },
        { workingDirectory: '/tmp/ws-e', updatedAt: '2026-03-28T06:00:00.000Z' },
      ],
      '/tmp/default-ws',
      5,
    );

    assert.deepEqual(
      options.map((option) => option.value),
      [
        path.resolve('/tmp/default-ws'),
        path.resolve('/tmp/ws-e'),
        path.resolve('/tmp/ws-d'),
        path.resolve('/tmp/ws-c'),
        path.resolve('/tmp/ws-b'),
      ],
    );
    assert.match(options[0]!.label, /default-ws/);
  });

  it('keeps existing default workdir in chronological position', () => {
    const options = listRecentWorkspaces(
      [
        { workingDirectory: '/tmp/default-ws', updatedAt: '2026-03-28T01:00:00.000Z' },
        { workingDirectory: '/tmp/ws-b', updatedAt: '2026-03-28T02:00:00.000Z' },
      ],
      '/tmp/default-ws',
      5,
    );

    assert.deepEqual(
      options.map((option) => option.value),
      [
        path.resolve('/tmp/ws-b'),
        path.resolve('/tmp/default-ws'),
      ],
    );
  });

  it('merges extra workspace sources alongside bindings and deduplicates by normalized path', () => {
    const options = listRecentWorkspaces(
      [
        { workingDirectory: '/tmp/ws-a', updatedAt: '2026-03-28T01:00:00.000Z' },
      ],
      null,
      5,
      [
        { workingDirectory: '/tmp/ws-a', updatedAt: '2026-03-28T09:00:00.000Z' },
        { workingDirectory: '/tmp/ws-native-only', updatedAt: '2026-03-28T05:00:00.000Z' },
      ],
    );

    assert.deepEqual(
      options.map((option) => option.value),
      [
        path.resolve('/tmp/ws-a'),
        path.resolve('/tmp/ws-native-only'),
      ],
    );
    const merged = options.find((option) => option.value === path.resolve('/tmp/ws-a'));
    assert.equal(merged?.updatedAt, '2026-03-28T09:00:00.000Z');
  });

  it('returns empty list when no bindings, no extra sources, and no default workdir', () => {
    const options = listRecentWorkspaces([], null, 5, []);
    assert.deepEqual(options, []);
  });
});
