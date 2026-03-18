import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { maskSecret, configToSettings, type Config } from '../config.js';

describe('maskSecret', () => {
  it('masks short values entirely', () => {
    assert.equal(maskSecret('abc'), '****');
    assert.equal(maskSecret('abcd'), '****');
    assert.equal(maskSecret(''), '****');
  });

  it('preserves last 4 chars for longer values', () => {
    assert.equal(maskSecret('12345678'), '****5678');
    assert.equal(maskSecret('secret-token-abcd'), '*************abcd');
  });
});

describe('configToSettings', () => {
  const base: Config = {
    defaultWorkDir: '/tmp/test',
    defaultMode: 'code',
  };

  it('always enables remote bridge and feishu channel', () => {
    const settings = configToSettings(base);
    assert.equal(settings.get('remote_bridge_enabled'), 'true');
    assert.equal(settings.get('bridge_feishu_enabled'), 'true');
  });

  it('maps feishu credentials and allowlist', () => {
    const settings = configToSettings({
      ...base,
      feishuAppId: 'app-id',
      feishuAppSecret: 'app-secret',
      feishuDomain: 'lark',
      feishuAllowedUsers: ['ou_1', 'ou_2'],
    });
    assert.equal(settings.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(settings.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(settings.get('bridge_feishu_domain'), 'lark');
    assert.equal(settings.get('bridge_feishu_allowed_users'), 'ou_1,ou_2');
  });

  it('maps default workdir and mode', () => {
    const settings = configToSettings(base);
    assert.equal(settings.get('bridge_default_work_dir'), '/tmp/test');
    assert.equal(settings.get('bridge_default_mode'), 'code');
    assert.equal(settings.get('bridge_default_runtime'), 'claude');
  });

  it('maps per-runtime default models', () => {
    const settings = configToSettings({
      ...base,
      claudeDefaultModel: 'claude-sonnet-4-6',
      codexDefaultModel: 'gpt-5-codex',
    });
    assert.equal(settings.get('bridge_default_model'), 'claude-sonnet-4-6');
    assert.equal(settings.get('default_model'), 'claude-sonnet-4-6');
    assert.equal(settings.get('bridge_claude_default_model'), 'claude-sonnet-4-6');
    assert.equal(settings.get('bridge_codex_default_model'), 'gpt-5-codex');
  });

  it('preserves legacy runtime for session migration', () => {
    const settings = configToSettings({
      ...base,
      legacyRuntime: 'codex',
    });
    assert.equal(settings.get('bridge_default_runtime'), 'codex');
  });
});
