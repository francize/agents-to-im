import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudePlanAllowedPrompt {
  tool: string;
  prompt: string;
}

export const CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE =
  'The user wants to continue planning in a follow-up turn. Stop here without executing anything and wait for the next user message.';

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

export function buildClaudePlanFollowUpPrompt(requestText: string): string {
  return [
    '你仍然处于 PLAN 阶段。',
    '请基于上一轮刚输出的计划和当前上下文，按下面的用户反馈继续调整计划。',
    '只输出更新后的计划，不要执行，不要调用工具，不要修改文件，也不要声称已经完成。',
    '',
    '用户反馈如下：',
    requestText.trim(),
  ].join('\n');
}

export function buildClaudePlanFeedbackFieldName(workflowId: string): string {
  const normalized = workflowId.replace(/[^a-zA-Z0-9_]/g, '_');
  return `claude_plan_feedback_${normalized}`;
}
