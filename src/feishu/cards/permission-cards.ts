import * as lark from '@larksuiteoapi/node-sdk';

import type { OutboundMessage } from '../../bridge/types.js';

export function buildSimpleCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

export function buildStatusCard(
  title: string,
  text: string,
  template: NonNullable<lark.InteractiveCard['header']>['template'] = 'grey',
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
      ],
    },
  };
}

export function buildHandledPermissionCard(action: string): Record<string, unknown> {
  switch (action) {
    case 'allow':
      return buildStatusCard('授权已处理', '已处理：本次允许。\n\n该授权请求已关闭。', 'green');
    case 'allow_session':
      return buildStatusCard('授权已处理', '已处理：本会话允许。\n\n后续同会话内匹配的请求将自动放行。', 'green');
    case 'deny':
      return buildStatusCard('授权已处理', '已处理：拒绝。\n\n该授权请求已关闭。', 'red');
    default:
      return buildStatusCard('授权已处理', '该授权请求已处理。', 'grey');
  }
}

export function buildHandledPlanCard(action: string): Record<string, unknown> {
  switch (action) {
    case 'execute':
      return buildStatusCard('计划已确认', '已处理：开始执行已确认计划。\n\n该确认卡已关闭。', 'green');
    case 'continue':
      return buildStatusCard('继续保持 PLAN', '已处理：继续保持 PLAN 模式。\n\n请直接在本线程回复需要调整的地方。', 'blue');
    case 'cancel':
      return buildStatusCard('计划已取消', '已处理：已取消 PLAN 流程。', 'red');
    default:
      return buildStatusCard('计划已处理', '该计划确认卡已处理。', 'grey');
  }
}

export function buildActionCard(
  title: string,
  text: string,
  buttons: NonNullable<OutboundMessage['inlineButtons']>,
  template: NonNullable<lark.InteractiveCard['header']>['template'] = 'orange',
): Record<string, unknown> {
  const actionColumns = buttons.flat().map((button) => {
    const lower = button.text.toLowerCase();
    const type: 'default' | 'danger' | 'primary' =
      lower.includes('deny') ? 'danger' : lower.includes('allow') ? 'primary' : 'default';
    return {
      tag: 'column' as const,
      width: 'auto' as const,
      elements: [
        {
          tag: 'button' as const,
          text: {
            tag: 'plain_text' as const,
            content: button.text,
          },
          type,
          behaviors: [
            {
              type: 'callback' as const,
              value: {
                callback_data: button.callbackData,
              },
            },
          ],
        },
      ],
    };
  });
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          horizontal_align: 'left',
          columns: actionColumns,
        },
      ],
    },
  };
}

export function buildPermissionCard(
  text: string,
  buttons: NonNullable<OutboundMessage['inlineButtons']>,
): Record<string, unknown> {
  return buildActionCard('Permission Required', text, buttons, 'orange');
}
