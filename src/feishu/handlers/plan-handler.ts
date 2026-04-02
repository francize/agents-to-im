import * as lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';

import { getBridgeContext } from '../../bridge/context.js';
import { interruptActiveTask } from '../../bridge/bridge-manager.js';
import {
  CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE,
  buildClaudePlanFollowUpPrompt,
  buildClaudePlanModeUpdates,
  buildHandledClaudePlanExitCard,
} from '../../runtime/claude-plan-exit.js';
import { buildHandledPlanCard } from '../cards/index.js';
import type {
  AdapterContext,
  CardActionResult,
  StructuredActionEvent,
} from '../types.js';
import { resolveActionOpenMessageId, routeKeyForAddress } from '../utils.js';
import type { InboundMessage } from '../../bridge/types.js';
import type { MultiplexLLMProvider } from '../../providers/multiplex.js';

function createAttemptId(): string {
  return randomUUID();
}

function enqueuePlanAttempt(
  ctx: AdapterContext,
  runtime: 'claude' | 'codex',
  workflowId: string,
  attemptId: string,
  inbound: InboundMessage,
  requestText: string,
  options?: {
    promptText?: string;
  },
): void {
  if (runtime === 'codex') {
    ctx.enqueue(ctx.buildNativePlanRequestInbound(
      inbound.address,
      inbound.messageId,
      workflowId,
      requestText,
      {
        attemptId,
        attachments: inbound.attachments,
      },
    ));
    return;
  }
  ctx.enqueue(ctx.buildPlanRequestInbound(
    inbound.address,
    inbound.messageId,
    workflowId,
    requestText,
    {
      attemptId,
      promptText: options?.promptText,
      attachments: inbound.attachments,
    },
  ));
}

export async function handlePlanCommand(
  ctx: AdapterContext,
  bindingId: string,
  inbound: InboundMessage,
): Promise<void> {
  const store = ctx.getStore();
  const binding = Array.from(store.listChannelBindings(ctx.channelType)).find((item) => item.id === bindingId);
  if (!binding) {
    await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。', inbound.messageId);
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
    await ctx.sendAsPost(
      inbound.address,
      replyText,
      inbound.messageId,
    );
    ctx.appendBindingCommandExchange(binding, inbound.text, replyText);
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
      await ctx.sendAsPost(
        inbound.address,
        `当前本地 Codex 不支持原生 plan：${error instanceof Error ? error.message : String(error)}`,
        inbound.messageId,
      );
      return;
    }
    if (!requestText) {
      store.upsertPlanWorkflow({
        bindingId,
        channelType: ctx.channelType,
        channelInstanceId: ctx.profileId,
        chatId: inbound.address.chatId,
        codepilotSessionId: binding.codepilotSessionId,
        status: 'awaiting_input',
        previousMode: binding.mode,
        requestText: '',
        address: inbound.address,
        routeKey: routeKeyForAddress(inbound.address),
        requestMessageId: inbound.messageId,
        activeAttemptId: '',
        pendingFollowUpText: '',
        pendingFollowUpAttachments: [],
        pendingRequestMessageId: '',
        pendingAddress: undefined,
        pendingRouteKey: '',
        resolved: true,
      });
      await ctx.syncChatName(inbound.address.chatId);
      const replyText = '已进入原生 PLAN 流程。下一条同线程消息将作为 plan 请求发送给 Codex。';
      await ctx.sendAsPost(inbound.address, replyText, inbound.messageId);
      ctx.appendBindingCommandExchange(binding, inbound.text, 'Bridge 已进入 Codex 原生 PLAN 流程，下一条同线程消息会作为 plan 请求发送。');
      return;
    }
    const attemptId = createAttemptId();
    const workflow = store.upsertPlanWorkflow({
      bindingId,
      channelType: ctx.channelType,
      channelInstanceId: ctx.profileId,
      chatId: inbound.address.chatId,
      codepilotSessionId: binding.codepilotSessionId,
      status: 'planning',
      previousMode: binding.mode,
      requestText,
      address: inbound.address,
      routeKey: routeKeyForAddress(inbound.address),
      requestMessageId: inbound.messageId,
      activeAttemptId: attemptId,
      pendingFollowUpText: '',
      pendingFollowUpAttachments: [],
      pendingRequestMessageId: '',
      pendingAddress: undefined,
      pendingRouteKey: '',
      resolved: true,
    });
    await ctx.syncChatName(inbound.address.chatId);
    enqueuePlanAttempt(ctx, 'codex', workflow.workflowId, attemptId, inbound, requestText);
    return;
  }

  const attemptId = requestText ? createAttemptId() : '';
  const workflow = store.upsertPlanWorkflow({
    bindingId,
    channelType: ctx.channelType,
    channelInstanceId: ctx.profileId,
    chatId: inbound.address.chatId,
    codepilotSessionId: binding.codepilotSessionId,
    status: requestText ? 'planning' : 'awaiting_input',
    previousMode: binding.mode,
    requestText,
    address: inbound.address,
    routeKey: routeKeyForAddress(inbound.address),
    requestMessageId: inbound.messageId,
    activeAttemptId: attemptId,
    pendingFollowUpText: '',
    pendingFollowUpAttachments: [],
    pendingRequestMessageId: '',
    pendingAddress: undefined,
    pendingRouteKey: '',
    resolved: true,
  });
  await ctx.syncChatName(inbound.address.chatId);

  if (!requestText) {
    const replyText = '已进入 PLAN 流程。下一条非命令消息将作为规划需求。';
    await ctx.sendAsPost(inbound.address, replyText, inbound.messageId);
    ctx.appendBindingCommandExchange(binding, inbound.text, 'Bridge 已进入 Claude PLAN 流程，下一条非命令消息会作为规划需求发送。');
    return;
  }

  enqueuePlanAttempt(ctx, 'claude', workflow.workflowId, attemptId, inbound, requestText);
}

export async function handlePlanWorkflowMessage(
  ctx: AdapterContext,
  bindingId: string,
  workflowId: string,
  inbound: InboundMessage,
): Promise<boolean> {
  const store = ctx.getStore();
  const workflow = store.getPlanWorkflow(workflowId);
  if (!workflow) return false;
  if (workflow.channelInstanceId !== ctx.profileId) return false;
  const binding = Array.from(store.listChannelBindings(ctx.channelType))
    .find((item) => item.channelInstanceId === ctx.profileId && item.id === bindingId);
  const runtime = binding ? (store.getSessionExt(binding.codepilotSessionId)?.runtime || 'claude') : 'claude';
  const routeKey = routeKeyForAddress(inbound.address);
  if (workflow.routeKey !== routeKey) {
    await ctx.sendAsPost(
      inbound.address,
      '当前 PLAN 流程已在另一条线程中进行，请回原线程继续或先取消。',
      inbound.messageId,
    );
    return true;
  }
  if (workflow.bindingId !== bindingId) return false;

  switch (workflow.status) {
    case 'awaiting_input':
      {
        const attemptId = createAttemptId();
        if (runtime === 'codex') {
          store.updatePlanWorkflow(workflow.workflowId, {
            status: 'planning',
            requestText: inbound.text.trim(),
            address: inbound.address,
            routeKey,
            requestMessageId: inbound.messageId,
            activeAttemptId: attemptId,
            pendingFollowUpText: '',
            pendingFollowUpAttachments: [],
            pendingRequestMessageId: '',
            pendingAddress: undefined,
            pendingRouteKey: '',
            resolved: true,
          });
          enqueuePlanAttempt(ctx, 'codex', workflow.workflowId, attemptId, inbound, inbound.text.trim());
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
          activeAttemptId: attemptId,
          pendingFollowUpText: '',
          pendingFollowUpAttachments: [],
          pendingRequestMessageId: '',
          pendingAddress: undefined,
          pendingRouteKey: '',
          resolved: true,
        });
        enqueuePlanAttempt(ctx, 'claude', workflow.workflowId, attemptId, inbound, inbound.text.trim());
        return true;
      }
    case 'planning':
    case 'interrupting': {
      const requestText = inbound.text.trim();
      const attemptId = createAttemptId();
      store.updatePlanWorkflow(workflow.workflowId, {
        status: 'interrupting',
        activeAttemptId: attemptId,
        pendingFollowUpText: requestText,
        pendingFollowUpAttachments: inbound.attachments || [],
        pendingRequestMessageId: inbound.messageId,
        pendingAddress: inbound.address,
        pendingRouteKey: routeKey,
        resolved: true,
      });
      interruptActiveTask(binding?.codepilotSessionId || workflow.codepilotSessionId);
      enqueuePlanAttempt(ctx, runtime, workflow.workflowId, attemptId, inbound, requestText);
      await ctx.sendAsPost(inbound.address, '已收到补充要求，正在按新要求重试。', inbound.messageId);
      return true;
    }
    case 'awaiting_confirmation':
      if (runtime === 'codex') {
        const requestText = inbound.text.trim();
        const attemptId = createAttemptId();
        store.updatePlanWorkflow(workflow.workflowId, {
          status: 'planning',
          requestText,
          address: inbound.address,
          routeKey,
          requestMessageId: inbound.messageId,
          actionCardMessageId: '',
          actionCardOpenMessageId: '',
          activeAttemptId: attemptId,
          pendingFollowUpText: '',
          pendingFollowUpAttachments: [],
          pendingRequestMessageId: '',
          pendingAddress: undefined,
          pendingRouteKey: '',
          resolved: true,
        });
        enqueuePlanAttempt(ctx, 'codex', workflow.workflowId, attemptId, inbound, requestText);
        return true;
      }
      {
        const requestText = inbound.text.trim();
        const attemptId = createAttemptId();
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
          activeAttemptId: attemptId,
          pendingFollowUpText: '',
          pendingFollowUpAttachments: [],
          pendingRequestMessageId: '',
          pendingAddress: undefined,
          pendingRouteKey: '',
          resolved: true,
        });
        if (workflow.approvalRequestId) {
          getBridgeContext().permissions.resolvePendingPermission?.(workflow.approvalRequestId, {
            behavior: 'deny',
            message: CLAUDE_PLAN_FOLLOW_UP_REJECT_MESSAGE,
            interrupt: true,
          });
        }
        enqueuePlanAttempt(ctx, 'claude', workflow.workflowId, attemptId, inbound, requestText, {
          promptText: buildClaudePlanFollowUpPrompt(requestText, {
            planText: workflow.planText,
            planFilePath: workflow.planFilePath,
          }),
        });
      }
      return true;
    default:
      return false;
  }
}

export async function handlePlanCardAction(
  ctx: AdapterContext,
  event: lark.InteractiveCardActionEvent,
  callbackData: string,
): Promise<CardActionResult> {
  const [, action, workflowId] = callbackData.split(':');
  if (!workflowId || !action) {
    return { toast: { type: 'warning', content: 'Unsupported action' } };
  }
  const store = ctx.getStore();
  const workflow = store.getPlanWorkflow(workflowId);
  if (!workflow || workflow.channelInstanceId !== ctx.profileId) {
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

  const binding = store.getChannelBinding(ctx.channelType, workflow.chatId, workflow.channelInstanceId);
  switch (action) {
    case 'execute':
      await ctx.patchActionCardSafely(
        workflow.actionCardMessageId,
        buildHandledPlanCard(action),
        'plan',
        actionMessageId || workflow.actionCardOpenMessageId,
      );
      if (binding) {
        store.updateChannelBinding(binding.id, { mode: 'code' });
      }
      store.deletePlanWorkflow(workflowId);
      await ctx.syncChatName(workflow.chatId);
      ctx.enqueue(ctx.buildPlanExecutionInbound(
        workflow.address,
        workflow.requestMessageId || workflow.planMessageId || workflow.actionCardMessageId || workflow.workflowId,
        workflowId,
        workflow.requestText,
      ));
      return { toast: { type: 'success', content: '开始执行已确认计划' } };
    case 'continue':
      await ctx.patchActionCardSafely(
        workflow.actionCardMessageId,
        buildHandledPlanCard(action),
        'plan',
        actionMessageId || workflow.actionCardOpenMessageId,
      );
      store.updatePlanWorkflow(workflowId, {
        status: 'awaiting_input',
        requestText: '',
        planMessageId: '',
        actionCardMessageId: '',
        actionCardOpenMessageId: '',
        approvalRequestId: '',
        activeAttemptId: '',
        pendingFollowUpText: '',
        pendingFollowUpAttachments: [],
        pendingRequestMessageId: '',
        pendingAddress: undefined,
        pendingRouteKey: '',
        resolved: true,
      });
      await ctx.syncChatName(workflow.chatId);
      return { toast: { type: 'success', content: '继续保持 PLAN 模式' } };
    case 'cancel':
      await ctx.patchActionCardSafely(
        workflow.actionCardMessageId,
        buildHandledPlanCard(action),
        'plan',
        actionMessageId || workflow.actionCardOpenMessageId,
      );
      if (binding) {
        store.updateChannelBinding(binding.id, { mode: workflow.previousMode });
      }
      store.deletePlanWorkflow(workflowId);
      await ctx.syncChatName(workflow.chatId);
      return { toast: { type: 'success', content: '已取消 PLAN 流程' } };
    default:
      store.updatePlanWorkflow(workflowId, { resolved: false });
      return { toast: { type: 'warning', content: 'Unsupported action' } };
  }
}

export async function handleClaudePlanExitCardAction(
  ctx: AdapterContext,
  event: lark.InteractiveCardActionEvent,
  callbackData: string,
): Promise<CardActionResult> {
  const parts = callbackData.split(':');
  const action = parts[1];
  const variant = parts[2];
  const workflowId = parts.slice(3).join(':') || parts.slice(2).join(':');
  if (!workflowId || !action) {
    return { toast: { type: 'warning', content: 'Unsupported action' } };
  }

  const store = ctx.getStore();
  const workflow = store.getPlanWorkflow(workflowId);
  if (!workflow || workflow.channelInstanceId !== ctx.profileId) {
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

  const binding = store.getChannelBinding(ctx.channelType, workflow.chatId, workflow.channelInstanceId);
  const allowedPrompts = workflow.allowedPrompts || [];
  const approvalRequestId = workflow.approvalRequestId?.trim() || '';

  const resolvePermission = (
    resolution: {
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
    await ctx.patchActionCardSafely(
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
    store.updateChannelBinding(binding.id, {
      mode: 'code',
      claudePermissionMode: variant === 'bypass' ? 'bypassPermissions' : 'default',
    });
    await ctx.syncChatName(workflow.chatId);
    const resolved = resolvePermission({
      behavior: 'allow',
      updatedPermissions: buildClaudePlanModeUpdates(
        variant === 'bypass' ? 'bypassPermissions' : 'default',
        allowedPrompts,
      ),
    });
    if (resolved) {
      store.updatePlanWorkflow(workflowId, {
        status: 'planning',
        approvalRequestId: '',
        actionCardMessageId: '',
        actionCardOpenMessageId: '',
        resolved: true,
      });
    } else {
      store.deletePlanWorkflow(workflowId);
      ctx.enqueue(ctx.buildPlanExecutionInbound(
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
    await ctx.patchActionCardSafely(
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
      channelType: ctx.channelType,
      channelInstanceId: ctx.profileId,
      chatId: workflow.chatId,
      codepilotSessionId: session.id,
      workingDirectory: binding.workingDirectory,
      model: binding.model,
    });
    const updatedBinding = store.getChannelBinding(ctx.channelType, workflow.chatId, ctx.profileId);
    if (updatedBinding) {
      store.updateChannelBinding(updatedBinding.id, {
        mode: 'code',
        claudePermissionMode: 'bypassPermissions',
        sdkSessionId: '',
      });
    }
    store.deletePlanWorkflow(workflowId);
    await ctx.syncChatName(workflow.chatId);

    if (approvalRequestId) {
      resolvePermission({
        behavior: 'deny',
        message: 'The user approved the plan but wants execution to restart in a fresh session with cleared context. Stop planning here.',
        interrupt: true,
      });
    }

    ctx.enqueue(ctx.buildPlanExecutionInbound(
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
