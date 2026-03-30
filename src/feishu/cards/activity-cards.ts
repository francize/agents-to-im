import * as lark from '@larksuiteoapi/node-sdk';

import type { ActivityEvent } from '../../bridge/types.js';
import { STREAM_PLACEHOLDER_TEXT } from '../constants.js';

export function ensureRobotPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return STREAM_PLACEHOLDER_TEXT;
  return trimmed.startsWith('🤖') ? trimmed : `🤖 ${trimmed}`;
}

export function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncateActivityOutput(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

export function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`');
}

export function formatActivityStatus(status: 'pending' | 'running' | 'completed' | 'failed'): string {
  switch (status) {
    case 'pending':
      return '等待确认';
    case 'running':
      return '进行中';
    case 'failed':
      return '失败';
    case 'completed':
    default:
      return '已完成';
  }
}

export function buildActivityCardBase(
  elements: Array<Record<string, unknown>>,
  header?: {
    title: string;
    template?: NonNullable<lark.InteractiveCard['header']>['template'];
  },
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
      width_mode: 'fill',
    },
    ...(header
      ? {
          header: {
            title: {
              tag: 'plain_text',
              content: header.title,
            },
            template: header.template || 'grey',
          },
        }
      : {}),
    body: {
      elements,
    },
  };
}

export function getActivityEventId(event: ActivityEvent): string {
  switch (event.kind) {
    case 'reasoning_activity':
      return `reasoning:${event.turnId || event.taskId || event.source || 'current'}`;
    case 'tool_activity':
      return `tool:${event.toolUseId}`;
    default:
      return event.id;
  }
}

export function buildCollapsibleActivityCard(
  title: string,
  summary: string,
  bodyMarkdown: string,
  status: 'pending' | 'running' | 'completed' | 'failed',
): Record<string, unknown> {
  const tone = status === 'failed' ? 'red' : status === 'pending' ? 'orange' : 'grey';
  const panelTitle = summary.trim()
    ? `**${title}** · ${summary.trim()}`
    : `**${title}**`;
  return buildActivityCardBase([
    {
      tag: 'collapsible_panel',
      element_id: `panel_${title.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'activity'}`,
      expanded: false,
      background_color: 'grey',
      padding: '8px 12px 12px 12px',
      vertical_spacing: '8px',
      header: {
        title: {
          tag: 'markdown',
          content: panelTitle,
        },
        background_color: 'grey',
        width: 'fill',
        vertical_align: 'center',
        padding: '10px 12px 10px 12px',
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          size: '16px 16px',
        },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: {
        color: tone,
        corner_radius: '8px',
      },
      elements: [
        {
          tag: 'markdown',
          content: bodyMarkdown,
        },
      ],
    },
  ]);
}

export function buildLightweightActivityCard(
  event: Extract<ActivityEvent, { kind: 'lightweight_activity' }>,
): Record<string, unknown> {
  return buildActivityCardBase([
    {
      tag: 'markdown',
      content: ensureRobotPrefix(event.text),
    },
  ]);
}

export function buildReasoningActivityCard(
  event: Extract<ActivityEvent, { kind: 'reasoning_activity' }>,
): Record<string, unknown> {
  const title = event.source === 'compacting'
    ? '压缩上下文'
    : event.source === 'tool_use_summary'
      ? '步骤总结'
      : '思考过程';
  const lines = [
    `**状态**：${formatActivityStatus(event.status)}`,
    '',
    ensureRobotPrefix(event.text),
  ];
  if (event.taskId) {
    lines.splice(1, 0, `**任务**：\`${escapeInlineCode(event.taskId)}\``);
  }
  return buildActivityCardBase([
    {
      tag: 'markdown',
      content: lines.join('\n'),
    },
  ], {
    title,
    template: event.status === 'failed' ? 'red' : event.status === 'completed' ? 'blue' : 'grey',
  });
}

export function buildCommandExecutionCard(
  event: Extract<ActivityEvent, { kind: 'command_execution' }>,
): Record<string, unknown> {
  const shortCommand = truncateActivityOutput(normalizeSingleLine(event.command), 72);
  const summary = [formatActivityStatus(event.status), shortCommand ? `\`${escapeInlineCode(shortCommand)}\`` : '']
    .filter(Boolean)
    .join(' · ');
  const lines = [
    `**状态**：${formatActivityStatus(event.status)}`,
  ];
  if (event.command.trim()) {
    lines.push(`**命令**：\`${escapeInlineCode(event.command)}\``);
  }
  if (event.cwd?.trim()) {
    lines.push(`**目录**：\`${escapeInlineCode(event.cwd)}\``);
  }
  if (typeof event.exitCode === 'number') {
    lines.push(`**退出码**：${event.exitCode}`);
  }
  if (typeof event.durationMs === 'number' && event.durationMs >= 0) {
    lines.push(`**耗时**：${event.durationMs} ms`);
  }
  const output = truncateActivityOutput(event.output || '');
  if (output) {
    lines.push('', '**输出预览**', '```text', output.replace(/```/g, '``` '), '```');
  }
  return buildCollapsibleActivityCard('执行命令', summary, lines.join('\n'), event.status);
}

export function buildFileChangeCard(
  event: Extract<ActivityEvent, { kind: 'file_change' }>,
): Record<string, unknown> {
  const changedCount = event.changes.length;
  const summary = [
    formatActivityStatus(event.status),
    changedCount > 0 ? `${changedCount} 个文件` : normalizeSingleLine(event.summary || ''),
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [
    `**状态**：${formatActivityStatus(event.status)}`,
  ];
  if (event.summary?.trim()) {
    lines.push(`**摘要**：${normalizeSingleLine(event.summary)}`);
  }
  if (event.changes.length > 0) {
    lines.push('', '**文件**');
    for (const change of event.changes.slice(0, 8)) {
      lines.push(`- \`${change.path.replace(/`/g, '\\`')}\` (${change.kind})`);
    }
    if (event.changes.length > 8) {
      lines.push(`- 另有 ${event.changes.length - 8} 项修改`);
    }
  }
  return buildCollapsibleActivityCard('修改文件', summary, lines.join('\n'), event.status);
}

export function buildToolActivityCard(
  event: Extract<ActivityEvent, { kind: 'tool_activity' }>,
): Record<string, unknown> {
  const shortInput = truncateActivityOutput(normalizeSingleLine(event.inputPreview || ''), 72);
  const shortResult = truncateActivityOutput(normalizeSingleLine(event.resultPreview || ''), 72);
  const summary = [
    formatActivityStatus(event.status),
    shortInput || shortResult,
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [
    `**状态**：${formatActivityStatus(event.status)}`,
    `**工具**：\`${escapeInlineCode(event.toolName)}\``,
  ];
  if (event.taskId?.trim()) {
    lines.push(`**任务**：\`${escapeInlineCode(event.taskId)}\``);
  }
  if (event.parentToolUseId?.trim()) {
    lines.push(`**父工具**：\`${escapeInlineCode(event.parentToolUseId)}\``);
  }
  if (typeof event.elapsedSeconds === 'number' && Number.isFinite(event.elapsedSeconds)) {
    lines.push(`**耗时**：${event.elapsedSeconds.toFixed(1)} s`);
  }
  if (event.inputPreview?.trim()) {
    lines.push('', '**输入预览**', '```text', event.inputPreview.replace(/```/g, '``` '), '```');
  }
  if (event.resultPreview?.trim()) {
    lines.push('', `**${event.status === 'failed' ? '错误预览' : '结果预览'}**`, '```text', event.resultPreview.replace(/```/g, '``` '), '```');
  }
  return buildCollapsibleActivityCard(event.toolName, summary, lines.join('\n'), event.status);
}

export function buildActivityCard(event: ActivityEvent): Record<string, unknown> {
  switch (event.kind) {
    case 'lightweight_activity':
      return buildLightweightActivityCard(event);
    case 'reasoning_activity':
      return buildReasoningActivityCard(event);
    case 'tool_activity':
      return buildToolActivityCard(event);
    case 'command_execution':
      return buildCommandExecutionCard(event);
    case 'file_change':
      return buildFileChangeCard(event);
    case 'context_usage':
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
              content: '上下文使用量已更新',
            },
          ],
        },
      };
  }
}
