import {
  getClaudeModeOptions,
  getClaudeModeSuffix,
  getClaudeModeTitle,
} from '../../runtime/claude-mode.js';
import type { ClaudePermissionMode } from '../../runtime/claude-mode.js';
import type { RecentWorkspaceOption } from '../../infra/recent-workspaces.js';
import type { RuntimeName } from '../../runtime/types.js';
import type {
  NativeReplayItem,
  NativeSessionSummary,
} from '../../infra/native-session-history.js';
import { NEW_SESSION_WORKDIR_FIELD } from '../constants.js';

export function buildClaudeModeButtons(
  scope: 'new' | 'switch',
  selectedMode?: ClaudePermissionMode,
  bindingId?: string,
  options?: {
    submit?: boolean;
  },
): Array<Record<string, unknown>> {
  return getClaudeModeOptions().map((option) => ({
    tag: 'column' as const,
    width: 'auto' as const,
    elements: [
      {
        tag: 'button' as const,
        text: {
          tag: 'plain_text' as const,
          content: option.title,
        },
        type: option.mode === selectedMode ? 'primary' as const : 'default' as const,
        ...(options?.submit
          ? {
              name: `claude_mode_${option.mode}`,
              form_action_type: 'submit' as const,
            }
          : {}),
        behaviors: [
          {
            type: 'callback' as const,
            value: {
              callback_data: scope === 'new'
                ? `claude-mode:new:${option.mode}`
                : `claude-mode:switch:${bindingId || ''}:${option.mode}`,
            },
          },
        ],
      },
    ],
  }));
}

export function buildClaudeModeCard(
  scope: 'new' | 'switch',
  options?: {
    selectedMode?: ClaudePermissionMode;
    bindingId?: string;
    note?: string;
  },
): Record<string, unknown> {
  const selectedTitle = options?.selectedMode ? getClaudeModeTitle(options.selectedMode) : '';
  const intro = scope === 'new'
    ? '请选择要进入的 Claude mode。创建后会保持该 mode。'
    : `当前 mode：**${selectedTitle || getClaudeModeTitle('default')}**\n点击下方按钮即可切换。`;
  const note = options?.note?.trim();
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
        content: scope === 'new' ? '选择 Claude Mode' : '切换 Claude Mode',
      },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: note ? `${intro}\n\n${note}` : intro,
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          horizontal_align: 'left',
          columns: buildClaudeModeButtons(scope, options?.selectedMode, options?.bindingId),
        },
      ],
    },
  };
}

export function buildWorkspaceSelect(workspaces: RecentWorkspaceOption[]): Record<string, unknown> {
  const placeholder = workspaces[0]
    ? `选择工作区，默认：${workspaces[0].shortLabel}`
    : '选择工作区';
  return {
    tag: 'select_static',
    name: NEW_SESSION_WORKDIR_FIELD,
    placeholder: {
      tag: 'plain_text',
      content: placeholder,
    },
    options: workspaces.map((workspace) => ({
      text: {
        tag: 'plain_text',
        content: workspace.label,
      },
      value: workspace.value,
    })),
  };
}

export function buildCodexModeButtons(): Array<Record<string, unknown>> {
  return [
    {
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          name: 'new_session_codex_code',
          text: {
            tag: 'plain_text',
            content: '默认',
          },
          type: 'primary',
          form_action_type: 'submit',
          behaviors: [
            {
              type: 'callback',
              value: {
                callback_data: 'new-session:codex:code',
              },
            },
          ],
        },
      ],
    },
    {
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          name: 'new_session_codex_plan',
          text: {
            tag: 'plain_text',
            content: 'Plan',
          },
          type: 'default',
          form_action_type: 'submit',
          behaviors: [
            {
              type: 'callback',
              value: {
                callback_data: 'new-session:codex:plan',
              },
            },
          ],
        },
      ],
    },
  ];
}

export function buildNewCodexSessionCard(workspaces: RecentWorkspaceOption[]): Record<string, unknown> {
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
        content: '创建 Codex 会话',
      },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'new_session_codex',
          elements: [
            {
              tag: 'markdown',
              content: '请选择要进入的工作区，再选择进入模式。',
            },
            {
              tag: 'markdown',
              content: '最近工作区（去重后最多 5 个）：',
            },
            buildWorkspaceSelect(workspaces),
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: '8px',
              horizontal_align: 'left',
              columns: buildCodexModeButtons(),
            },
          ],
        },
      ],
    },
  };
}

export function buildNewClaudeSessionCard(workspaces: RecentWorkspaceOption[]): Record<string, unknown> {
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
        content: '创建 Claude 会话',
      },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'form',
          name: 'new_session_claude',
          elements: [
            {
              tag: 'markdown',
              content: '请选择要进入的工作区，再点击下方 Claude mode 按钮创建新群。',
            },
            {
              tag: 'markdown',
              content: '最近工作区（去重后最多 5 个）：',
            },
            buildWorkspaceSelect(workspaces),
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: '8px',
              horizontal_align: 'left',
              columns: buildClaudeModeButtons('new', undefined, undefined, { submit: true }),
            },
          ],
        },
      ],
    },
  };
}

export function formatNativeSessionUpdatedAt(updatedAt: string): string {
  const normalized = updatedAt.trim();
  if (!normalized) return '未知时间';
  return normalized.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z$/, '');
}

export function buildResumeSessionCard(
  runtime: RuntimeName,
  sessions: NativeSessionSummary[],
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
        content: runtime === 'codex' ? '恢复 Codex 会话' : '恢复 Claude 会话',
      },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '请选择要恢复的原始会话。会创建一个新群，并把历史内容回放成卡片。',
        },
        ...sessions.flatMap((session) => ([
          {
            tag: 'column_set',
            horizontal_spacing: '8px',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 4,
                elements: [
                  {
                    tag: 'markdown',
                    content: [
                      `**${session.title}**`,
                      `\`${session.cwd}\``,
                      `更新时间：${formatNativeSessionUpdatedAt(session.updatedAt)}`,
                    ].join('\n'),
                  },
                ],
              },
              {
                tag: 'column',
                width: 'auto',
                elements: [
                  {
                    tag: 'button',
                    text: {
                      tag: 'plain_text',
                      content: '恢复',
                    },
                    type: 'primary',
                    behaviors: [
                      {
                        type: 'callback',
                        value: {
                          callback_data: `resume:pick:${runtime}:${session.nativeSessionId}`,
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])),
      ],
    },
  };
}

export function splitReplayText(text: string, limit = 2800): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];
  const segments: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const chunk = normalized.slice(cursor, cursor + limit);
    segments.push(chunk);
    cursor += limit;
  }
  return segments;
}

export function stripReplayToolNamePrefix(text: string, toolName: string | undefined): string {
  const normalized = text.trim();
  if (!toolName) return normalized;
  const prefix = `${toolName}\n`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length).trim() : normalized;
}

export function buildReplayMessageText(
  runtime: RuntimeName,
  item: NativeReplayItem,
  partIndex = 0,
  totalParts = 1,
): string {
  const baseTitle = item.kind === 'user_message'
    ? '用户'
    : item.kind === 'assistant_message'
      ? (runtime === 'codex' ? 'Codex' : 'Claude')
      : item.toolName
        ? `工具结果 · ${item.toolName}`
        : '工具结果';
  const title = totalParts > 1 ? `${baseTitle} (${partIndex + 1}/${totalParts})` : baseTitle;
  const body = item.kind === 'tool_result'
    ? stripReplayToolNamePrefix(item.text, item.toolName)
    : item.text.trim();
  return `**${title}**\n\n${body}`;
}

export { getClaudeModeSuffix, getClaudeModeTitle };
