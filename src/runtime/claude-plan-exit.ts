import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

import { buildInteractionTimeoutMarkdown } from '../bridge/interaction-timeout.js';
import { PENDING_PERMISSIONS_TIMEOUT_MS } from '../providers/claude/permission-gateway.js';

export interface ClaudePlanAllowedPrompt {
  tool: string;
  prompt: string;
}

export const CLAUDE_PLAN_EXIT_BYPASS_LABEL = 'Yes, and bypass permissions';
export const CLAUDE_PLAN_EXIT_MANUAL_LABEL = 'Yes, manually approve edits';
export const CLAUDE_PLAN_EXIT_CLEAR_BYPASS_LABEL = 'Yes, clear context and bypass permissions';

export const CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE =
  'The user wants to continue planning in a follow-up turn. Stop here without executing anything and wait for the next user message.';

export function truncateClaudePlanCardText(text: string, maxChars = 7000): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trim()}\n\n...`;
}

function buildClaudePlanExitElements(
  planText: string,
  allowedPrompts: ClaudePlanAllowedPrompt[],
  showClearContext: boolean,
  options?: {
    pending?: boolean;
  },
): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: 'Claude 已经写好计划。确认后会退出 PLAN，并按所选模式继续执行。',
    },
    {
      tag: 'markdown',
      content: truncateClaudePlanCardText(planText || 'Claude 已生成计划，请确认是否继续。'),
    },
  ];

  if (allowedPrompts.length > 0) {
    elements.push({
      tag: 'markdown',
      content: [
        '**执行时会申请的提示级权限**',
        ...allowedPrompts.map((item) => `- ${item.tool}: ${item.prompt}`),
      ].join('\n'),
    });
  }

  elements.push({
    tag: 'markdown',
    content: showClearContext
      ? '如需继续规划，请直接在本线程回复你希望 Claude 调整的地方。“清空上下文后执行”会结束当前 PLAN 会话，并用新会话按已确认计划开始实施。'
      : '如需继续规划，请直接在本线程回复你希望 Claude 调整的地方。',
  });

  if (options?.pending !== false) {
    elements.push({
      tag: 'markdown',
      content: buildInteractionTimeoutMarkdown(PENDING_PERMISSIONS_TIMEOUT_MS, '会自动拒绝'),
    });
  }

  return elements;
}

function buildClaudePlanExitCardShell(elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
      width_mode: 'fill',
    },
    header: {
      title: {
        tag: 'plain_text',
        content: '计划已就绪',
      },
      template: 'blue',
    },
    body: {
      elements,
    },
  };
}

function buildClaudePlanActionColumns(
  workflowId: string,
  showClearContext: boolean,
): Array<Record<string, unknown>> {
  const columns: Array<Record<string, unknown>> = [
    {
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          type: 'primary',
          text: { tag: 'plain_text', content: CLAUDE_PLAN_EXIT_BYPASS_LABEL },
          behaviors: [{ type: 'callback', value: { callback_data: `planexit:approve:bypass:${workflowId}` } }],
        },
      ],
    },
    {
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: CLAUDE_PLAN_EXIT_MANUAL_LABEL },
          behaviors: [{ type: 'callback', value: { callback_data: `planexit:approve:manual:${workflowId}` } }],
        },
      ],
    },
  ];

  if (showClearContext) {
    columns.push({
      tag: 'column',
      width: 'auto',
      elements: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: CLAUDE_PLAN_EXIT_CLEAR_BYPASS_LABEL },
          behaviors: [{ type: 'callback', value: { callback_data: `planexit:clear:bypass:${workflowId}` } }],
        },
      ],
    });
  }

  return columns;
}

function buildHandledClaudePlanActionColumns(
  action: string,
  variant: string,
  showClearContext: boolean,
): Array<Record<string, unknown>> {
  const makeButton = (
    label: string,
    options: {
      selected?: boolean;
    } = {},
  ): Record<string, unknown> => ({
    tag: 'button',
    type: options.selected ? 'primary' : 'default',
    text: { tag: 'plain_text', content: label },
    disabled: true,
  });

  const columns: Array<Record<string, unknown>> = [
    {
      tag: 'column',
      width: 'auto',
      elements: [
        makeButton(CLAUDE_PLAN_EXIT_BYPASS_LABEL, {
          selected: action === 'approve' && variant === 'bypass',
        }),
      ],
    },
    {
      tag: 'column',
      width: 'auto',
      elements: [
        makeButton(CLAUDE_PLAN_EXIT_MANUAL_LABEL, {
          selected: action === 'approve' && variant === 'manual',
        }),
      ],
    },
  ];

  if (showClearContext) {
    columns.push({
      tag: 'column',
      width: 'auto',
      elements: [
        makeButton(CLAUDE_PLAN_EXIT_CLEAR_BYPASS_LABEL, {
          selected: action === 'clear' && variant === 'bypass',
        }),
      ],
    });
  }

  return columns;
}

export function buildClaudePlanExitCard(
  workflowId: string,
  planText: string,
  allowedPrompts: ClaudePlanAllowedPrompt[],
  showClearContext: boolean,
): Record<string, unknown> {
  const elements = buildClaudePlanExitElements(planText, allowedPrompts, showClearContext, { pending: true });
  elements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    horizontal_align: 'left',
    columns: buildClaudePlanActionColumns(workflowId, showClearContext),
  });
  return buildClaudePlanExitCardShell(elements);
}

export function buildHandledClaudePlanExitCard(
  planText: string,
  allowedPrompts: ClaudePlanAllowedPrompt[],
  showClearContext: boolean,
  action: string,
  variant: string,
): Record<string, unknown> {
  const elements = buildClaudePlanExitElements(planText, allowedPrompts, showClearContext, { pending: false });
  elements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    horizontal_align: 'left',
    columns: buildHandledClaudePlanActionColumns(action, variant, showClearContext),
  });
  return buildClaudePlanExitCardShell(elements);
}

export function parseClaudePlanText(input: Record<string, unknown>): string {
  return typeof input.plan === 'string' ? input.plan.trim() : '';
}

export function parseClaudePlanFilePath(input: Record<string, unknown>): string {
  return typeof input.planFilePath === 'string' ? input.planFilePath.trim() : '';
}

export function parseClaudeAllowedPrompts(input: Record<string, unknown>): ClaudePlanAllowedPrompt[] {
  const raw = input.allowedPrompts;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
    .map((value) => ({
      tool: typeof value.tool === 'string' ? value.tool.trim() : '',
      prompt: typeof value.prompt === 'string' ? value.prompt.trim() : '',
    }))
    .filter((value) => value.tool && value.prompt);
}

export function buildClaudePlanModeUpdates(
  mode: 'default' | 'acceptEdits' | 'bypassPermissions',
  allowedPrompts: ClaudePlanAllowedPrompt[],
): PermissionUpdate[] {
  const updates: PermissionUpdate[] = [
    {
      type: 'setMode',
      mode,
      destination: 'session',
    },
  ];

  if (allowedPrompts.length > 0) {
    updates.push({
      type: 'addRules',
      rules: allowedPrompts.map((item) => ({
        toolName: item.tool,
        ruleContent: item.prompt,
      })),
      behavior: 'allow',
      destination: 'session',
    });
  }

  return updates;
}

export function buildClaudePlanExecutionPrompt(requestText: string, planText?: string): string {
  const lines = [
    '用户已经确认上一轮计划，现在开始实施。',
    '不要重复输出完整计划，直接执行；必要时只保留简短进度说明。',
  ];
  const normalizedPlan = planText?.trim();
  if (normalizedPlan) {
    lines.push('', '已确认计划：', normalizedPlan);
  }
  lines.push('', '原始需求如下：', requestText.trim());
  return lines.join('\n');
}

export function buildClaudePlanFollowUpPrompt(
  requestText: string,
  options?: {
    planText?: string;
    planFilePath?: string;
  },
): string {
  const lines = [
    '你仍然处于 PLAN 阶段。',
    '请基于上一轮已生成的计划文本和当前上下文，按照下面的用户反馈继续调整计划。',
    '直接输出完整的更新版计划。',
    '不要执行，不要调用工具，不要修改文件，也不要声称已经完成。',
    '不要读取、查找、编辑或依赖任何“计划文件”；如果之前提到过 planFilePath，那只是上下文提示，不是让你去操作的文件。',
  ];
  const normalizedPlan = options?.planText?.trim();
  if (normalizedPlan) {
    lines.push('', '上一轮计划如下：', normalizedPlan);
  }
  const normalizedPlanFilePath = options?.planFilePath?.trim();
  if (normalizedPlanFilePath) {
    lines.push('', `忽略任何计划文件路径（例如 \`${normalizedPlanFilePath}\`），不要尝试读取它。`);
  }
  lines.push('', '用户反馈如下：', requestText.trim());
  return lines.join('\n');
}

export function buildClaudePlanFeedbackFieldName(workflowId: string): string {
  const normalized = workflowId.replace(/[^a-zA-Z0-9_]/g, '_');
  return `claude_plan_feedback_${normalized}`;
}
