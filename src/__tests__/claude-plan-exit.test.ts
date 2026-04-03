import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudePlanExitCard,
  buildHandledClaudePlanExitCard,
} from '../runtime/claude-plan-exit.js';

describe('claude-plan-exit cards', () => {
  it('shows a timeout hint only while the plan-exit confirmation is pending', () => {
    const pendingCard = buildClaudePlanExitCard(
      'wf-1',
      '# Plan\n\n1. Create the page',
      [{ tool: 'Bash', prompt: 'Open the generated file in a browser' }],
      true,
    ) as any;
    const handledCard = buildHandledClaudePlanExitCard(
      '# Plan\n\n1. Create the page',
      [{ tool: 'Bash', prompt: 'Open the generated file in a browser' }],
      true,
      'approve',
      'manual',
    ) as any;

    const pendingTimeout = pendingCard.body.elements.find((element: any) =>
      typeof element?.content === 'string' && element.content.includes('超时提示'));
    const handledTimeout = handledCard.body.elements.find((element: any) =>
      typeof element?.content === 'string' && element.content.includes('超时提示'));

    assert.ok(pendingTimeout);
    assert.match(pendingTimeout.content, /StatusFlashOfInspiration/);
    assert.match(pendingTimeout.content, /<font color=orange>/);
    assert.match(pendingTimeout.content, /15 分钟/);
    assert.match(pendingTimeout.content, /自动拒绝/);
    assert.equal(handledTimeout, undefined);
  });
});
