import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { maskSecret, configToSettings, type Config } from '../config/config.js';

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
    feishu: {
      id: 'default',
    },
  };

  it('always enables remote bridge and feishu channel', () => {
    const settings = configToSettings(base);
    assert.equal(settings.get('remote_bridge_enabled'), 'true');
    assert.equal(settings.get('bridge_feishu_enabled'), 'true');
  });

  it('maps feishu credentials and allowlist', () => {
    const settings = configToSettings({
      ...base,
      feishu: {
        id: 'default',
        appId: 'app-id',
        appSecret: 'app-secret',
        domain: 'lark',
        allowedUsers: ['ou_1', 'ou_2'],
      },
    });
    assert.equal(settings.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(settings.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(settings.get('bridge_feishu_domain'), 'lark');
    assert.equal(settings.get('bridge_feishu_allowed_users'), 'ou_1,ou_2');
  });

  it('maps direct feishu bot settings without profile fan-out', () => {
    const settings = configToSettings({
      ...base,
      feishu: {
        id: 'default',
        appId: 'main-app',
        appSecret: 'main-secret',
      },
    });
    assert.equal(settings.get('bridge_feishu_app_id'), 'main-app');
    assert.equal(settings.get('bridge_feishu_app_secret'), 'main-secret');
    assert.equal(settings.has('bridge_feishu_profile_ids'), false);
    assert.equal(settings.has('bridge_runtime_claude_feishu_profile'), false);
    assert.equal(settings.has('bridge_runtime_codex_feishu_profile'), false);
  });

  it('maps default workdir', () => {
    const settings = configToSettings(base);
    assert.equal(settings.get('bridge_default_work_dir'), '/tmp/test');
    assert.equal(settings.has('bridge_default_mode'), false);
    assert.equal(settings.has('bridge_default_runtime'), false);
    assert.equal(settings.has('bridge_default_model'), false);
    assert.equal(settings.has('bridge_claude_default_model'), false);
    assert.equal(settings.has('bridge_codex_default_model'), false);
  });
});
