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
    feishuProfiles: [
      {
        id: 'default',
        label: '默认 Bot',
        toolOutputCards: true,
        autoImageSend: true,
      },
    ],
    runtimeFeishuProfiles: {
      claude: 'default',
      codex: 'default',
    },
  };

  it('always enables remote bridge and feishu channel', () => {
    const settings = configToSettings(base);
    assert.equal(settings.get('remote_bridge_enabled'), 'true');
    assert.equal(settings.get('bridge_feishu_enabled'), 'true');
    assert.equal(settings.get('bridge_feishu_tool_output_cards'), 'true');
    assert.equal(settings.get('bridge_feishu_auto_image_send'), 'true');
  });

  it('maps feishu credentials and allowlist', () => {
    const settings = configToSettings({
      ...base,
      feishuProfiles: [
        {
          id: 'default',
          label: '默认 Bot',
          appId: 'app-id',
          appSecret: 'app-secret',
          domain: 'lark',
          allowedUsers: ['ou_1', 'ou_2'],
          toolOutputCards: true,
          autoImageSend: true,
        },
      ],
    });
    assert.equal(settings.get('bridge_feishu_app_id'), 'app-id');
    assert.equal(settings.get('bridge_feishu_app_secret'), 'app-secret');
    assert.equal(settings.get('bridge_feishu_domain'), 'lark');
    assert.equal(settings.get('bridge_feishu_allowed_users'), 'ou_1,ou_2');
  });

  it('maps profile-local settings and runtime bindings for multiple bots', () => {
    const settings = configToSettings({
      ...base,
      feishuProfiles: [
        {
          id: 'default',
          label: 'Claude Bot',
          appId: 'claude-app',
          appSecret: 'claude-secret',
          toolOutputCards: true,
          autoImageSend: true,
        },
        {
          id: 'codex',
          label: 'Codex Bot',
          appId: 'codex-app',
          appSecret: 'codex-secret',
          toolOutputCards: false,
          autoImageSend: false,
        },
      ],
      runtimeFeishuProfiles: {
        claude: 'default',
        codex: 'codex',
      },
    });
    assert.equal(settings.get('bridge_feishu_profile_ids'), 'default,codex');
    assert.equal(settings.get('bridge_runtime_claude_feishu_profile'), 'default');
    assert.equal(settings.get('bridge_runtime_codex_feishu_profile'), 'codex');
    assert.equal(settings.get('bridge_feishu_profile_default_app_id'), 'claude-app');
    assert.equal(settings.get('bridge_feishu_profile_codex_app_id'), 'codex-app');
    assert.equal(settings.get('bridge_feishu_profile_codex_tool_output_cards'), 'false');
    assert.equal(settings.get('bridge_feishu_profile_codex_auto_image_send'), 'false');
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

  it('allows disabling feishu tool output cards explicitly', () => {
    const settings = configToSettings({
      ...base,
      feishuProfiles: [
        {
          ...base.feishuProfiles[0],
          toolOutputCards: false,
        },
      ],
    });
    assert.equal(settings.get('bridge_feishu_tool_output_cards'), 'false');
  });

  it('allows disabling automatic feishu image sends explicitly', () => {
    const settings = configToSettings({
      ...base,
      feishuProfiles: [
        {
          ...base.feishuProfiles[0],
          autoImageSend: false,
        },
      ],
    });
    assert.equal(settings.get('bridge_feishu_auto_image_send'), 'false');
  });
});
