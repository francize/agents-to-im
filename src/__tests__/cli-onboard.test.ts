import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlatformAuthUrl,
  buildPlatformBotUrl,
  buildPlatformEventUrl,
  buildPlatformSetupChecklist,
  detectDefaultOnboardLocale,
} from '../cli.js';
import { FEISHU_SCOPES_IMPORT_JSON } from '../feishu-scopes.js';

describe('CLI onboarding checklist', () => {
  it('includes scopes, publish, and long-connection guidance for a fresh Feishu install', () => {
    const checklist = buildPlatformSetupChecklist('', 'start', 'cli_test_app');

    assert.equal(checklist[0], 'Open Feishu auth page: https://open.feishu.cn/app/cli_test_app/auth');
    assert.ok(checklist.some((item) => item.includes('Import the full scopes JSON')));
    assert.ok(checklist.some((item) => item.includes('Publish one app version')));
    assert.ok(checklist.some((item) => item.includes('Start the bridge before saving Long Connection events')));
    assert.ok(checklist.some((item) => item.includes('Add event: im.message.receive_v1')));
    assert.ok(checklist.some((item) => item.includes('Add event: im.message.message_read_v1')));
    assert.ok(checklist.some((item) => item.includes('Add event: im.chat.updated_v1')));
    assert.ok(checklist.some((item) => item.includes('Add event: im.chat.member.bot.added_v1')));
    assert.ok(checklist.some((item) => item.includes('Open Events page: https://open.feishu.cn/app/cli_test_app/event?tab=event')));
    assert.ok(checklist.some((item) => item.includes('Open Callback page: https://open.feishu.cn/app/cli_test_app/event?tab=callback')));
    assert.ok(checklist.some((item) => item.includes('Add callback: card.action.trigger')));
    assert.ok(checklist.some((item) => item.includes('Optional: open Bot menu page: https://open.feishu.cn/app/cli_test_app/bot')));
    assert.ok(checklist.some((item) => item.includes('Add floating menu shortcuts: /new:claude and /new:codex')));
    assert.equal(checklist.at(-1), 'Publish again if you changed the Bot menu');
  });

  it('switches the platform URL and restart wording for Lark with a running bridge', () => {
    const checklist = buildPlatformSetupChecklist('lark', 'restart', 'cli_test_lark');

    assert.equal(checklist[0], 'Open Lark auth page: https://open.larksuite.com/app/cli_test_lark/auth');
    assert.ok(checklist.some((item) => item.includes('Restart the bridge before saving Long Connection events')));
  });

  it('builds the dynamic auth page URL from the app id', () => {
    assert.equal(buildPlatformAuthUrl('', 'cli_a903872cdbf95cd9'), 'https://open.feishu.cn/app/cli_a903872cdbf95cd9/auth');
    assert.equal(buildPlatformAuthUrl('lark', 'cli_lark_123'), 'https://open.larksuite.com/app/cli_lark_123/auth');
    assert.equal(buildPlatformEventUrl('', 'cli_a903872cdbf95cd9', 'event'), 'https://open.feishu.cn/app/cli_a903872cdbf95cd9/event?tab=event');
    assert.equal(buildPlatformEventUrl('', 'cli_a903872cdbf95cd9', 'callback'), 'https://open.feishu.cn/app/cli_a903872cdbf95cd9/event?tab=callback');
    assert.equal(buildPlatformBotUrl('', 'cli_a903872cdbf95cd9'), 'https://open.feishu.cn/app/cli_a903872cdbf95cd9/bot');
  });

  it('defaults onboarding language from locale env', () => {
    assert.equal(detectDefaultOnboardLocale({ LANG: 'zh_CN.UTF-8' } as NodeJS.ProcessEnv), 'zh');
    assert.equal(detectDefaultOnboardLocale({ LC_ALL: 'en_US.UTF-8' } as NodeJS.ProcessEnv), 'en');
  });

  it('ships a parseable scopes import payload for clipboard copy', () => {
    const parsed = JSON.parse(FEISHU_SCOPES_IMPORT_JSON) as {
      scopes?: { tenant?: string[]; user?: string[] };
    };
    assert.ok((parsed.scopes?.tenant?.length || 0) > 10);
    assert.ok((parsed.scopes?.user?.length || 0) > 10);
    assert.ok(parsed.scopes?.tenant?.includes('cardkit:card:write'));
    assert.ok(parsed.scopes?.tenant?.includes('im:message:update'));
  });
});
