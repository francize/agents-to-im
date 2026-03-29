import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as lark from '@larksuiteoapi/node-sdk';

import type {
  ActivityEvent,
  ChannelAddress,
  ChannelBinding,
  ChannelType,
  FileAttachment,
  InboundMessage,
  OutboundImage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../bridge/types.js';
import { DEFAULT_CHANNEL_INSTANCE_ID, resolveChannelInstanceId } from '../bridge/types.js';
import type { StructuredInputRequestInfo, StructuredInputResponse } from '../bridge/host.js';
import { BaseChannelAdapter } from '../bridge/channel-adapter.js';
import { getBridgeContext } from '../bridge/context.js';
import { appendLocalCommandExchange } from '../bridge/local-command-history.js';
import { handlePermissionCallback } from '../bridge/permission-broker.js';
import { validateMode } from '../bridge/security/validators.js';
import {
  buildCardContent,
  buildPostContent,
  hasComplexMarkdown,
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
} from '../bridge/markdown/feishu.js';
import {
  CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE,
  buildHandledClaudePlanExitCard,
  buildClaudePlanExecutionPrompt,
  buildClaudePlanFollowUpPrompt,
  buildClaudePlanModeUpdates,
} from '../claude-plan-exit.js';
import {
  getClaudeModeOptions,
  getClaudeModeSuffix,
  getClaudeModeTitle,
  normalizeClaudePermissionMode,
} from '../claude-mode.js';
import type { ClaudePermissionMode } from '../claude-mode.js';
import type { FeishuProfileConfig } from '../config.js';
import {
  listRecentNativeSessions,
  loadNativeSessionTranscript,
  type NativeReplayItem,
  type NativeSessionSummary,
} from '../native-session-history.js';

import type { MultiplexLLMProvider } from '../multiplex-llm-provider.js';
import { listRecentWorkspaces, type RecentWorkspaceOption } from '../recent-workspaces.js';
import type { RuntimeName } from '../runtime-types.js';
import { JsonFileStore } from '../store.js';

const STREAM_ELEMENT_ID = 'stream_content';
const TYPING_EMOJI = 'Typing';
const STREAM_PLACEHOLDER_TEXT = '🤖 努力回答中...';
const PLAN_SUFFIX = ' [PLAN]';
const STRUCTURED_INPUT_PREFIX = 'structured-input';
const NEW_SESSION_WORKDIR_FIELD = 'new_session_workdir';
const PENDING_INBOUND_IMAGE_TTL_MS = 15 * 60 * 1000;
export const FEISHU_REQUIRED_APP_SCOPES = [
  'im:message:send_as_bot',
  'im:message:readonly',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message:update',
  'im:message.reactions:read',
  'im:message.reactions:write_only',
  'im:chat:read',
  'im:chat:update',
  'im:resource',
  'cardkit:card:write',
  'cardkit:card:read',
] as const;

type MemberIdType = 'open_id' | 'user_id' | 'union_id';

interface SenderIdentity {
  id: string;
  type: MemberIdType;
}

interface FeishuMessageEventData {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: 'p2p' | 'group' | string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    message_type: string;
    content: string;
    create_time: string;
  };
}

interface PreviewArtifact {
  key: string;
  routeKey: string;
  chatId: string;
  draftId: number;
  replyToMessageId?: string;
  messageId?: string;
  cardId?: string;
  lastText: string;
  sequence: number;
  mode: 'cardkit' | 'patch';
}

interface ActivityArtifact {
  key: string;
  routeKey: string;
  activityId: string;
  messageId: string;
  openMessageId?: string;
  kind: ActivityEvent['kind'];
}

interface PendingActivitySend {
  requestUuid: string;
  needsRecoveryPatch: boolean;
}

interface PendingInboundImage {
  key: string;
  chatId: string;
  threadId?: string;
  senderId: string;
  messageId: string;
  createdAt: number;
  attachments?: FileAttachment[];
  errorMessage?: string;
}

export interface FeishuAdapterOptions {
  profile: FeishuProfileConfig;
  runtimeProfileMap: Record<RuntimeName, string>;
  profileLabels?: Record<string, string>;
}

type StructuredActionEvent = lark.InteractiveCardActionEvent & {
  action: lark.InteractiveCardActionEvent['action'] & {
    form_value?: Record<string, unknown>;
    name?: string;
    options?: string[];
    input_value?: string;
    checked?: boolean;
  };
  operator?: {
    open_id?: string;
    user_id?: string;
  };
  context?: {
    open_message_id?: string;
    open_chat_id?: string;
  };
};

function buildRouteKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:thread:${threadId}` : `${chatId}:main`;
}

function routeKeyForAddress(address: Pick<ChannelAddress, 'chatId' | 'threadId'>): string {
  return buildRouteKey(address.chatId, address.threadId);
}

function previewKey(routeKey: string, draftId: number): string {
  return `${routeKey}:${draftId}`;
}

function pendingInboundImageKey(chatId: string, senderId: string, messageId: string, threadId?: string): string {
  return `${chatId}:${threadId || 'main'}:${senderId}:${messageId}`;
}

function activityKey(routeKey: string, activityId: string): string {
  return `${routeKey}:activity:${activityId}`;
}

function stableMessageUuid(scope: string, key: string): string {
  const hash = createHash('sha256').update(`${scope}:${key}`).digest('hex').slice(0, 40);
  return `${scope}-${hash}`.slice(0, 50);
}

function sanitizeTitleFallback(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 30) || '新会话';
}

function normalizePath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function stripPlanSuffix(text: string): string {
  return text.replace(/\s*\[PLAN\]$/, '').trim();
}

function stripClaudeModeSuffix(text: string): string {
  let normalized = stripPlanSuffix(text).trim();
  for (const option of getClaudeModeOptions()) {
    const suffix = getClaudeModeSuffix(option.mode);
    if (suffix && normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length).trim();
      break;
    }
  }
  return normalized;
}

function resolveLegacyClaudePermissionMode(mode: 'code' | 'plan' | 'ask'): ClaudePermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'ask':
      return 'default';
    default:
      return 'acceptEdits';
  }
}

function resolveClaudeBindingMode(
  binding: Pick<import('../bridge/types.js').ChannelBinding, 'mode' | 'claudePermissionMode'>,
): ClaudePermissionMode {
  return binding.claudePermissionMode || resolveLegacyClaudePermissionMode(binding.mode);
}

function defaultChatName(runtime: RuntimeName, claudePermissionMode?: ClaudePermissionMode): string {
  const base = runtime === 'codex' ? 'Codex 新会话' : 'Claude 新会话';
  return runtime === 'claude' ? `${base}${getClaudeModeSuffix(claudePermissionMode)}` : base;
}

function buildClaudeModeButtons(
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
        ...(options?.submit ? { form_action_type: 'submit' as const } : {}),
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

function buildClaudeModeCard(
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

function buildWorkspaceSelect(workspaces: RecentWorkspaceOption[]): Record<string, unknown> {
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

function buildCodexModeButtons(): Array<Record<string, unknown>> {
  return [
    {
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
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

function buildNewCodexSessionCard(workspaces: RecentWorkspaceOption[]): Record<string, unknown> {
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

function buildNewClaudeSessionCard(workspaces: RecentWorkspaceOption[]): Record<string, unknown> {
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

function formatNativeSessionUpdatedAt(updatedAt: string): string {
  const normalized = updatedAt.trim();
  if (!normalized) return '未知时间';
  return normalized.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z$/, '');
}

function buildResumeSessionCard(
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

function splitReplayText(text: string, limit = 2800): string[] {
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

function stripReplayToolNamePrefix(text: string, toolName: string | undefined): string {
  const normalized = text.trim();
  if (!toolName) return normalized;
  const prefix = `${toolName}\n`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length).trim() : normalized;
}

function buildReplayMessageText(
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

function buildSimpleCard(text: string): Record<string, unknown> {
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

function buildStatusCard(
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

function buildHandledPermissionCard(action: string): Record<string, unknown> {
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

function buildHandledPlanCard(action: string): Record<string, unknown> {
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

function ensureRobotPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '🤖 努力回答中...';
  return trimmed.startsWith('🤖') ? trimmed : `🤖 ${trimmed}`;
}

function normalizeSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateActivityOutput(text: string, maxChars = 280): string {
  const normalized = text.replace(/\s+\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`');
}

function formatActivityStatus(status: 'pending' | 'running' | 'completed' | 'failed'): string {
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

function buildActivityCardBase(elements: Array<Record<string, unknown>>, header?: {
  title: string;
  template?: NonNullable<lark.InteractiveCard['header']>['template'];
}): Record<string, unknown> {
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

function getActivityEventId(event: ActivityEvent): string {
  switch (event.kind) {
    case 'reasoning_activity':
      return `reasoning:${event.turnId || event.taskId || event.source || 'current'}`;
    case 'tool_activity':
      return `tool:${event.toolUseId}`;
    default:
      return event.id;
  }
}

function buildCollapsibleActivityCard(
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

function buildLightweightActivityCard(event: Extract<ActivityEvent, { kind: 'lightweight_activity' }>): Record<string, unknown> {
  return buildActivityCardBase([
    {
      tag: 'markdown',
      content: ensureRobotPrefix(event.text),
    },
  ]);
}

function buildReasoningActivityCard(event: Extract<ActivityEvent, { kind: 'reasoning_activity' }>): Record<string, unknown> {
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

function buildCommandExecutionCard(event: Extract<ActivityEvent, { kind: 'command_execution' }>): Record<string, unknown> {
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
    lines.push('', `**输出预览**`, '```text', output.replace(/```/g, '``` '), '```');
  }
  return buildCollapsibleActivityCard('执行命令', summary, lines.join('\n'), event.status);
}

function buildFileChangeCard(event: Extract<ActivityEvent, { kind: 'file_change' }>): Record<string, unknown> {
  const changedCount = event.changes.length;
  const summary = [formatActivityStatus(event.status), changedCount > 0 ? `${changedCount} 个文件` : normalizeSingleLine(event.summary || '')]
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

function buildToolActivityCard(event: Extract<ActivityEvent, { kind: 'tool_activity' }>): Record<string, unknown> {
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

function buildActivityCard(event: ActivityEvent): Record<string, unknown> {
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
      return buildSimpleCard('上下文使用量已更新');
  }
}

function buildStreamingCardSkeleton(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      streaming_mode: true,
      summary: {
        content: STREAM_PLACEHOLDER_TEXT,
        i18n_content: {
          zh_cn: STREAM_PLACEHOLDER_TEXT,
          en_us: 'Working on it...',
        },
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: STREAM_PLACEHOLDER_TEXT,
          element_id: STREAM_ELEMENT_ID,
        },
      ],
    },
  };
}

function buildActionCard(
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

function buildPermissionCard(text: string, buttons: NonNullable<OutboundMessage['inlineButtons']>): Record<string, unknown> {
  return buildActionCard('Permission Required', text, buttons, 'orange');
}

function buildStructuredFieldName(requestId: string, questionId: string, kind: 'answer' | 'other'): string {
  const sanitize = (value: string): string => value.replace(/[^a-zA-Z0-9_]/g, '_');
  return `${STRUCTURED_INPUT_PREFIX}_${sanitize(requestId)}_${kind}_${sanitize(questionId)}`;
}

function buildStructuredInputQuestionElements(request: StructuredInputRequestInfo): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: '继续前需要你补充一些信息。',
    },
  ];

  for (const question of request.questions) {
    const singleSelectReasonLines = question.options?.length && !question.multiSelect
      ? question.options
          .filter((option) => option.description)
          .map((option, index) => `${index + 1}. ${option.label}：${option.description}`)
      : [];
    elements.push({
      tag: 'markdown',
      content: [
        `**${question.header || question.id}**`,
        question.question,
        ...(singleSelectReasonLines.length > 0 ? ['', '可选项说明：', ...singleSelectReasonLines] : []),
      ].join('\n'),
    });

    if (question.options?.length && !question.multiSelect) {
      elements.push({
        tag: 'select_static',
        name: buildStructuredFieldName(request.requestId, question.id, 'answer'),
        placeholder: {
          tag: 'plain_text',
          content: '请选择',
        },
        width: 'fill',
        options: question.options.map((option) => ({
          text: {
            tag: 'plain_text',
            content: option.label,
          },
          value: option.label,
        })),
      });
    }

    if (question.options?.length && question.multiSelect) {
      const optionLines = question.options.map((option, index) => {
        const summary = option.description ? `：${option.description}` : '';
        return `${index + 1}. ${option.label}${summary}`;
      });
      elements.push({
        tag: 'markdown',
        content: ['可选项：', ...optionLines].join('\n'),
      });
    }

    if (!question.options?.length || question.isOther || question.multiSelect) {
      elements.push({
        tag: 'input',
        name: buildStructuredFieldName(request.requestId, question.id, 'other'),
        width: 'fill',
        placeholder: {
          tag: 'plain_text',
          content: question.multiSelect
            ? '如需多个答案，请用逗号分隔；也可直接填写自定义内容'
            : question.options?.length
              ? '可补充自定义答案'
              : '请输入答案',
        },
      });
    }

    if (question.options?.length && question.isOther && !question.multiSelect) {
      elements.push({
        tag: 'markdown',
        content: '如果预设选项都不合适，可填写上面的自定义输入框。',
      });
    }

    if (question.options?.length && question.multiSelect) {
      elements.push({
        tag: 'markdown',
        content: '如果需要多个预设选项，请在输入框中使用英文逗号分隔；若都不合适，也可以直接填写自定义答案。',
      });
    }
  }

  elements.push({
    tag: 'column_set',
    horizontal_align: 'right',
    columns: [
      {
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            name: `submit_${request.requestId}`,
            form_action_type: 'submit',
            type: 'primary',
            text: {
              tag: 'plain_text',
              content: '提交',
            },
            behaviors: [
              {
                type: 'callback',
                value: {
                  callback_data: `input:submit:${request.requestId}`,
                },
              },
            ],
          },
        ],
      },
    ],
  });

  return [
    {
      tag: 'form',
      name: `form_${request.requestId.replace(/[^a-zA-Z0-9_]/g, '_')}`,
      elements,
    },
  ];
}

function buildResolvedStructuredInputElements(
  request: StructuredInputRequestInfo,
  note: string,
  answers?: StructuredInputResponse['answers'],
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: note,
      },
    },
  ];
  for (const question of request.questions) {
    const submitted = answers?.[question.id]?.answers
      ?.map((answer) => answer.trim())
      .filter(Boolean) || [];
    const formattedSubmitted = submitted.map((answer) => {
      const option = question.options?.find((candidate) => candidate.label.trim() === answer);
      if (option?.description) {
        return `${answer} (${option.description})`;
      }
      return answer;
    });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${question.header || question.id}**\n${question.question}`,
      },
    });
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: formattedSubmitted.length > 0
          ? `已提交：${formattedSubmitted.join(' / ')}`
          : '已提交：未记录答案',
      },
    });
  }
  return elements;
}

function buildStructuredInputCard(
  request: StructuredInputRequestInfo,
  options?: { resolved?: boolean; note?: string; answers?: StructuredInputResponse['answers'] },
): Record<string, unknown> {
  const elements = options?.resolved
    ? buildResolvedStructuredInputElements(
        request,
        options.note || '该问答已完成，正在继续执行。',
        options.answers,
      )
    : buildStructuredInputQuestionElements(request);

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'fill',
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '补充信息',
      },
      template: 'wathet',
    },
    body: {
      elements,
    },
  };
}

function buildStructuredInputFallbackText(request: StructuredInputRequestInfo): string {
  const lines: string[] = ['继续前需要你补充一些信息。', ''];
  request.questions.forEach((question, index) => {
    lines.push(`${index + 1}. ${question.header || question.id}`);
    lines.push(question.question);
    if (question.options?.length) {
      const optionsText = question.options
        .map((option) => option.description ? `${option.label}：${option.description}` : option.label)
        .join(' / ');
      lines.push(`可选项：${optionsText}`);
      if (question.multiSelect) {
        lines.push('如果需要多个选项，请使用逗号分隔输入。');
      }
    }
    lines.push('');
  });
  lines.push('当前交互卡发送失败，请转到本地命令行继续，或稍后重试。');
  return lines.join('\n').trim();
}

function normalizeStructuredAnswers(
  question: StructuredInputRequestInfo['questions'][number],
  selected: string[],
  other: string[],
): string[] {
  const values = [...selected, ...other]
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) return [];
  if (!question.multiSelect) {
    return Array.from(new Set(values));
  }

  const optionLabels = new Set(
    (question.options || [])
      .map((option) => option.label.trim())
      .filter(Boolean),
  );
  const normalized: string[] = [];
  for (const value of values) {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (
      parts.length > 1
      && optionLabels.size > 0
      && parts.every((part) => optionLabels.has(part))
    ) {
      normalized.push(...parts);
      continue;
    }
    normalized.push(value);
  }
  return Array.from(new Set(normalized));
}

function extractStructuredAnswers(
  request: StructuredInputRequestInfo,
  value: Record<string, unknown> | undefined,
  persistedAnswers?: StructuredInputResponse['answers'],
): StructuredInputResponse {
  const answers: StructuredInputResponse['answers'] = persistedAnswers
    ? JSON.parse(JSON.stringify(persistedAnswers))
    : {};
  const record = value || {};
  for (const question of request.questions) {
    const selected = collectTextFragments(record[buildStructuredFieldName(request.requestId, question.id, 'answer')]);
    const other = collectTextFragments(record[buildStructuredFieldName(request.requestId, question.id, 'other')]);
    const resolved = normalizeStructuredAnswers(question, selected, other);
    if (resolved.length > 0) {
      answers[question.id] = { answers: resolved };
    }
  }
  return { answers };
}

function isStructuredInputFieldInteraction(event: lark.InteractiveCardActionEvent): boolean {
  const tag = typeof event.action?.tag === 'string' ? event.action.tag : '';
  if (tag === 'select_static' || tag === 'select_person' || tag === 'input') {
    return true;
  }
  const value = event.action?.value;
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => key.startsWith(`${STRUCTURED_INPUT_PREFIX}:`));
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFragments(item));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string' && record.text.trim()) {
    return [record.text.trim()];
  }
  return Object.values(record).flatMap((item) => collectTextFragments(item));
}

function parseTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    return collectTextFragments(parsed).join('\n').trim();
  } catch {
    return content.trim();
  }
}

function parseImageResourceKey(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const candidate = typeof parsed.image_key === 'string'
      ? parsed.image_key
      : typeof parsed.file_key === 'string'
        ? parsed.file_key
        : '';
    return candidate.trim();
  } catch {
    return '';
  }
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  return 'bin';
}

function normalizeMarkdown(message: OutboundMessage): string {
  let text = message.text;
  if (message.parseMode === 'HTML') {
    text = htmlToFeishuMarkdown(text);
  }
  if (message.parseMode === 'Markdown' || message.parseMode === 'HTML') {
    text = preprocessFeishuMarkdown(text);
  }
  return text;
}

function buildPlanningPrompt(requestText: string): string {
  return [
    '你现在处于 PLAN 阶段。',
    '只输出计划，不要执行，不要调用工具，不要修改文件，也不要声称已经完成。',
    '请给出简洁、可执行的步骤、前置条件和主要风险。',
    '',
    '需求如下：',
    requestText,
  ].join('\n');
}

function buildPlanExecutionPrompt(requestText: string): string {
  return [
    '用户已经确认上一轮计划，现在开始实施。',
    '不要重复输出完整计划，直接执行当前需求；必要时只保留简短进度说明。',
    '',
    '原始需求如下：',
    requestText,
  ].join('\n');
}

function assertLarkOk(response: { code?: number; msg?: string }, context: string): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`${context}: code=${response.code}, msg=${response.msg || 'unknown error'}`);
  }
}

function isRecoverableMessageSendError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.message}\n${error.stack || ''}`
    : String(error);
  return /status code 504|gateway timeout|code=2200|etimedout/i.test(text);
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function resolveActionOpenMessageId(event: StructuredActionEvent): string {
  return event.open_message_id || event.context?.open_message_id || '';
}

export function findMissingAppScopes(visibleScopes: readonly string[]): string[] {
  const granted = new Set(visibleScopes);
  return FEISHU_REQUIRED_APP_SCOPES.filter((scope) => !granted.has(scope));
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';
  private readonly instanceAdapterId: string;
  private readonly instanceProfileId: string;
  private readonly instanceLabel: string;

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private chatQueues = new Map<string, Promise<void>>();
  private seenMessageIds = new Map<string, number>();
  private lastIncomingMessageId = new Map<string, string>();
  private typingReactions = new Map<string, string>();
  private previewArtifacts = new Map<string, PreviewArtifact>();
  private activePreviewByRoute = new Map<string, string>();
  private activityArtifacts = new Map<string, ActivityArtifact>();
  private pendingActivitySends = new Map<string, PendingActivitySend>();
  private pendingInboundImages = new Map<string, PendingInboundImage>();
  private pendingTitles = new Set<string>();
  private outboundMessageQueues = new Map<string, Promise<void>>();
  private lastOutboundMessageAt = new Map<string, number>();

  constructor(
    private readonly options: FeishuAdapterOptions = {
      profile: {
        id: DEFAULT_CHANNEL_INSTANCE_ID,
        label: '默认 Bot',
        toolOutputCards: true,
        autoImageSend: true,
      },
      runtimeProfileMap: {
        claude: DEFAULT_CHANNEL_INSTANCE_ID,
        codex: DEFAULT_CHANNEL_INSTANCE_ID,
      },
      profileLabels: {},
    },
  ) {
    super();
    this.instanceProfileId = options.profile.id || DEFAULT_CHANNEL_INSTANCE_ID;
    this.instanceAdapterId = `${this.channelType}:${this.instanceProfileId}`;
    this.instanceLabel = options.profile.label || this.instanceProfileId;
  }

  get adapterId(): string {
    return this.instanceAdapterId;
  }

  get profileId(): string {
    return this.instanceProfileId;
  }

  get label(): string {
    return this.instanceLabel;
  }

  allowsAutoImageSend(): boolean {
    if (this.usesLegacyStoreSettings()) {
      return this.getStore().getSetting('bridge_feishu_auto_image_send') !== 'false';
    }
    return this.options.profile.autoImageSend !== false;
  }

  private withInstance(address: ChannelAddress): ChannelAddress {
    return {
      ...address,
      channelInstanceId: resolveChannelInstanceId(address) === DEFAULT_CHANNEL_INSTANCE_ID
        ? this.profileId
        : resolveChannelInstanceId(address),
    };
  }

  private getRuntimeProfileId(runtime: RuntimeName): string {
    return this.options.runtimeProfileMap[runtime] || DEFAULT_CHANNEL_INSTANCE_ID;
  }

  private getRuntimeProfileLabel(runtime: RuntimeName): string {
    const profileId = this.getRuntimeProfileId(runtime);
    return this.options.profileLabels?.[profileId] || profileId;
  }

  private isRuntimeOwnedByThisAdapter(runtime: RuntimeName): boolean {
    return this.getRuntimeProfileId(runtime) === this.profileId;
  }

  private buildWrongBotMessage(runtime: RuntimeName): string {
    return `请到 ${this.getRuntimeProfileLabel(runtime)} Bot 上执行 \`/new:${runtime}\`。当前 Bot 仅处理映射到自己的 runtime。`;
  }

  private usesLegacyStoreSettings(): boolean {
    return !this.options.profile.appId && !this.options.profile.appSecret;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const { appId, appSecret, domain } = this.getClientConfig();
    this.restClient = new lark.Client({ appId, appSecret, domain });

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'im.message.message_read_v1': async () => {},
      'card.action.trigger': async (data: unknown) => {
        try {
          return await this.handleCardAction(data as StructuredActionEvent);
        } catch (error) {
          console.warn('[feishu-adapter] card.action.trigger handler error:', error);
          return {
            toast: {
              type: 'error',
              content: '交互处理失败，请稍后重试。',
            },
          };
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.info,
    });

    const wsClientAny = this.wsClient as unknown as {
      handleEventData: (data: unknown) => unknown;
    };
    const originalHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
    wsClientAny.handleEventData = (data: unknown) => {
      const frame = data as { headers?: Array<{ key?: string; value?: string }> };
      const messageType = frame.headers?.find((header) => header.key === 'type')?.value;
      if (messageType === 'card' && frame.headers) {
        return originalHandleEventData({
          ...frame,
          headers: frame.headers.map((header) =>
            header.key === 'type' ? { ...header, value: 'event' } : header,
          ),
        });
      }
      return originalHandleEventData(data);
    };

    this.running = true;
    void this.runScopeDiagnostic();
    void this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('[feishu-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      this.wsClient?.close({ force: true });
    } catch {
      // ignore
    }
    this.wsClient = null;
    this.restClient = null;
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
    this.queue = [];
    this.chatQueues.clear();
    this.previewArtifacts.clear();
    this.activePreviewByRoute.clear();
    this.activityArtifacts.clear();
    this.pendingActivitySends.clear();
    this.pendingInboundImages.clear();
    this.pendingTitles.clear();
    this.outboundMessageQueues.clear();
    this.lastOutboundMessageAt.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.running) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  validateConfig(): string | null {
    const store = this.tryGetStore();
    const appId = this.options.profile.appId || store?.getSetting('bridge_feishu_app_id') || '';
    const appSecret = this.options.profile.appSecret || store?.getSetting('bridge_feishu_app_secret') || '';
    if (!appId) return `${this.label}: CTI_FEISHU_PROFILE_${this.profileId.toUpperCase()}_APP_ID is required`;
    if (!appSecret) return `${this.label}: CTI_FEISHU_PROFILE_${this.profileId.toUpperCase()}_APP_SECRET is required`;
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowed = this.options.profile.allowedUsers
      || (this.usesLegacyStoreSettings()
        ? (this.getStore().getSetting('bridge_feishu_allowed_users') || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined);
    if (!allowed || allowed.length === 0) return true;
    const allowSet = new Set(allowed.map((item) => item.trim()).filter(Boolean));
    return allowSet.has(userId);
  }

  onMessageStart(address: ChannelAddress): void {
    if (!this.restClient) return;
    const routeKey = routeKeyForAddress(address);
    const messageId = this.lastIncomingMessageId.get(routeKey);
    if (!messageId) return;
    void this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((response) => {
      const reactionId = response.data?.reaction_id;
      if (reactionId) this.typingReactions.set(routeKey, reactionId);
    }).catch(() => {});
  }

  onMessageEnd(address: ChannelAddress): void {
    if (!this.restClient) return;
    const routeKey = routeKeyForAddress(address);
    const reactionId = this.typingReactions.get(routeKey);
    const messageId = this.lastIncomingMessageId.get(routeKey);
    if (reactionId && messageId) {
      this.typingReactions.delete(routeKey);
      void this.restClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }).catch(() => {});
    }
    void this.syncChatName(address.chatId);
  }

  getPreviewCapabilities(address: ChannelAddress): PreviewCapabilities | null {
    const store = this.getStore();
    if (!store.getChannelBinding(this.channelType, address.chatId, this.profileId)) {
      return null;
    }
    return {
      supported: true,
      privateOnly: false,
      finalDelivery: 'segment_replace_preview',
    };
  }

  async sendPreview(address: ChannelAddress, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.restClient) return 'skip';
    const processedText = preprocessFeishuMarkdown(text);
    if (!processedText.trim()) return 'skip';
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    let artifact = this.previewArtifacts.get(key);
    if (!artifact) {
      const createdArtifact = await this.createPreviewArtifact(address, draftId, processedText);
      if (!createdArtifact) return 'degrade';
      artifact = createdArtifact;
      this.previewArtifacts.set(key, artifact);
      this.activePreviewByRoute.set(routeKey, key);
    }

    try {
      if (artifact.mode === 'cardkit' && artifact.cardId) {
        artifact.sequence += 1;
        const response = await this.restClient.cardkit.v1.cardElement.content({
          path: { card_id: artifact.cardId, element_id: STREAM_ELEMENT_ID },
          data: {
            content: processedText,
            sequence: artifact.sequence,
          },
        });
        assertLarkOk(response, 'cardkit.cardElement.content');
      } else if (artifact.messageId) {
        await this.patchInteractiveCard(artifact.messageId, buildSimpleCard(processedText));
      }
      artifact.lastText = processedText;
      return 'sent';
    } catch (error) {
      if (artifact.mode === 'cardkit' && artifact.messageId) {
        artifact.mode = 'patch';
        try {
          await this.patchInteractiveCard(artifact.messageId, buildSimpleCard(processedText));
          artifact.lastText = processedText;
          return 'sent';
        } catch {
          console.warn('[feishu-adapter] Preview degraded after CardKit failure:', error);
        }
      }
      return 'degrade';
    }
  }

  async primePreview(address: ChannelAddress, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.restClient) return 'skip';
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    if (this.previewArtifacts.has(key)) {
      return 'sent';
    }
    const createdArtifact = await this.createPreviewArtifact(address, draftId, '');
    if (!createdArtifact) return 'degrade';
    this.previewArtifacts.set(key, createdArtifact);
    this.activePreviewByRoute.set(routeKey, key);
    return 'sent';
  }

  endPreview(address: ChannelAddress, draftId: number): void {
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    const artifact = this.previewArtifacts.get(key);
    this.previewArtifacts.delete(key);
    if (this.activePreviewByRoute.get(routeKey) === key) {
      this.activePreviewByRoute.delete(routeKey);
    }
    if (artifact?.messageId && !artifact.lastText.trim()) {
      void this.deleteMessageQuietly(artifact.messageId);
    }
  }

  async sendStructuredInputRequest(
    address: ChannelAddress,
    request: StructuredInputRequestInfo,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const hasSecret = request.questions.some((question) => question.isSecret);
    if (hasSecret) {
      await this.sendAsPost(
        address,
        '当前问题包含敏感输入，飞书群聊不适合采集。请转到本地命令行继续。',
        replyToMessageId,
      );
      getBridgeContext().permissions.resolvePendingStructuredInput?.(request.requestId, { answers: {} });
      return { ok: true };
    }
    try {
      const result = await this.sendInteractiveCard(
        address,
        buildStructuredInputCard(request),
        replyToMessageId,
      );
      return {
        ok: true,
        messageId: result.messageId,
        openMessageId: result.openMessageId,
      };
    } catch (error) {
      console.warn('[feishu-adapter] Failed to send structured input card, falling back to post:', error);
      const fallback = await this.sendAsPost(
        address,
        buildStructuredInputFallbackText(request),
        replyToMessageId,
      );
      return {
        ok: fallback.ok,
        error: fallback.error,
        messageId: fallback.messageId,
        openMessageId: fallback.openMessageId,
      };
    }
  }

  async resolveStructuredInputRequest(requestId: string): Promise<void> {
    const request = this.getStore().getStructuredInputRequest(requestId);
    if (request?.channelInstanceId !== this.profileId) return;
    if (!request?.messageId) return;
    try {
      await this.patchInteractiveCard(
        request.messageId,
        buildStructuredInputCard({
          requestId: request.requestId,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          questions: request.questions,
        }, {
          resolved: true,
          note: '该问答已完成，正在继续执行。',
          answers: request.draftAnswers,
        }),
      );
    } catch (error) {
      console.warn('[feishu-adapter] Failed to resolve structured input card:', error);
    }
  }

  async upsertActivityEvent(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (
      !this.restClient
      || event.kind === 'context_usage'
      || (this.usesLegacyStoreSettings()
        ? this.getStore().getSetting('bridge_feishu_tool_output_cards') === 'false'
        : this.options.profile.toolOutputCards === false)
    ) {
      return { ok: true };
    }
    const routeKey = routeKeyForAddress(address);
    const activityId = getActivityEventId(event);
    const key = activityKey(routeKey, activityId);
    const artifact = this.activityArtifacts.get(key);
    const card = buildActivityCard(event);

    if (artifact?.messageId) {
      await this.patchInteractiveCard(artifact.messageId, card);
      return {
        ok: true,
        messageId: artifact.messageId,
        openMessageId: artifact.openMessageId,
      };
    }

    const targetReplyId = replyToMessageId || this.lastIncomingMessageId.get(routeKey);
    const pending = this.pendingActivitySends.get(key);
    const requestUuid = pending?.requestUuid || stableMessageUuid('activity', key);
    try {
      const sent = await this.sendInteractiveCard(address, card, targetReplyId, requestUuid);
      this.activityArtifacts.set(key, {
        key,
        routeKey,
        activityId,
        messageId: sent.messageId,
        openMessageId: sent.openMessageId,
        kind: event.kind,
      });
      this.pendingActivitySends.delete(key);
      if (pending?.needsRecoveryPatch) {
        await this.patchInteractiveCard(sent.messageId, card);
      }
      return {
        ok: true,
        messageId: sent.messageId,
        openMessageId: sent.openMessageId,
      };
    } catch (error) {
      if (isRecoverableMessageSendError(error)) {
        this.pendingActivitySends.set(key, {
          requestUuid,
          needsRecoveryPatch: true,
        });
        console.warn('[feishu-adapter] Activity card send timed out; keeping idempotent UUID for recovery:', error);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    const address = this.withInstance(message.address);

    if (message.rawCard) {
      const result = await this.sendInteractiveCard(address, message.rawCard, message.replyToMessageId);
      return {
        ok: true,
        messageId: result.messageId,
        openMessageId: result.openMessageId,
      };
    }

    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(
        address,
        normalizeMarkdown(message),
        message.inlineButtons,
        message.replyToMessageId,
        message.cardHeader,
      );
    }

    const activePreviewKey = this.activePreviewByRoute.get(routeKeyForAddress(address));
    if (activePreviewKey) {
      const artifact = this.previewArtifacts.get(activePreviewKey);
      if (artifact?.messageId) {
        try {
          const finalText = normalizeMarkdown(message);
          if (artifact.mode === 'cardkit' && artifact.cardId) {
            artifact.sequence += 1;
            const card = buildSimpleCard(finalText);
            const updateResponse = await this.restClient.cardkit.v1.card.update({
              path: { card_id: artifact.cardId },
              data: {
                card: {
                  type: 'card_json',
                  data: JSON.stringify(card),
                },
                sequence: artifact.sequence,
              },
            });
            assertLarkOk(updateResponse, 'cardkit.card.update');
            artifact.sequence += 1;
            const settingsResponse = await this.restClient.cardkit.v1.card.settings({
              path: { card_id: artifact.cardId },
              data: {
                settings: JSON.stringify({ streaming_mode: false }),
                sequence: artifact.sequence,
              },
            });
            assertLarkOk(settingsResponse, 'cardkit.card.settings');
          } else {
            await this.patchInteractiveCard(artifact.messageId, buildSimpleCard(finalText));
          }
          artifact.lastText = finalText;
          void this.maybeRenameChat(address.chatId);
          return { ok: true, messageId: artifact.messageId, openMessageId: artifact.messageId };
        } catch (error) {
          console.warn('[feishu-adapter] Failed to finalize preview in place:', error);
        }
      }
    }

    const text = normalizeMarkdown(message);
    const result = hasComplexMarkdown(text)
      ? await this.sendAsInteractiveCard(address, text, message.replyToMessageId)
      : await this.sendAsPost(address, text, message.replyToMessageId);
    if (result.ok) {
      void this.maybeRenameChat(address.chatId);
    }
    return result;
  }

  async sendImage(image: OutboundImage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    try {
      const address = this.withInstance(image.address);
      const imageKey = await this.uploadImageFile(image.filePath);
      const response = await this.sendLarkMessage(
        address,
        'image',
        JSON.stringify({ image_key: imageKey }),
        image.replyToMessageId,
      );
      assertLarkOk(response, 'im.message.sendImage');
      return {
        ok: true,
        messageId: response.data?.message_id,
        openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private appendBindingCommandExchange(binding: ChannelBinding | null, commandText: string, replyText: string): void {
    if (!binding?.codepilotSessionId) return;
    appendLocalCommandExchange(this.getStore(), binding.codepilotSessionId, commandText, replyText);
  }

  private prunePendingInboundImages(now = Date.now()): void {
    for (const [key, entry] of this.pendingInboundImages) {
      if (now - entry.createdAt > PENDING_INBOUND_IMAGE_TTL_MS) {
        this.pendingInboundImages.delete(key);
      }
    }
  }

  private getPendingInboundImage(chatId: string, senderId: string, messageId: string, threadId?: string): PendingInboundImage | null {
    const key = pendingInboundImageKey(chatId, senderId, messageId, threadId);
    const entry = this.pendingInboundImages.get(key) || null;
    if (!entry) return null;
    if (Date.now() - entry.createdAt <= PENDING_INBOUND_IMAGE_TTL_MS) {
      return entry;
    }
    this.pendingInboundImages.delete(key);
    return {
      ...entry,
      errorMessage: '这张图片已过期，请重新发送图片后再直接回复文字。',
      attachments: undefined,
    };
  }

  private setPendingInboundImage(entry: PendingInboundImage): void {
    this.pendingInboundImages.set(entry.key, entry);
  }

  private async downloadInboundImageAttachment(messageId: string, imageKey: string): Promise<FileAttachment> {
    if (!this.restClient?.im?.messageResource?.get) {
      throw new Error('Feishu 图片资源下载能力不可用');
    }
    const response = await this.restClient.im.messageResource.get({
      params: { type: 'image' },
      path: {
        message_id: messageId,
        file_key: imageKey,
      },
    });
    const stream = response.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const contentType = typeof response.headers?.['content-type'] === 'string'
      ? response.headers['content-type']
      : 'image/png';
    const extension = extensionForMimeType(contentType);
    return {
      id: `feishu-image:${messageId}`,
      name: `feishu-image-${messageId}.${extension}`,
      type: contentType,
      size: buffer.length,
      data: buffer.toString('base64'),
    };
  }

  private resolveReferencedInboundImages(
    chatId: string,
    senderId: string,
    threadId: string | undefined,
    referenceIds: Array<string | undefined>,
  ): { attachments?: FileAttachment[]; errorMessage?: string } {
    for (const referenceId of referenceIds) {
      if (!referenceId) continue;
      const entry = this.getPendingInboundImage(chatId, senderId, referenceId, threadId);
      if (!entry) continue;
      if (entry.attachments?.length) {
        return { attachments: entry.attachments };
      }
      return {
        errorMessage: entry.errorMessage || '这张图片暂时无法读取，请重新发送图片后再直接回复文字。',
      };
    }
    return {};
  }

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const messageId = data.message.message_id;
    if (data.sender.sender_type === 'app') return;
    if (this.seenMessageIds.has(messageId)) return;
    this.seenMessageIds.set(messageId, Date.now());
    if (this.seenMessageIds.size > 1000) {
      const first = this.seenMessageIds.keys().next().value;
      if (first) this.seenMessageIds.delete(first);
    }

    const sender = this.extractSenderIdentity(data);
    if (!sender || !this.isAuthorized(sender.id, data.message.chat_id)) {
      console.warn(
        `[feishu-adapter] Dropped inbound message ${messageId}: unauthorized or sender identity missing ` +
        `(chat=${data.message.chat_id})`,
      );
      return;
    }

    const threadId = data.message.thread_id || undefined;
    const routeKey = buildRouteKey(data.message.chat_id, threadId);
    this.lastIncomingMessageId.set(routeKey, messageId);
    console.log(
      `[feishu-adapter] Inbound message ${messageId} chat=${data.message.chat_id}` +
      `${threadId ? ` thread=${threadId}` : ''} type=${data.message.message_type} chatType=${data.message.chat_type}`,
    );

    await this.enqueueChatTask(routeKey, async () => {
      this.prunePendingInboundImages();
      const inbound: InboundMessage = {
        messageId,
        address: {
          channelType: this.channelType,
          channelInstanceId: this.profileId,
          chatId: data.message.chat_id,
          userId: sender.id,
          ...(threadId ? { threadId } : {}),
        },
        text: '',
        timestamp: Number(data.message.create_time || Date.now()),
        raw: {
          rootId: data.message.root_id,
          parentId: data.message.parent_id,
          threadId,
          messageType: data.message.message_type,
        },
      };

      if (data.message.message_type === 'image') {
        const imageKey = parseImageResourceKey(data.message.content);
        const pendingKey = pendingInboundImageKey(
          data.message.chat_id,
          sender.id,
          messageId,
          threadId,
        );
        if (!imageKey) {
          this.setPendingInboundImage({
            key: pendingKey,
            chatId: data.message.chat_id,
            threadId,
            senderId: sender.id,
            messageId,
            createdAt: Date.now(),
            errorMessage: '这张图片的资源标识缺失，请重新发送图片后再直接回复文字。',
          });
          await this.sendAsPost(
            inbound.address,
            '已收到图片，但读取图片资源失败。请重新发送图片后，再直接回复这张图片补充文字。',
            messageId,
          );
          return;
        }
        try {
          const attachment = await this.downloadInboundImageAttachment(messageId, imageKey);
          this.setPendingInboundImage({
            key: pendingKey,
            chatId: data.message.chat_id,
            threadId,
            senderId: sender.id,
            messageId,
            createdAt: Date.now(),
            attachments: [attachment],
          });
          await this.sendAsPost(
            inbound.address,
            '已收到图片。请直接回复这张图片本身补充文字，我会把图文一起发给模型。',
            messageId,
          );
        } catch (error) {
          const errorMessage = `这张图片下载失败，请重新发送图片后再直接回复文字。${
            error instanceof Error && error.message ? `\n原因：${error.message}` : ''
          }`;
          this.setPendingInboundImage({
            key: pendingKey,
            chatId: data.message.chat_id,
            threadId,
            senderId: sender.id,
            messageId,
            createdAt: Date.now(),
            errorMessage,
          });
          console.warn('[feishu-adapter] Failed to download inbound image:', error);
          await this.sendAsPost(inbound.address, errorMessage, messageId);
        }
        return;
      }

      if (data.message.message_type !== 'text') {
        console.warn(
          `[feishu-adapter] Dropped inbound message ${messageId}: unsupported message type ` +
          `(type=${data.message.message_type}, content=${data.message.content.slice(0, 200)})`,
        );
        return;
      }

      inbound.text = parseTextContent(data.message.content);
      if (!inbound.text) {
        console.warn(
          `[feishu-adapter] Dropped inbound message ${messageId}: empty parsed text ` +
          `(type=${data.message.message_type}, content=${data.message.content.slice(0, 200)})`,
        );
        return;
      }

      const referencedImages = this.resolveReferencedInboundImages(
        data.message.chat_id,
        sender.id,
        threadId,
        [data.message.parent_id, data.message.root_id],
      );
      if (referencedImages.errorMessage) {
        await this.sendAsPost(inbound.address, referencedImages.errorMessage, messageId);
        return;
      }
      if (referencedImages.attachments?.length) {
        inbound.attachments = referencedImages.attachments;
      }

      if (data.message.chat_type === 'p2p') {
        await this.handleDirectMessage(sender, inbound);
        return;
      }
      await this.handleGroupMessage(sender, inbound);
    });
  }

  private async handleCardAction(event: StructuredActionEvent): Promise<{ toast: { type: string; content: string } }> {
    const callbackData = typeof event.action?.value?.callback_data === 'string'
      ? event.action.value.callback_data
      : '';
    console.log(
      `[feishu-adapter] card.action.trigger tag=${event.action?.tag || 'unknown'} ` +
      `open_message_id=${event.open_message_id || event.context?.open_message_id || 'unknown'} ` +
      `callback=${callbackData || '(none)'}`,
    );
    if (!callbackData) {
      if (isStructuredInputFieldInteraction(event)) {
        return { toast: { type: 'success', content: '已记录选择，填写完成后点击提交。' } };
      }
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    if (callbackData.startsWith('perm:')) {
      const store = this.getStore();
      const [, action, ...permissionParts] = callbackData.split(':');
      const permissionRequestId = permissionParts.join(':');
      const link = store.getPermissionLink(permissionRequestId);
      const actionMessageId = resolveActionOpenMessageId(event);
      if (
        link
        && handlePermissionCallback(callbackData, link.chatId, actionMessageId, {
          channelType: this.channelType,
          channelInstanceId: this.profileId,
        })
      ) {
        await this.patchActionCardSafely(
          link.messageId,
          buildHandledPermissionCard(action || ''),
          'permission',
          actionMessageId || link.openMessageId,
        );
        return { toast: { type: 'success', content: 'Permission updated' } };
      }
      return { toast: { type: 'warning', content: 'Permission already handled' } };
    }
    if (callbackData.startsWith('new-session:')) {
      return this.handleNewSessionCardAction(event, callbackData);
    }
    if (callbackData.startsWith('claude-mode:')) {
      return this.handleClaudeModeCardAction(event, callbackData);
    }
    if (callbackData.startsWith('resume:')) {
      return this.handleResumeCardAction(event, callbackData);
    }
    if (callbackData.startsWith('input:')) {
      return this.handleStructuredInputCardAction(event, callbackData);
    }
    if (callbackData.startsWith('planexit:')) {
      return this.handleClaudePlanExitCardAction(event, callbackData);
    }
    if (callbackData.startsWith('plan:')) {
      return this.handlePlanCardAction(event, callbackData);
    }
    return { toast: { type: 'warning', content: 'Unsupported action' } };
  }

  private async patchActionCardSafely(
    messageId: string | undefined,
    card: Record<string, unknown>,
    kind: string,
    openMessageId?: string,
  ): Promise<void> {
    if (!this.restClient || !this.restClient.im?.message?.patch) return;
    const attempts = [
      openMessageId
        ? { id: openMessageId, messageIdType: 'open_message_id' as const }
        : null,
      messageId
        ? { id: messageId, messageIdType: 'message_id' as const }
        : null,
    ].filter((value, index, list): value is { id: string; messageIdType: 'message_id' | 'open_message_id' } =>
      !!value && list.findIndex((item) => item?.id === value.id && item?.messageIdType === value.messageIdType) === index,
    );
    if (attempts.length === 0) return;

    for (const attempt of attempts) {
      try {
        console.log(`[feishu-adapter] Patching ${kind} card via ${attempt.messageIdType}: ${attempt.id}`);
        await this.patchInteractiveCard(attempt.id, card, { messageIdType: attempt.messageIdType });
        console.log(`[feishu-adapter] Patched ${kind} card via ${attempt.messageIdType}: ${attempt.id}`);
        return;
      } catch (error) {
        console.warn(
          `[feishu-adapter] Failed to patch ${kind} card via ${attempt.messageIdType} ${attempt.id}:`,
          error,
        );
      }
    }
  }

  private findBindingById(bindingId: string): ChannelBinding | null {
    return this.getStore()
      .listChannelBindings(this.channelType)
      .find((item) => item.channelInstanceId === this.profileId && item.id === bindingId) || null;
  }

  private extractActionSenderIdentity(event: StructuredActionEvent): SenderIdentity | null {
    if (event.operator?.open_id) {
      return { id: event.operator.open_id, type: 'open_id' };
    }
    if (event.operator?.user_id) {
      return { id: event.operator.user_id, type: 'user_id' };
    }
    return null;
  }

  private getRecentWorkspaceOptions(): RecentWorkspaceOption[] {
    const store = this.getStore();
    return listRecentWorkspaces(
      store.listChannelBindings(this.channelType),
      store.getSetting('bridge_default_work_dir') || process.cwd(),
    );
  }

  private resolveSelectedWorkdir(formValue?: Record<string, unknown>): string {
    const selected = collectTextFragments(formValue?.[NEW_SESSION_WORKDIR_FIELD]);
    if (selected[0]) {
      return normalizePath(selected[0]);
    }
    const fallback = this.getRecentWorkspaceOptions()[0]?.value
      || this.getStore().getSetting('bridge_default_work_dir')
      || process.cwd();
    return normalizePath(fallback);
  }

  private buildSessionReadyMessage(runtime: RuntimeName, binding: ChannelBinding): string {
    if (runtime === 'claude') {
      const modeTitle = getClaudeModeTitle(resolveClaudeBindingMode(binding));
      return [
        `已创建 Claude 会话，当前 mode：**${modeTitle}**。`,
        '后续直接在本群发送消息继续对话。',
        '可用命令：`/stop` 中断当前输出、`/mode` 切换 mode、`/reset` 重置会话。权限请求请直接使用卡片按钮处理。',
      ].join('\n');
    }
    return [
      `已创建 codex 会话，当前模式：**${binding.mode === 'plan' ? 'Plan' : '默认'}**。`,
      '后续请直接在本群继续对话。',
      '可用命令：`/stop` 中断当前输出、`/mode` 切换 mode、`/reset` 重置会话。',
    ].join('\n');
  }

  private async ensureRuntimeAvailable(runtime: RuntimeName): Promise<void> {
    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      ensureRuntimeAvailable?: (target: RuntimeName) => Promise<void>;
    };
    await llm.ensureRuntimeAvailable?.(runtime);
  }

  private async createBoundSession(
    runtime: RuntimeName,
    sender: SenderIdentity,
    options?: {
      claudePermissionMode?: ClaudePermissionMode;
      cwd?: string;
      bindingMode?: 'code' | 'plan' | 'ask';
      skipReadyMessage?: boolean;
    },
  ): Promise<{ chatId: string; binding: ChannelBinding }> {
    await this.ensureRuntimeAvailable(runtime);
    const store = this.getStore();
    const model = runtime === 'codex'
      ? store.getSetting('bridge_codex_default_model') || ''
      : store.getSetting('bridge_claude_default_model') || store.getSetting('bridge_default_model') || '';
    const chatId = await this.createSessionGroup(runtime, sender, options?.claudePermissionMode);
    const session = store.createRuntimeSession({
      runtime,
      model,
      cwd: options?.cwd || store.getSetting('bridge_default_work_dir') || process.cwd(),
    });
    const initialBinding = store.upsertChannelBinding({
      channelType: this.channelType,
      channelInstanceId: this.profileId,
      chatId,
      codepilotSessionId: session.id,
      workingDirectory: session.working_directory,
      model: session.model,
      ...(runtime === 'claude'
        ? { claudePermissionMode: options?.claudePermissionMode || 'default' }
        : {}),
    });
    if (options?.bindingMode && initialBinding.mode !== options.bindingMode) {
      store.updateChannelBinding(initialBinding.id, { mode: options.bindingMode });
    }
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId) || initialBinding;
    await this.syncChatName(chatId);
    if (!options?.skipReadyMessage) {
      await this.sendAsPost(
        { channelType: this.channelType, channelInstanceId: this.profileId, chatId },
        this.buildSessionReadyMessage(runtime, binding),
      );
    }
    return { chatId, binding };
  }

  private async sendClaudeModeCard(
    address: ChannelAddress,
    scope: 'new' | 'switch',
    replyToMessageId?: string,
    options?: {
      selectedMode?: ClaudePermissionMode;
      bindingId?: string;
      note?: string;
    },
  ): Promise<SendResult> {
    const result = await this.sendInteractiveCard(
      address,
      buildClaudeModeCard(scope, options),
      replyToMessageId,
    );
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private async sendNewSessionCard(
    address: ChannelAddress,
    runtime: RuntimeName,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const workspaces = this.getRecentWorkspaceOptions();
    const card = runtime === 'codex'
      ? buildNewCodexSessionCard(workspaces)
      : buildNewClaudeSessionCard(workspaces);
    const result = await this.sendInteractiveCard(address, card, replyToMessageId);
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private async handleDirectMessage(sender: SenderIdentity, inbound: InboundMessage): Promise<void> {
    const command = inbound.text.trim().toLowerCase();
    if (command === '/new:claude') {
      await this.handleCreateSessionCommand(sender, inbound, 'claude');
      return;
    }
    if (command === '/new:codex') {
      await this.handleCreateSessionCommand(sender, inbound, 'codex');
      return;
    }
    if (command === '/resume:claude') {
      await this.handleResumeSessionCommand(sender, inbound, 'claude');
      return;
    }
    if (command === '/resume:codex') {
      await this.handleResumeSessionCommand(sender, inbound, 'codex');
      return;
    }
    await this.sendAsPost(
      inbound.address,
      '私聊仅支持 `/new:claude`、`/new:codex`、`/resume:claude` 和 `/resume:codex`。',
      inbound.messageId,
    );
  }

  private async handleGroupMessage(_sender: SenderIdentity, inbound: InboundMessage): Promise<void> {
    const store = this.getStore();
    const text = inbound.text.trim();
    const lower = text.toLowerCase();
    const binding = store.getChannelBinding(this.channelType, inbound.address.chatId, this.profileId);
    const workflow = binding ? store.getActivePlanWorkflowByBinding(binding.id) : null;

    if (lower.startsWith('/perm ')) {
      const handled = this.handlePermissionCommand(inbound.address.chatId, text, inbound.messageId);
      if (!handled) {
        await this.sendAsPost(inbound.address, '无效的权限命令，格式为 `/perm allow|allow_session|deny <id>`。', inbound.messageId);
      }
      return;
    }
    if (lower === '/reset') {
      await this.handleResetCommand(inbound.address, inbound.messageId);
      return;
    }
    if (lower === '/stop') {
      if (!binding) {
        await this.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
        return;
      }
      this.enqueue(inbound);
      return;
    }
    if (lower.startsWith('/mode')) {
      if (!binding) {
        await this.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
        return;
      }
      await this.handleModeCommand(binding.id, text, inbound.address, inbound.messageId);
      return;
    }
    if (lower === '/plan' || lower.startsWith('/plan ')) {
      if (!binding) {
        await this.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
        return;
      }
      await this.handlePlanCommand(binding.id, inbound);
      return;
    }
    if (lower.startsWith('/new')) {
      await this.sendAsPost(inbound.address, '请先私聊 Bot 使用 `/new:claude` 或 `/new:codex` 创建新会话。', inbound.messageId);
      return;
    }
    if (lower.startsWith('/')) {
      await this.sendAsPost(inbound.address, '该群仅支持普通对话、`/plan`、`/mode`、`/stop`、`/reset`。权限请求请直接使用卡片按钮处理；如需新会话，请私聊 Bot。', inbound.messageId);
      return;
    }

    if (!binding) {
      await this.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    if (workflow) {
      const consumed = await this.handlePlanWorkflowMessage(binding.id, workflow.workflowId, inbound);
      if (consumed) return;
    }
    this.enqueue(inbound);
  }

  private async handleCreateSessionCommand(sender: SenderIdentity, inbound: InboundMessage, runtime: RuntimeName): Promise<void> {
    if (!this.isRuntimeOwnedByThisAdapter(runtime)) {
      await this.sendAsPost(inbound.address, this.buildWrongBotMessage(runtime), inbound.messageId);
      return;
    }
    try {
      await this.ensureRuntimeAvailable(runtime);
      await this.sendNewSessionCard(inbound.address, runtime, inbound.messageId);
    } catch (error) {
      console.error('[feishu-adapter] Failed to initialize new-session card:', error);
      const message = `无法创建 ${runtime} 会话：${error instanceof Error ? error.message : String(error)}`;
      await this.sendAsPost(inbound.address, message, inbound.messageId);
    }
  }

  private async handleResumeSessionCommand(
    _sender: SenderIdentity,
    inbound: InboundMessage,
    runtime: RuntimeName,
  ): Promise<void> {
    if (!this.isRuntimeOwnedByThisAdapter(runtime)) {
      await this.sendAsPost(inbound.address, this.buildWrongBotMessage(runtime), inbound.messageId);
      return;
    }
    try {
      await this.ensureRuntimeAvailable(runtime);
      const workdir = this.getStore().getSetting('bridge_default_work_dir') || process.cwd();
      const sessions = listRecentNativeSessions(runtime, workdir, 5);
      if (sessions.length === 0) {
        await this.sendAsPost(
          inbound.address,
          `未找到当前工作区下可恢复的 ${runtime} 原始会话记录。`,
          inbound.messageId,
        );
        return;
      }
      await this.sendInteractiveCard(
        inbound.address,
        buildResumeSessionCard(runtime, sessions),
        inbound.messageId,
      );
    } catch (error) {
      await this.sendAsPost(
        inbound.address,
        `读取 ${runtime} 原始会话失败：${error instanceof Error ? error.message : String(error)}`,
        inbound.messageId,
      );
    }
  }

  private async handleNewSessionCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const [, runtimeText, modeText] = callbackData.split(':');
    const runtime = runtimeText === 'codex' ? 'codex' : runtimeText === 'claude' ? 'claude' : null;
    const bindingMode = modeText === 'plan' ? 'plan' : modeText === 'code' ? 'code' : null;
    if (!runtime || !bindingMode) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    const sender = this.extractActionSenderIdentity(event);
    if (!sender) {
      return { toast: { type: 'warning', content: '无法识别当前操作人' } };
    }
    const actionMessageId = resolveActionOpenMessageId(event);
    const cwd = this.resolveSelectedWorkdir(event.action?.form_value as Record<string, unknown> | undefined);
    try {
      await this.createBoundSession(runtime, sender, {
        cwd,
        bindingMode,
      });
      await this.patchActionCardSafely(
        undefined,
        buildStatusCard(
          runtime === 'codex' ? 'Codex 会话已创建' : '会话已创建',
          [
            `工作区：\`${cwd}\``,
            `模式：**${bindingMode === 'plan' ? 'Plan' : '默认'}**`,
            '请直接进入新群继续对话。',
          ].join('\n\n'),
          'green',
        ),
        'new-session',
        actionMessageId,
      );
      return {
        toast: {
          type: 'success',
          content: `已创建 ${runtime} 会话`,
        },
      };
    } catch (error) {
      console.error('[feishu-adapter] Failed to create session from new-session card:', error);
      return {
        toast: {
          type: 'warning',
          content: `创建会话失败：${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private async handleResumeCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const [, action, runtimeText, nativeSessionId] = callbackData.split(':');
    const runtime = runtimeText === 'codex' ? 'codex' : runtimeText === 'claude' ? 'claude' : null;
    if (action !== 'pick' || !runtime || !nativeSessionId) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    const sender = this.extractActionSenderIdentity(event);
    if (!sender) {
      return { toast: { type: 'warning', content: '无法识别当前操作人' } };
    }
    const defaultWorkdir = this.getStore().getSetting('bridge_default_work_dir') || process.cwd();
    const transcript = loadNativeSessionTranscript(runtime, nativeSessionId, defaultWorkdir);
    if (!transcript) {
      return { toast: { type: 'warning', content: '原始会话不存在或已失效' } };
    }
    const actionMessageId = resolveActionOpenMessageId(event);
    try {
      const { chatId, binding } = await this.createBoundSession(runtime, sender, {
        cwd: transcript.session.cwd,
        skipReadyMessage: true,
      });
      const store = this.getStore();
      if (runtime === 'codex') {
        store.updateSdkSessionId(binding.codepilotSessionId, transcript.session.nativeSessionId);
        store.updateCodexThreadId(binding.codepilotSessionId, transcript.session.nativeSessionId);
      } else {
        store.updateSdkSessionId(binding.codepilotSessionId, transcript.session.nativeSessionId);
      }
      store.updateSessionExt(binding.codepilotSessionId, {
        title: transcript.session.title,
        titleStatus: 'done',
        displayNameMode: 'native_locked',
      });
      await this.syncChatName(chatId);
      await this.replayNativeSessionHistory(
        { channelType: this.channelType, channelInstanceId: this.profileId, chatId },
        runtime,
        transcript.items,
      );
      await this.sendAsPost(
        { channelType: this.channelType, channelInstanceId: this.profileId, chatId },
        `已恢复 ${runtime} 原始会话，后续请直接在本群继续对话。`,
      );
      await this.patchActionCardSafely(
        undefined,
        buildStatusCard(
          runtime === 'codex' ? 'Codex 会话已恢复' : 'Claude 会话已恢复',
          `已恢复 **${transcript.session.title}**。\n\n请直接进入新群继续对话。`,
          'green',
        ),
        'resume',
        actionMessageId,
      );
      return { toast: { type: 'success', content: '会话恢复完成' } };
    } catch (error) {
      console.error('[feishu-adapter] Failed to resume native session:', error);
      return {
        toast: {
          type: 'warning',
          content: `恢复会话失败：${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  private async replayNativeSessionHistory(
    address: ChannelAddress,
    runtime: RuntimeName,
    items: NativeReplayItem[],
  ): Promise<void> {
    for (const item of items) {
      const parts = splitReplayText(item.text);
      for (const [index, part] of parts.entries()) {
        await this.sendAsInteractiveCard(
          address,
          buildReplayMessageText(runtime, { ...item, text: part }, index, parts.length),
        );
      }
    }
  }

  private async handleResetCommand(address: ChannelAddress, replyToMessageId?: string): Promise<void> {
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, address.chatId, this.profileId);
    if (!binding) {
      await this.sendAsPost(address, '当前群尚未绑定会话，请先私聊 Bot 使用 `/new:claude` 或 `/new:codex`。', replyToMessageId);
      return;
    }
    const workflow = store.getActivePlanWorkflowByBinding(binding.id);
    if (workflow) {
      store.deletePlanWorkflow(workflow.workflowId);
    }
    const ext = store.getSessionExt(binding.codepilotSessionId);
    const runtime = ext?.runtime || 'claude';
    const session = store.createRuntimeSession({
      runtime,
      model: binding.model,
      cwd: binding.workingDirectory,
    });
    store.upsertChannelBinding({
      channelType: this.channelType,
      channelInstanceId: this.profileId,
      chatId: address.chatId,
      codepilotSessionId: session.id,
      workingDirectory: binding.workingDirectory,
      model: binding.model,
    });
    const updated = store.getChannelBinding(this.channelType, address.chatId, this.profileId);
    if (updated) {
      store.updateChannelBinding(updated.id, { mode: binding.mode, sdkSessionId: '' });
    }
    await this.syncChatName(address.chatId);
    const replyText = `已重置当前群会话，runtime 保持为 ${runtime}。`;
    await this.sendAsPost(address, replyText, replyToMessageId);
    appendLocalCommandExchange(
      store,
      session.id,
      '/reset',
      `Bridge 已重置当前群会话，runtime 保持为 ${runtime}，旧上下文已清空。`,
    );
  }

  private handlePermissionCommand(chatId: string, text: string, messageId?: string): boolean {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 3) return false;
    const action = parts[1].toLowerCase();
    if (action !== 'allow' && action !== 'allow_session' && action !== 'deny') return false;
    const permissionRequestId = parts.slice(2).join(' ');
    return handlePermissionCallback(`perm:${action}:${permissionRequestId}`, chatId, messageId, {
      channelType: this.channelType,
      channelInstanceId: this.profileId,
    });
  }

  private async handleModeCommand(bindingId: string, text: string, address: ChannelAddress, replyToMessageId?: string): Promise<void> {
    const store = this.getStore();
    const binding = this.findBindingById(bindingId);
    if (!binding) {
      await this.sendAsPost(address, '当前群尚未绑定会话。', replyToMessageId);
      return;
    }
    const runtime = store.getSessionExt(binding.codepilotSessionId)?.runtime || 'claude';
    if (runtime === 'claude') {
      await this.sendClaudeModeCard(address, 'switch', replyToMessageId, {
        selectedMode: resolveClaudeBindingMode(binding),
        bindingId: binding.id,
      });
      this.appendBindingCommandExchange(binding, text, 'Bridge 已打开 Claude mode 选择卡，等待用户确认新的 mode。');
      return;
    }
    const parts = text.trim().split(/\s+/);
    const mode = parts[1]?.toLowerCase() || '';
    if (!validateMode(mode)) {
      await this.sendAsPost(address, '用法：`/mode plan|code|ask`。', replyToMessageId);
      return;
    }
    if (runtime === 'codex' && mode === 'plan') {
      const llm = getBridgeContext().llm as MultiplexLLMProvider & {
        ensureCodexNativePlanAvailable?: () => Promise<void>;
      };
      try {
        await llm.ensureCodexNativePlanAvailable?.();
      } catch (error) {
        await this.sendAsPost(
          address,
          `当前本地 Codex 不支持原生 plan：${error instanceof Error ? error.message : String(error)}`,
          replyToMessageId,
        );
        return;
      }
    }
    const workflow = store.getActivePlanWorkflowByBinding(bindingId);
    if (workflow) {
      store.deletePlanWorkflow(workflow.workflowId);
    }
    store.updateChannelBinding(bindingId, { mode });
    await this.syncChatName(address.chatId);
    const replyText = `已切换到 ${mode} 模式。`;
    await this.sendAsPost(address, replyText, replyToMessageId);
    this.appendBindingCommandExchange(binding, text, `Bridge 已将当前群会话切换到 ${mode} 模式。`);
  }

  private async handlePlanCommand(bindingId: string, inbound: InboundMessage): Promise<void> {
    const store = this.getStore();
    const binding = Array.from(store.listChannelBindings(this.channelType)).find((item) => item.id === bindingId);
    if (!binding) {
      await this.sendAsPost(inbound.address, '当前群尚未绑定会话。', inbound.messageId);
      return;
    }
    const runtime = store.getSessionExt(binding.codepilotSessionId)?.runtime || 'claude';
    const existing = store.getActivePlanWorkflowByBinding(bindingId);
    if (existing) {
      const replyText = runtime === 'codex'
        ? existing.status === 'awaiting_confirmation'
          ? '当前群已有待确认的原生 PLAN 结果。请点击上一张计划卡片中的“是，实施此计划”，或直接在原线程回复告诉 Codex 如何调整；也可以使用 `/mode ...` / `/reset` 覆盖。'
          : '当前群已有等待中的原生 PLAN 请求。请先在原线程继续输入，或使用 `/mode ...` / `/reset` 覆盖。'
        : existing.status === 'awaiting_confirmation'
          ? '当前群已有待确认的 Claude PLAN 结果。请点击上一张计划卡片中的执行选项，或直接在原线程回复告诉 Claude 如何调整；也可以使用 `/mode ...` / `/reset` 覆盖。'
          : '当前群已有进行中的 Claude PLAN 流程。请先在原线程继续输入，或使用 `/mode ...` / `/reset` 覆盖。';
      await this.sendAsPost(
        inbound.address,
        replyText,
        inbound.messageId,
      );
      this.appendBindingCommandExchange(binding, inbound.text, replyText);
      return;
    }

    const requestText = inbound.text.trim().slice('/plan'.length).trim();
    if (runtime === 'codex') {
      const llm = getBridgeContext().llm as MultiplexLLMProvider & {
        ensureCodexNativePlanAvailable?: () => Promise<void>;
      };
      try {
        await llm.ensureCodexNativePlanAvailable?.();
      } catch (error) {
        await this.sendAsPost(
          inbound.address,
          `当前本地 Codex 不支持原生 plan：${error instanceof Error ? error.message : String(error)}`,
          inbound.messageId,
        );
        return;
      }
      if (!requestText) {
        store.upsertPlanWorkflow({
          bindingId,
          channelType: this.channelType,
          channelInstanceId: this.profileId,
          chatId: inbound.address.chatId,
          codepilotSessionId: binding.codepilotSessionId,
          status: 'awaiting_input',
          previousMode: binding.mode,
          requestText: '',
          address: inbound.address,
          routeKey: routeKeyForAddress(inbound.address),
          requestMessageId: inbound.messageId,
          resolved: true,
        });
        await this.syncChatName(inbound.address.chatId);
        const replyText = '已进入原生 PLAN 流程。下一条同线程消息将作为 plan 请求发送给 Codex。';
        await this.sendAsPost(inbound.address, replyText, inbound.messageId);
        this.appendBindingCommandExchange(binding, inbound.text, 'Bridge 已进入 Codex 原生 PLAN 流程，下一条同线程消息会作为 plan 请求发送。');
        return;
      }
      const workflow = store.upsertPlanWorkflow({
        bindingId,
        channelType: this.channelType,
        channelInstanceId: this.profileId,
        chatId: inbound.address.chatId,
        codepilotSessionId: binding.codepilotSessionId,
        status: 'planning',
        previousMode: binding.mode,
        requestText,
        address: inbound.address,
        routeKey: routeKeyForAddress(inbound.address),
        requestMessageId: inbound.messageId,
        resolved: true,
      });
      await this.syncChatName(inbound.address.chatId);
      this.enqueue(this.buildNativePlanRequestInbound(
        inbound.address,
        inbound.messageId,
        workflow.workflowId,
        requestText,
        inbound.attachments,
      ));
      return;
    }

    const workflow = store.upsertPlanWorkflow({
      bindingId,
      channelType: this.channelType,
      channelInstanceId: this.profileId,
      chatId: inbound.address.chatId,
      codepilotSessionId: binding.codepilotSessionId,
      status: requestText ? 'planning' : 'awaiting_input',
      previousMode: binding.mode,
      requestText,
      address: inbound.address,
      routeKey: routeKeyForAddress(inbound.address),
      requestMessageId: inbound.messageId,
      resolved: true,
    });
    await this.syncChatName(inbound.address.chatId);

    if (!requestText) {
      const replyText = '已进入 PLAN 流程。下一条非命令消息将作为规划需求。';
      await this.sendAsPost(inbound.address, replyText, inbound.messageId);
      this.appendBindingCommandExchange(binding, inbound.text, 'Bridge 已进入 Claude PLAN 流程，下一条非命令消息会作为规划需求发送。');
      return;
    }

    this.enqueue(this.buildPlanRequestInbound(
      inbound.address,
      inbound.messageId,
      workflow.workflowId,
      requestText,
      {
        attachments: inbound.attachments,
      },
    ));
  }

  private async handlePlanWorkflowMessage(bindingId: string, workflowId: string, inbound: InboundMessage): Promise<boolean> {
    const store = this.getStore();
    const workflow = store.getPlanWorkflow(workflowId);
    if (!workflow) return false;
    if (workflow.channelInstanceId !== this.profileId) return false;
    const binding = Array.from(store.listChannelBindings(this.channelType))
      .find((item) => item.channelInstanceId === this.profileId && item.id === bindingId);
    const runtime = binding ? (store.getSessionExt(binding.codepilotSessionId)?.runtime || 'claude') : 'claude';
    const routeKey = routeKeyForAddress(inbound.address);
    if (workflow.routeKey !== routeKey) {
      await this.sendAsPost(
        inbound.address,
        '当前 PLAN 流程已在另一条线程中进行，请回原线程继续或先取消。',
        inbound.messageId,
      );
      return true;
    }
    if (workflow.bindingId !== bindingId) return false;

    switch (workflow.status) {
      case 'awaiting_input':
        if (runtime === 'codex') {
          store.updatePlanWorkflow(workflow.workflowId, {
            status: 'planning',
            requestText: inbound.text.trim(),
            address: inbound.address,
            routeKey,
            requestMessageId: inbound.messageId,
            resolved: true,
          });
          this.enqueue(this.buildNativePlanRequestInbound(
            inbound.address,
            inbound.messageId,
            workflow.workflowId,
            inbound.text.trim(),
            inbound.attachments,
          ));
          return true;
        }
        store.updatePlanWorkflow(workflow.workflowId, {
          status: 'planning',
          requestText: inbound.text.trim(),
          address: inbound.address,
          routeKey,
          requestMessageId: inbound.messageId,
          planMessageId: '',
          actionCardMessageId: '',
          resolved: true,
        });
        this.enqueue(this.buildPlanRequestInbound(
          inbound.address,
          inbound.messageId,
          workflow.workflowId,
          inbound.text.trim(),
          {
            attachments: inbound.attachments,
          },
        ));
        return true;
      case 'planning':
        await this.sendAsPost(inbound.address, '当前 PLAN 请求正在处理中，请等待本轮计划完成。', inbound.messageId);
        return true;
      case 'awaiting_confirmation':
        if (runtime === 'codex') {
          const requestText = inbound.text.trim();
          store.updatePlanWorkflow(workflow.workflowId, {
            status: 'planning',
            requestText,
            address: inbound.address,
            routeKey,
            requestMessageId: inbound.messageId,
            actionCardMessageId: '',
            actionCardOpenMessageId: '',
            resolved: true,
          });
          this.enqueue(this.buildNativePlanRequestInbound(
            inbound.address,
            inbound.messageId,
            workflow.workflowId,
            requestText,
            inbound.attachments,
          ));
          return true;
        }
        {
          const requestText = inbound.text.trim();
          console.log(
            `[feishu-adapter] Claude PLAN follow-up reply captured for workflow ${workflow.workflowId}; ` +
            'stopping pending ExitPlanMode and enqueueing a fresh planning turn',
          );
          store.updatePlanWorkflow(workflow.workflowId, {
            status: 'planning',
            requestText,
            address: inbound.address,
            routeKey,
            requestMessageId: inbound.messageId,
            actionCardMessageId: '',
            actionCardOpenMessageId: '',
            approvalRequestId: '',
            resolved: true,
          });
          if (workflow.approvalRequestId) {
            getBridgeContext().permissions.resolvePendingPermission?.(workflow.approvalRequestId, {
              behavior: 'deny',
              message: CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE,
              interrupt: true,
            });
          }
          this.enqueue(this.buildPlanRequestInbound(
            inbound.address,
            inbound.messageId,
            workflow.workflowId,
            requestText,
            {
              promptText: buildClaudePlanFollowUpPrompt(requestText, {
                planText: workflow.planText,
                planFilePath: workflow.planFilePath,
              }),
              attachments: inbound.attachments,
            },
          ));
        }
        return true;
      default:
        return false;
    }
  }

  private buildPlanRequestInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      promptText?: string;
      attachments?: FileAttachment[];
    },
  ): InboundMessage {
    return {
      messageId,
      address,
      text: requestText,
      timestamp: Date.now(),
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId,
          promptText: options?.promptText || buildPlanningPrompt(requestText),
          storedUserText: requestText,
          permissionMode: 'plan',
        },
      },
    };
  }

  private buildNativePlanRequestInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    attachments?: FileAttachment[],
  ): InboundMessage {
    return {
      messageId,
      address,
      text: requestText,
      timestamp: Date.now(),
      ...(attachments?.length ? { attachments } : {}),
      bridgeMeta: {
        planWorkflow: {
          kind: 'native_plan_request',
          workflowId,
          promptText: requestText,
          storedUserText: requestText,
          permissionMode: 'plan',
          collaborationMode: 'plan',
        },
      },
    };
  }

  private buildPlanExecutionInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
      planText?: string;
    },
  ): InboundMessage {
    const storedUserText = `执行已确认计划：${requestText}`;
    return {
      messageId,
      address,
      text: storedUserText,
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_execute',
          workflowId,
          promptText: buildClaudePlanExecutionPrompt(requestText, options?.planText),
          storedUserText,
          permissionMode: options?.permissionMode || 'acceptEdits',
          collaborationMode: 'default',
        },
      },
    };
  }

  private async handleClaudeModeCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const parts = callbackData.split(':');
    const scope = parts[1];
    const bindingId = scope === 'switch' ? parts[2] : '';
    const rawMode = scope === 'switch' ? parts[3] : parts[2];
    const mode = normalizeClaudePermissionMode(rawMode);
    if (!mode || (scope !== 'new' && scope !== 'switch')) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }

    const actionMessageId = resolveActionOpenMessageId(event);

    if (scope === 'new') {
      const sender = this.extractActionSenderIdentity(event);
      if (!sender) {
        return { toast: { type: 'warning', content: '无法识别当前操作人' } };
      }
      const cwd = this.resolveSelectedWorkdir(event.action?.form_value as Record<string, unknown> | undefined);
      try {
        await this.createBoundSession('claude', sender, {
          claudePermissionMode: mode,
          cwd,
        });
        await this.patchActionCardSafely(
          undefined,
          buildStatusCard(
            'Claude 会话已创建',
            `工作区：\`${cwd}\`\n\n当前 mode：**${getClaudeModeTitle(mode)}**。\n\n请直接进入新群继续对话。`,
            'green',
          ),
          'claude-mode',
          actionMessageId,
        );
        return { toast: { type: 'success', content: `已创建 ${getClaudeModeTitle(mode)} 会话` } };
      } catch (error) {
        console.error('[feishu-adapter] Failed to create Claude session from mode card:', error);
        return {
          toast: {
            type: 'warning',
            content: `创建会话失败：${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    }

    const binding = bindingId ? this.findBindingById(bindingId) : null;
    if (!binding) {
      return { toast: { type: 'warning', content: '当前群尚未绑定会话' } };
    }
    const runtime = this.getStore().getSessionExt(binding.codepilotSessionId)?.runtime || 'claude';
    if (runtime !== 'claude') {
      return { toast: { type: 'warning', content: '当前群不是 Claude 会话' } };
    }

    const currentMode = resolveClaudeBindingMode(binding);
    if (currentMode !== mode) {
      this.getStore().updateChannelBinding(binding.id, {
        claudePermissionMode: mode,
        mode: 'code',
      });
      await this.syncChatName(binding.chatId);
    }
    await this.patchActionCardSafely(
      undefined,
      buildClaudeModeCard('switch', {
        selectedMode: mode,
        bindingId: binding.id,
        note: `已切换到 **${getClaudeModeTitle(mode)}**。`,
      }),
      'claude-mode',
      actionMessageId,
    );
    return {
      toast: {
        type: 'success',
        content: currentMode === mode
          ? `当前已是 ${getClaudeModeTitle(mode)}`
          : `已切换到 ${getClaudeModeTitle(mode)}`,
      },
    };
  }

  private async handleStructuredInputCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const [, action, requestId, questionId] = callbackData.split(':');
    if (!requestId) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    const store = this.getStore();
    const request = store.getStructuredInputRequest(requestId);
    if (!request || request.channelInstanceId !== this.profileId) {
      return { toast: { type: 'warning', content: '问答请求不存在或已失效' } };
    }

    const actionMessageId = event.open_message_id || event.context?.open_message_id || '';
    const knownIds = [request.messageId, request.openMessageId].filter((value): value is string => !!value);
    if (knownIds.length > 1 && !knownIds.includes(actionMessageId)) {
      return { toast: { type: 'warning', content: '问答卡已过期' } };
    }

    if (action === 'field' && questionId) {
      const selected = collectTextFragments(event.action?.option);
      if (selected.length === 0) {
        return { toast: { type: 'warning', content: '未读取到所选项' } };
      }
      const nextDraftAnswers = extractStructuredAnswers(
        {
          requestId: request.requestId,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          questions: request.questions,
        },
        undefined,
        {
          ...(request.draftAnswers || {}),
          [questionId]: { answers: selected },
        },
      ).answers;
      store.updateStructuredInputRequest(requestId, { draftAnswers: nextDraftAnswers });
      return { toast: { type: 'success', content: '已记录选择，填写完成后点击提交。' } };
    }

    if (action !== 'submit') {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }

    const hasSecret = request.questions.some((question) => question.isSecret);
    if (hasSecret) {
      if (!store.markStructuredInputRequestResolved(requestId)) {
        return { toast: { type: 'warning', content: '问答已经提交过了' } };
      }
      setImmediate(() => {
        void this.resolveStructuredInputRequest(requestId);
        getBridgeContext().permissions.resolvePendingStructuredInput?.(requestId, { answers: {} });
      });
      return { toast: { type: 'warning', content: '该问题涉及敏感输入，请转到本地命令行继续' } };
    }

    const answers = extractStructuredAnswers(
      request,
      ((event.action?.form_value || event.action?.value) as Record<string, unknown> | undefined),
      request.draftAnswers,
    );
    const hasAnswers = Object.keys(answers.answers).length > 0;
    if (!hasAnswers) {
      return { toast: { type: 'warning', content: '请至少填写一个答案' } };
    }

    store.updateStructuredInputRequest(requestId, { draftAnswers: answers.answers });

    if (!store.markStructuredInputRequestResolved(requestId)) {
      return { toast: { type: 'warning', content: '问答已经提交过了' } };
    }

    setImmediate(() => {
      const resolved = getBridgeContext().permissions.resolvePendingStructuredInput?.(requestId, answers);
      if (!resolved) {
        store.updateStructuredInputRequest(requestId, { resolved: false });
        return;
      }
      void this.resolveStructuredInputRequest(requestId);
    });

    return { toast: { type: 'success', content: '答案已提交' } };
  }

  private async handlePlanCardAction(
    event: lark.InteractiveCardActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const [, action, workflowId] = callbackData.split(':');
    if (!workflowId || !action) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
    const store = this.getStore();
    const workflow = store.getPlanWorkflow(workflowId);
    if (!workflow || workflow.channelInstanceId !== this.profileId) {
      return { toast: { type: 'warning', content: 'PLAN workflow not found' } };
    }
    const actionMessageId = resolveActionOpenMessageId(event as StructuredActionEvent);
    const knownIds = [
      workflow.actionCardMessageId,
      workflow.actionCardOpenMessageId,
    ].filter((value): value is string => !!value);
    if (knownIds.length > 1 && !knownIds.includes(actionMessageId)) {
      return { toast: { type: 'warning', content: 'PLAN card is stale' } };
    }
    if (workflow.status !== 'awaiting_confirmation') {
      return { toast: { type: 'warning', content: 'PLAN workflow is no longer waiting for confirmation' } };
    }
    if (!store.markPlanWorkflowResolved(workflowId)) {
      return { toast: { type: 'warning', content: 'PLAN action already handled' } };
    }

    const binding = store.getChannelBinding(this.channelType, workflow.chatId, workflow.channelInstanceId);
    switch (action) {
      case 'execute':
        await this.patchActionCardSafely(
          workflow.actionCardMessageId,
          buildHandledPlanCard(action),
          'plan',
          actionMessageId || workflow.actionCardOpenMessageId,
        );
        if (binding) {
          store.updateChannelBinding(binding.id, { mode: 'code' });
        }
        store.deletePlanWorkflow(workflowId);
        await this.syncChatName(workflow.chatId);
        this.enqueue(this.buildPlanExecutionInbound(
          workflow.address,
          workflow.requestMessageId || workflow.planMessageId || workflow.actionCardMessageId || workflow.workflowId,
          workflowId,
          workflow.requestText,
        ));
        return { toast: { type: 'success', content: '开始执行已确认计划' } };
      case 'continue':
        await this.patchActionCardSafely(
          workflow.actionCardMessageId,
          buildHandledPlanCard(action),
          'plan',
          actionMessageId || workflow.actionCardOpenMessageId,
        );
        store.updatePlanWorkflow(workflowId, {
          status: 'awaiting_input',
          resolved: true,
        });
        await this.syncChatName(workflow.chatId);
        return { toast: { type: 'success', content: '继续保持 PLAN 模式' } };
      case 'cancel':
        await this.patchActionCardSafely(
          workflow.actionCardMessageId,
          buildHandledPlanCard(action),
          'plan',
          actionMessageId || workflow.actionCardOpenMessageId,
        );
        if (binding) {
          store.updateChannelBinding(binding.id, { mode: workflow.previousMode });
        }
        store.deletePlanWorkflow(workflowId);
        await this.syncChatName(workflow.chatId);
        return { toast: { type: 'success', content: '已取消 PLAN 流程' } };
      default:
        store.updatePlanWorkflow(workflowId, { resolved: false });
        return { toast: { type: 'warning', content: 'Unsupported action' } };
    }
  }

  private async handleClaudePlanExitCardAction(
    event: lark.InteractiveCardActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const parts = callbackData.split(':');
    const action = parts[1];
    const variant = parts[2];
    const workflowId = parts.slice(3).join(':') || parts.slice(2).join(':');
    if (!workflowId || !action) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }

    const store = this.getStore();
    const workflow = store.getPlanWorkflow(workflowId);
    if (!workflow || workflow.channelInstanceId !== this.profileId) {
      return { toast: { type: 'warning', content: 'Claude plan workflow not found' } };
    }

    const actionMessageId = resolveActionOpenMessageId(event as StructuredActionEvent);
    const knownIds = [
      workflow.actionCardMessageId,
      workflow.actionCardOpenMessageId,
    ].filter((value): value is string => !!value);
    if (knownIds.length > 1 && !knownIds.includes(actionMessageId)) {
      return { toast: { type: 'warning', content: 'Claude plan card is stale' } };
    }
    if (workflow.status !== 'awaiting_confirmation') {
      return { toast: { type: 'warning', content: 'Claude plan is no longer waiting for confirmation' } };
    }
    if (!store.markPlanWorkflowResolved(workflowId)) {
      return { toast: { type: 'warning', content: 'Claude plan action already handled' } };
    }

    const binding = store.getChannelBinding(this.channelType, workflow.chatId, workflow.channelInstanceId);
    const allowedPrompts = workflow.allowedPrompts || [];
    const approvalRequestId = workflow.approvalRequestId?.trim() || '';

    const resolvePermission = (
      resolution: Parameters<typeof getBridgeContext> extends never
        ? never
        : {
            behavior: 'allow' | 'deny';
            message?: string;
            updatedPermissions?: unknown[];
            interrupt?: boolean;
          },
    ): boolean => approvalRequestId
      ? getBridgeContext().permissions.resolvePendingPermission(approvalRequestId, resolution)
      : false;

    if (action === 'approve' && (variant === 'manual' || variant === 'bypass')) {
      if (!binding) {
        store.updatePlanWorkflow(workflowId, { resolved: false });
        return { toast: { type: 'warning', content: '会话绑定不存在' } };
      }
      await this.patchActionCardSafely(
        workflow.actionCardMessageId,
        buildHandledClaudePlanExitCard(
          workflow.planText || '',
          workflow.allowedPrompts || [],
          true,
          action,
          variant,
        ),
        'claude-plan',
        actionMessageId || workflow.actionCardOpenMessageId,
      );
      if (binding) {
        store.updateChannelBinding(binding.id, {
          mode: 'code',
          claudePermissionMode: variant === 'bypass' ? 'bypassPermissions' : 'default',
        });
      }
      store.deletePlanWorkflow(workflowId);
      await this.syncChatName(workflow.chatId);
      const resolved = resolvePermission({
        behavior: 'allow',
        updatedPermissions: buildClaudePlanModeUpdates(
          variant === 'bypass' ? 'bypassPermissions' : 'default',
          allowedPrompts,
        ),
      });
      if (!resolved) {
        this.enqueue(this.buildPlanExecutionInbound(
          workflow.address,
          workflow.requestMessageId || workflow.planMessageId || workflow.actionCardMessageId || workflow.workflowId,
          workflowId,
          workflow.requestText,
          {
            permissionMode: variant === 'bypass' ? 'bypassPermissions' : 'default',
            planText: workflow.planText,
          },
        ));
      }
      return {
        toast: {
          type: 'success',
          content: variant === 'bypass' ? '开始执行，后续权限将自动放行' : '开始执行，后续编辑仍需人工审批',
        },
      };
    }

    if (action === 'clear' && variant === 'bypass') {
      if (!binding) {
        store.updatePlanWorkflow(workflowId, { resolved: false });
        return { toast: { type: 'warning', content: '会话绑定不存在' } };
      }
      await this.patchActionCardSafely(
        workflow.actionCardMessageId,
        buildHandledClaudePlanExitCard(
          workflow.planText || '',
          workflow.allowedPrompts || [],
          true,
          action,
          variant,
        ),
        'claude-plan',
        actionMessageId || workflow.actionCardOpenMessageId,
      );

      const session = store.createRuntimeSession({
        runtime: 'claude',
        model: binding.model,
        cwd: binding.workingDirectory,
      });
      store.upsertChannelBinding({
        channelType: this.channelType,
        channelInstanceId: this.profileId,
        chatId: workflow.chatId,
        codepilotSessionId: session.id,
        workingDirectory: binding.workingDirectory,
        model: binding.model,
      });
      const updatedBinding = store.getChannelBinding(this.channelType, workflow.chatId, this.profileId);
      if (updatedBinding) {
        store.updateChannelBinding(updatedBinding.id, {
          mode: 'code',
          claudePermissionMode: 'bypassPermissions',
          sdkSessionId: '',
        });
      }
      store.deletePlanWorkflow(workflowId);
      await this.syncChatName(workflow.chatId);

      if (approvalRequestId) {
        resolvePermission({
          behavior: 'deny',
          message: 'The user approved the plan but wants execution to restart in a fresh session with cleared context. Stop planning here.',
          interrupt: true,
        });
      }

      this.enqueue(this.buildPlanExecutionInbound(
        workflow.address,
        workflow.requestMessageId || workflow.planMessageId || workflow.actionCardMessageId || workflow.workflowId,
        workflowId,
        workflow.requestText,
        {
          permissionMode: 'bypassPermissions',
          planText: workflow.planText,
        },
      ));
      return { toast: { type: 'success', content: '已清空上下文，并在新会话中开始执行' } };
    }

    store.updatePlanWorkflow(workflowId, { resolved: false });
    return { toast: { type: 'warning', content: 'Unsupported action' } };
  }

  private async createSessionGroup(
    runtime: RuntimeName,
    sender: SenderIdentity,
    claudePermissionMode?: ClaudePermissionMode,
  ): Promise<string> {
    if (!this.restClient) throw new Error('Feishu client not initialized');
    const response = await this.restClient.im.chat.create({
      params: {
        user_id_type: sender.type,
        set_bot_manager: true,
      },
      data: {
        name: defaultChatName(runtime, claudePermissionMode),
        chat_mode: 'group',
        chat_type: 'private',
        group_message_type: 'chat',
        user_id_list: [sender.id],
      },
    });
    assertLarkOk(response, 'im.chat.create');
    const chatId = response.data?.chat_id;
    if (!chatId) throw new Error('Create group succeeded without chat_id');
    return chatId;
  }

  private async maybeRenameChat(chatId: string): Promise<void> {
    if (!this.restClient || this.pendingTitles.has(chatId)) return;
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId);
    if (!binding) return;
    const ext = store.getSessionExt(binding.codepilotSessionId);
    if (!ext || ext.titleStatus === 'done' || ext.titleStatus === 'running') return;
    const { messages } = store.getMessages(binding.codepilotSessionId);
    const firstUser = messages.find((message) => message.role === 'user');
    const firstAssistant = messages.find((message) => message.role === 'assistant');
    if (!firstUser || !firstAssistant) return;

    this.pendingTitles.add(chatId);
    store.updateSessionExt(binding.codepilotSessionId, { titleStatus: 'running' });

    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      generateTitle?: (sessionId: string, userText: string, assistantText: string) => Promise<string | null>;
    };
    const fallbackTitle = sanitizeTitleFallback(firstUser.content);

    try {
      const generated = await llm.generateTitle?.(binding.codepilotSessionId, firstUser.content, firstAssistant.content);
      const title = generated || fallbackTitle;
      store.updateSessionExt(binding.codepilotSessionId, {
        title,
        titleStatus: 'done',
      });
      await this.syncChatName(chatId);
    } catch (error) {
      console.warn('[feishu-adapter] Failed to rename chat:', error);
      store.updateSessionExt(binding.codepilotSessionId, {
        title: fallbackTitle,
        titleStatus: 'failed',
      });
      await this.syncChatName(chatId);
    } finally {
      this.pendingTitles.delete(chatId);
    }
  }

  private shouldDecoratePlan(bindingId: string, mode: 'code' | 'plan' | 'ask'): boolean {
    if (mode === 'plan') return true;
    return !!this.getStore().getActivePlanWorkflowByBinding(bindingId);
  }

  private computeChatDisplayName(chatId: string): string | null {
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId);
    if (!binding) return null;
    const ext = store.getSessionExt(binding.codepilotSessionId);
    if (ext?.displayNameMode === 'native_locked' && ext.title) {
      return ext.title;
    }
    const runtime = ext?.runtime || 'claude';
    const baseName = stripClaudeModeSuffix(ext?.title || defaultChatName(runtime));
    if (runtime === 'claude') {
      return `${baseName}${getClaudeModeSuffix(resolveClaudeBindingMode(binding))}`;
    }
    if (!this.shouldDecoratePlan(binding.id, binding.mode)) {
      return baseName;
    }
    return `${baseName}${PLAN_SUFFIX}`;
  }

  private async syncChatName(chatId: string): Promise<void> {
    if (!this.restClient) return;
    const chatApi = this.restClient.im?.chat;
    if (!chatApi?.update) return;
    const name = this.computeChatDisplayName(chatId);
    if (!name) return;
    try {
      const response = await chatApi.update({
        path: { chat_id: chatId },
        data: { name },
      });
      assertLarkOk(response, 'im.chat.update');
    } catch (error) {
      console.warn('[feishu-adapter] Failed to sync chat name:', error);
    }
  }

  private async createPreviewArtifact(address: ChannelAddress, draftId: number, text: string): Promise<PreviewArtifact | null> {
    if (!this.restClient) return null;
    const routeKey = routeKeyForAddress(address);
    const replyToMessageId = this.lastIncomingMessageId.get(routeKey);
    try {
      const createResponse = await this.restClient.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(buildStreamingCardSkeleton()),
        },
      });
      assertLarkOk(createResponse, 'cardkit.card.create');
      const cardId = createResponse.data?.card_id;
      if (!cardId) throw new Error('CardKit create succeeded without card_id');
      const sendResponse = await this.sendLarkMessage(
        address,
        'interactive',
        JSON.stringify({
          type: 'card',
          data: { card_id: cardId },
        }),
        replyToMessageId,
      );
      assertLarkOk(sendResponse, 'im.message.sendCardByCardId');
      const messageId = sendResponse.data?.message_id;
      if (!messageId) throw new Error('CardKit send succeeded without message_id');
      return {
        key: previewKey(routeKey, draftId),
        routeKey,
        chatId: address.chatId,
        draftId,
        replyToMessageId,
        messageId,
        cardId,
        lastText: text,
        sequence: 0,
        mode: 'cardkit',
      };
    } catch (error) {
      console.warn('[feishu-adapter] CardKit preview unavailable, falling back to message patch:', error);
      try {
        const fallbackText = text.trim() ? text : STREAM_PLACEHOLDER_TEXT;
        const sendResult = await this.sendInteractiveCard(address, buildSimpleCard(fallbackText), replyToMessageId);
        return {
          key: previewKey(routeKey, draftId),
          routeKey,
          chatId: address.chatId,
          draftId,
          replyToMessageId,
          messageId: sendResult.messageId,
          lastText: text,
          sequence: 0,
          mode: 'patch',
        };
      } catch (fallbackError) {
        console.warn('[feishu-adapter] Preview fallback failed:', fallbackError);
        return null;
      }
    }
  }

  private extractSenderIdentity(data: FeishuMessageEventData): SenderIdentity | null {
    const senderId = data.sender.sender_id;
    if (senderId?.open_id) return { id: senderId.open_id, type: 'open_id' };
    if (senderId?.user_id) return { id: senderId.user_id, type: 'user_id' };
    if (senderId?.union_id) return { id: senderId.union_id, type: 'union_id' };
    return null;
  }

  private getClientConfig(): { appId: string; appSecret: string; domain: lark.Domain } {
    const store = this.tryGetStore();
    const appId = this.options.profile.appId || store?.getSetting('bridge_feishu_app_id') || '';
    const appSecret = this.options.profile.appSecret || store?.getSetting('bridge_feishu_app_secret') || '';
    const domain = (this.options.profile.domain || store?.getSetting('bridge_feishu_domain') || '') === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;
    return { appId, appSecret, domain };
  }

  private tryGetStore(): JsonFileStore | null {
    try {
      return getBridgeContext().store as JsonFileStore;
    } catch {
      return null;
    }
  }

  private getStore(): JsonFileStore {
    return getBridgeContext().store as JsonFileStore;
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  private async enqueueChatTask(chatId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chatQueues.get(chatId) || Promise.resolve();
    const next = previous.then(task, task);
    this.chatQueues.set(chatId, next);
    try {
      await next;
    } finally {
      if (this.chatQueues.get(chatId) === next) {
        this.chatQueues.delete(chatId);
      }
    }
  }

  private async sendPermissionCard(
    address: ChannelAddress,
    text: string,
    buttons: NonNullable<OutboundMessage['inlineButtons']>,
    replyToMessageId?: string,
    cardHeader?: OutboundMessage['cardHeader'],
  ): Promise<SendResult> {
    const card = cardHeader
      ? buildActionCard(cardHeader.title, text, buttons, cardHeader.template || 'blue')
      : buildPermissionCard(text, buttons);
    const result = await this.sendInteractiveCard(address, card, replyToMessageId);
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private async sendAsInteractiveCard(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult> {
    const content = buildCardContent(text);
    const response = await this.sendLarkMessage(this.withInstance(address), 'interactive', content, replyToMessageId);
    assertLarkOk(response, 'im.message.sendInteractive');
    return {
      ok: true,
      messageId: response.data?.message_id,
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private async sendAsPost(address: ChannelAddress, text: string, replyToMessageId?: string): Promise<SendResult> {
    const content = buildPostContent(text);
    const response = await this.sendLarkMessage(this.withInstance(address), 'post', content, replyToMessageId);
    assertLarkOk(response, 'im.message.sendPost');
    return {
      ok: true,
      messageId: response.data?.message_id,
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private async sendInteractiveCard(
    address: ChannelAddress,
    card: Record<string, unknown> | lark.InteractiveCard,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<{ messageId: string; openMessageId?: string }> {
    const response = await this.sendLarkMessage(
      this.withInstance(address),
      'interactive',
      JSON.stringify(card),
      replyToMessageId,
      requestUuid,
    );
    assertLarkOk(response, 'im.message.sendInteractiveCard');
    return {
      messageId: response.data?.message_id || '',
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private async uploadImageFile(filePath: string): Promise<string> {
    const image = fs.readFileSync(filePath);
    const response = await this.restClient!.im.image.create({
      data: {
        image_type: 'message',
        image,
      },
    });
    const imageKey = response?.image_key;
    if (!imageKey) {
      throw new Error('Feishu image upload succeeded without image_key');
    }
    return imageKey;
  }

  private async sendLarkMessage(
    address: ChannelAddress,
    msgType: 'interactive' | 'post' | 'image',
    content: string,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<{ code?: number; msg?: string; data?: { message_id?: string; open_message_id?: string; chat_id?: string } }> {
    return this.enqueueOutboundMessage(address.chatId, async () => {
      const uuid = requestUuid || randomUUID().slice(0, 50);
      if (replyToMessageId) {
        return this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: {
            msg_type: msgType,
            content,
            uuid,
            ...(address.threadId ? { reply_in_thread: true } : {}),
          },
        });
      }
      const receiveId = address.threadId || address.chatId;
      const receiveIdType = (address.threadId ? 'thread_id' : 'chat_id') as 'thread_id' | 'chat_id';
      return this.restClient!.im.message.create({
        params: { receive_id_type: receiveIdType as never },
        data: {
          receive_id: receiveId,
          msg_type: msgType,
          content,
          uuid,
        },
      });
    });
  }

  private async enqueueOutboundMessage<T>(
    chatId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.outboundMessageQueues.get(chatId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => {}).then(() => current);
    this.outboundMessageQueues.set(chatId, queued);

    await previous.catch(() => {});
    try {
      const lastSentAt = this.lastOutboundMessageAt.get(chatId) || 0;
      const elapsed = Date.now() - lastSentAt;
      const minIntervalMs = 250;
      if (elapsed < minIntervalMs) {
        await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
      }
      const result = await task();
      this.lastOutboundMessageAt.set(chatId, Date.now());
      return result;
    } finally {
      release();
      const pending = this.outboundMessageQueues.get(chatId);
      if (pending === queued) {
        this.outboundMessageQueues.delete(chatId);
      }
    }
  }

  private async patchInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
    options?: { messageIdType?: 'message_id' | 'open_message_id' },
  ): Promise<void> {
    const response = await (this.restClient!.im.message as {
      patch: (payload: {
        path: { message_id: string };
        data: { content: string };
        params?: { message_id_type: 'open_message_id' };
      }) => Promise<{ code?: number; msg?: string }>;
    }).patch({
      path: { message_id: messageId },
      ...(options?.messageIdType === 'open_message_id'
        ? { params: { message_id_type: 'open_message_id' as const } }
        : {}),
      data: {
        content: JSON.stringify(card),
      },
    });
    assertLarkOk(response, 'im.message.patch');
  }

  private async deleteMessageQuietly(messageId: string): Promise<void> {
    const messageApi = this.restClient?.im?.message as {
      delete?: (payload: { path: { message_id: string } }) => Promise<{ code?: number; msg?: string }>;
    } | undefined;
    if (!messageApi?.delete) return;
    try {
      const response = await messageApi.delete({
        path: { message_id: messageId },
      });
      assertLarkOk(response, 'im.message.delete');
    } catch (error) {
      console.warn('[feishu-adapter] Failed to delete stale preview placeholder:', error);
    }
  }

  private async runScopeDiagnostic(): Promise<void> {
    if (!this.restClient) return;
    try {
      const client = this.restClient as unknown as {
        request?: (payload: { method: string; url: string; params?: Record<string, string> }) => Promise<{
          code?: number;
          msg?: string;
          data?: { app?: { scopes?: Array<{ scope?: string }> } };
        }>;
      };
      if (!client.request) return;
      const response = await client.request({
        method: 'GET',
        url: '/open-apis/application/v6/applications/me',
        params: { lang: 'zh_cn' },
      });
      if (response.code !== 0) {
        console.warn(`[feishu-adapter] Scope diagnostic unavailable: ${response.msg || response.code}`);
        return;
      }
      const scopes = response.data?.app?.scopes?.map((item) => item.scope).filter(isNonEmptyString) || [];
      const missingScopes = findMissingAppScopes(scopes);
      console.log(`[feishu-adapter] Scope diagnostic: ${scopes.length} app scope(s) visible`);
      if (missingScopes.length > 0) {
        console.warn(
          `[feishu-adapter] Missing recommended app scopes: ${missingScopes.join(', ')}. ` +
          '消息收发、群改名、流式卡片或 typing 可能受影响。',
        );
      }
    } catch (error) {
      console.warn('[feishu-adapter] Scope diagnostic failed:', error instanceof Error ? error.message : error);
    }
  }
}
