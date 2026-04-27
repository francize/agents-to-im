import { handlePermissionCallback } from '../../bridge/permission-broker.js';
import {
  buildHandledPermissionCard,
} from '../cards/index.js';
import type {
  AdapterContext,
  CardActionResult,
  SenderIdentity,
  StructuredActionEvent,
} from '../types.js';
import { isStructuredInputFieldInteraction, buildHandledPlanCard } from '../cards/index.js';
import { resolveActionOpenMessageId } from '../utils.js';

export async function handleCardAction(
  ctx: AdapterContext,
  event: StructuredActionEvent,
): Promise<CardActionResult> {
  const callbackData = typeof event.action?.value?.callback_data === 'string'
    ? event.action.value.callback_data
    : '';
  console.log(
    `[feishu-adapter] card.action.trigger tag=${event.action?.tag || 'unknown'} ` +
    `open_message_id=${event.open_message_id || event.context?.open_message_id || 'unknown'} ` +
    `callback=${callbackData || '(none)'}`,
  );

  // 鉴权：所有 card 按钮回调都必须落入 allowlist。inbound 文本入口已经做了同样校验，
  // 但此前 card 回调直接进入业务分支，导致群里非 allowlist 成员可点击"允许"批准
  // Claude 的危险操作或创建会话，等同于 auth bypass。
  const sender = ctx.extractActionSenderIdentity(event);
  const actionChatId = event.context?.open_chat_id || '';
  if (!sender || !ctx.isAuthorized(sender.id, actionChatId)) {
    console.warn(
      `[feishu-adapter] Dropped card action: unauthorized or sender identity missing ` +
      `(chat=${actionChatId || 'unknown'}, tag=${event.action?.tag || 'unknown'}, ` +
      `callback=${callbackData || '(none)'})`,
    );
    return { toast: { type: 'warning', content: '未授权用户' } };
  }

  if (!callbackData) {
    if (isStructuredInputFieldInteraction(event)) {
      return { toast: { type: 'success', content: '已记录选择，填写完成后点击提交。' } };
    }
    return { toast: { type: 'warning', content: 'Unsupported action' } };
  }
  if (callbackData.startsWith('perm:')) {
    const store = ctx.getStore();
    const [, action, ...permissionParts] = callbackData.split(':');
    const permissionRequestId = permissionParts.join(':');
    const link = store.getPermissionLink(permissionRequestId);
    const actionMessageId = resolveActionOpenMessageId(event);
    if (
      link
      && handlePermissionCallback(callbackData, link.chatId, actionMessageId, {
        channelType: ctx.channelType,
        channelInstanceId: ctx.profileId,
      })
    ) {
      await patchActionCardSafely(
        ctx,
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
    return ctx.handleNewSessionCardAction(event, callbackData);
  }
  if (callbackData.startsWith('claude-mode:')) {
    return ctx.handleClaudeModeCardAction(event, callbackData);
  }
  if (callbackData.startsWith('resume:')) {
    return ctx.handleResumeCardAction(event, callbackData);
  }
  if (callbackData.startsWith('input:')) {
    return ctx.handleStructuredInputCardAction(event, callbackData);
  }
  if (callbackData.startsWith('planexit:')) {
    return ctx.handleClaudePlanExitCardAction(event, callbackData);
  }
  if (callbackData.startsWith('plan:')) {
    return ctx.handlePlanCardAction(event, callbackData);
  }
  return { toast: { type: 'warning', content: 'Unsupported action' } };
}

export async function patchActionCardSafely(
  ctx: AdapterContext,
  messageId: string | undefined,
  card: Record<string, unknown>,
  kind: string,
  openMessageId?: string,
): Promise<void> {
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
      await ctx.patchInteractiveCard(attempt.id, card, { messageIdType: attempt.messageIdType });
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

export function findBindingById(ctx: AdapterContext, bindingId: string) {
  return ctx.getStore()
    .listChannelBindings(ctx.channelType)
    .find((item) => item.channelInstanceId === ctx.profileId && item.id === bindingId) || null;
}

export function extractActionSenderIdentity(_ctx: AdapterContext, event: StructuredActionEvent): SenderIdentity | null {
  if (event.operator?.open_id) {
    return { id: event.operator.open_id, type: 'open_id' };
  }
  if (event.operator?.user_id) {
    return { id: event.operator.user_id, type: 'user_id' };
  }
  return null;
}
