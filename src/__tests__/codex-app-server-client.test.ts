import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInitializeParams,
  buildInitializedNotification,
  extractCollaborationModes,
} from '../providers/codex/app-server-client.js';

describe('Codex app-server handshake helpers', () => {
  it('builds initialize params with required clientInfo', () => {
    assert.deepEqual(buildInitializeParams(), {
      clientInfo: {
        name: 'agents-to-im',
        title: 'Agents to IM',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });

  it('builds initialized notification', () => {
    assert.deepEqual(buildInitializedNotification(), {
      jsonrpc: '2.0',
      method: 'initialized',
    });
  });

  it('extracts collaboration modes from the real app-server data envelope', () => {
    assert.deepEqual(
      extractCollaborationModes({
        data: [
          { name: 'Plan', mode: 'plan', model: null },
          { name: 'Default', mode: 'default', model: null },
        ],
      }),
      [
        { name: 'Plan', mode: 'plan', model: null },
        { name: 'Default', mode: 'default', model: null },
      ],
    );
  });
});
