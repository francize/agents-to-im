import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CONFIG_PATH,
  CTI_HOME,
  configToSettings,
  loadConfig,
  maskSecret,
  saveConfig,
  type Config,
} from '../config/config.js';

const base: Config = {
  defaultWorkDir: '/tmp/test',
  feishu: {
    id: 'default',
  },
};

beforeEach(() => {
  fs.rmSync(CTI_HOME, { recursive: true, force: true });
});

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

describe('loadConfig/saveConfig', () => {
  it('round-trips claudeCliExecutable when configured', () => {
    saveConfig({
      ...base,
      claudeCliExecutable: 'C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd',
    });

    const loaded = loadConfig();
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');

    assert.equal(loaded.claudeCliExecutable, 'C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd');
    assert.match(content, /CTI_CLAUDE_CODE_EXECUTABLE=C:\\Users\\fres\\AppData\\Roaming\\npm\\claude\.cmd/);
  });

  it('omits claudeCliExecutable when unset', () => {
    saveConfig(base);

    const loaded = loadConfig();
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');

    assert.equal(loaded.claudeCliExecutable, undefined);
    assert.doesNotMatch(content, /CTI_CLAUDE_CODE_EXECUTABLE=/);
  });

  it('parses quoted values, lark domain, and allowlists from config.env', () => {
    fs.mkdirSync(CTI_HOME, { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      [
        '# comment',
        'CTI_DEFAULT_WORKDIR="/tmp/workspace"',
        "CTI_FEISHU_APP_ID='cli_app'",
        'CTI_FEISHU_APP_SECRET=secret',
        'CTI_FEISHU_DOMAIN=lark',
        'CTI_FEISHU_ALLOWED_USERS=ou_1, ou_2',
        'CTI_CLAUDE_CODE_EXECUTABLE="C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd"',
      ].join('\n'),
    );

    const loaded = loadConfig();

    assert.equal(loaded.defaultWorkDir, '/tmp/workspace');
    assert.equal(loaded.feishu.appId, 'cli_app');
    assert.equal(loaded.feishu.appSecret, 'secret');
    assert.equal(loaded.feishu.domain, 'lark');
    assert.deepEqual(loaded.feishu.allowedUsers, ['ou_1', 'ou_2']);
    assert.equal(loaded.claudeCliExecutable, 'C:\\Users\\fres\\AppData\\Roaming\\npm\\claude.cmd');
  });
});
