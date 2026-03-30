import { extractStructuredAnswers } from '../cards/index.js';
import type {
  AdapterContext,
  CardActionResult,
  StructuredActionEvent,
} from '../types.js';
import { collectTextFragments } from '../utils.js';
import { getBridgeContext } from '../../bridge/context.js';

export async function handleStructuredInputCardAction(
  ctx: AdapterContext,
  event: StructuredActionEvent,
  callbackData: string,
): Promise<CardActionResult> {
  const [, action, requestId, questionId] = callbackData.split(':');
  if (!requestId) {
    return { toast: { type: 'warning', content: 'Unsupported action' } };
  }
  const store = ctx.getStore();
  const request = store.getStructuredInputRequest(requestId);
  if (!request || request.channelInstanceId !== ctx.profileId) {
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
      void ctx.resolveStructuredInputRequest(requestId);
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
    void ctx.resolveStructuredInputRequest(requestId);
  });

  return { toast: { type: 'success', content: '答案已提交' } };
}
