import { getBridgeContext } from '../../bridge/context.js';
import { validateMode } from '../../bridge/security/validators.js';
import {
  buildResumeSessionCard,
  buildStatusCard,
} from '../cards/index.js';
import type {
  AdapterContext,
  CardActionResult,
  SenderIdentity,
  StructuredActionEvent,
} from '../types.js';
import {
  loadNativeSessionTranscript,
  listRecentNativeSessions,
} from '../../infra/native-session-history.js';
import { resolveActionOpenMessageId, resolveClaudeBindingMode } from '../utils.js';
import { getClaudeModeTitle } from '../../runtime/claude-mode.js';
import type { InboundMessage, ChannelAddress } from '../../bridge/types.js';
import type { RuntimeName } from '../../runtime/types.js';
import { buildReplayMessageText, splitReplayText } from '../cards/index.js';
import type { ChannelBinding } from '../../bridge/types.js';
import { appendLocalCommandExchange } from '../../bridge/local-command-history.js';
import type { MultiplexLLMProvider } from '../../providers/multiplex.js';

export async function handleCreateSessionCommand(
  ctx: AdapterContext,
  sender: SenderIdentity,
  inbound: InboundMessage,
  runtime: RuntimeName,
): Promise<void> {
  try {
    await ctx.ensureRuntimeAvailable(runtime);
    await ctx.sendNewSessionCard(inbound.address, runtime, inbound.messageId);
  } catch (error) {
    console.error('[feishu-adapter] Failed to initialize new-session card:', error);
    const message = `无法创建 ${runtime} 会话：${error instanceof Error ? error.message : String(error)}`;
    await ctx.sendAsPost(inbound.address, message, inbound.messageId);
  }
}

export async function handleResumeSessionCommand(
  ctx: AdapterContext,
  _sender: SenderIdentity,
  inbound: InboundMessage,
  runtime: RuntimeName,
): Promise<void> {
  try {
    await ctx.ensureRuntimeAvailable(runtime);
    const workdir = ctx.getStore().getSetting('bridge_default_work_dir') || process.cwd();
    const sessions = listRecentNativeSessions(runtime, workdir, 5);
    if (sessions.length === 0) {
      await ctx.sendAsPost(
        inbound.address,
        `未找到当前工作区下可恢复的 ${runtime} 原始会话记录。`,
        inbound.messageId,
      );
      return;
    }
    await ctx.sendInteractiveCard(
      inbound.address,
      buildResumeSessionCard(runtime, sessions),
      inbound.messageId,
    );
  } catch (error) {
    await ctx.sendAsPost(
      inbound.address,
      `读取 ${runtime} 原始会话失败：${error instanceof Error ? error.message : String(error)}`,
      inbound.messageId,
    );
  }
}

export async function handleNewSessionCardAction(
  ctx: AdapterContext,
  event: StructuredActionEvent,
  callbackData: string,
): Promise<CardActionResult> {
  const [, runtimeText, modeText] = callbackData.split(':');
  const runtime = runtimeText === 'codex' ? 'codex' : runtimeText === 'claude' ? 'claude' : null;
  const bindingMode = modeText === 'plan' ? 'plan' : modeText === 'code' ? 'code' : null;
  if (!runtime || !bindingMode) {
    return { toast: { type: 'warning', content: 'Unsupported action' } };
  }
  const sender = ctx.extractActionSenderIdentity(event);
  if (!sender) {
    return { toast: { type: 'warning', content: '无法识别当前操作人' } };
  }
  const actionMessageId = resolveActionOpenMessageId(event);
  const cwd = ctx.resolveSelectedWorkdir(event.action?.form_value as Record<string, unknown> | undefined);
  try {
    await ctx.createBoundSession(runtime, sender, {
      cwd,
      bindingMode,
    });
    await ctx.patchActionCardSafely(
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

export async function handleResumeCardAction(
  ctx: AdapterContext,
  event: StructuredActionEvent,
  callbackData: string,
): Promise<CardActionResult> {
  const [, action, runtimeText, nativeSessionId] = callbackData.split(':');
  const runtime = runtimeText === 'codex' ? 'codex' : runtimeText === 'claude' ? 'claude' : null;
  if (action !== 'pick' || !runtime || !nativeSessionId) {
    return { toast: { type: 'warning', content: 'Unsupported action' } };
  }
  const sender = ctx.extractActionSenderIdentity(event);
  if (!sender) {
    return { toast: { type: 'warning', content: '无法识别当前操作人' } };
  }
  const defaultWorkdir = ctx.getStore().getSetting('bridge_default_work_dir') || process.cwd();
  const transcript = loadNativeSessionTranscript(runtime, nativeSessionId, defaultWorkdir);
  if (!transcript) {
    return { toast: { type: 'warning', content: '原始会话不存在或已失效' } };
  }
  const actionMessageId = resolveActionOpenMessageId(event);
  try {
    const { chatId, binding } = await ctx.createBoundSession(runtime, sender, {
      cwd: transcript.session.cwd,
      skipReadyMessage: true,
    });
    const store = ctx.getStore();
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
    await ctx.syncChatName(chatId);
    await replayNativeSessionHistory(
      ctx,
      { channelType: ctx.channelType, channelInstanceId: ctx.profileId, chatId },
      runtime,
      transcript.items,
    );
    await ctx.sendAsPost(
      { channelType: ctx.channelType, channelInstanceId: ctx.profileId, chatId },
      `已恢复 ${runtime} 原始会话，后续请直接在本群继续对话。`,
    );
    await ctx.patchActionCardSafely(
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

export async function replayNativeSessionHistory(
  ctx: AdapterContext,
  address: ChannelAddress,
  runtime: RuntimeName,
  items: import('../../infra/native-session-history.js').NativeReplayItem[],
): Promise<void> {
  for (const item of items) {
    const parts = splitReplayText(item.text);
    for (const [index, part] of parts.entries()) {
      await ctx.sendAsInteractiveCard(
        address,
        buildReplayMessageText(runtime, { ...item, text: part }, index, parts.length),
      );
    }
  }
}

export async function handleResetCommand(
  ctx: AdapterContext,
  address: ChannelAddress,
  replyToMessageId?: string,
): Promise<void> {
  const store = ctx.getStore();
  const binding = store.getChannelBinding(ctx.channelType, address.chatId, ctx.profileId);
  if (!binding) {
    await ctx.sendAsPost(address, '当前群尚未绑定会话，请先私聊 Bot 使用 `/new:claude` 或 `/new:codex`。', replyToMessageId);
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
    channelType: ctx.channelType,
    channelInstanceId: ctx.profileId,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    workingDirectory: binding.workingDirectory,
    model: binding.model,
  });
  const updated = store.getChannelBinding(ctx.channelType, address.chatId, ctx.profileId);
  if (updated) {
    store.updateChannelBinding(updated.id, { mode: binding.mode, sdkSessionId: '' });
  }
  await ctx.syncChatName(address.chatId);
  const replyText = `已重置当前群会话，runtime 保持为 ${runtime}。`;
  await ctx.sendAsPost(address, replyText, replyToMessageId);
  appendLocalCommandExchange(
    store,
    session.id,
    '/reset',
    `Bridge 已重置当前群会话，runtime 保持为 ${runtime}，旧上下文已清空。`,
  );
}

export async function handleModeCommand(
  ctx: AdapterContext,
  bindingId: string,
  text: string,
  address: ChannelAddress,
  replyToMessageId?: string,
): Promise<void> {
  const store = ctx.getStore();
  const binding = ctx.findBindingById(bindingId);
  if (!binding) {
    await ctx.sendAsPost(address, '当前群尚未绑定会话。', replyToMessageId);
    return;
  }
  const runtime = store.getSessionExt(binding.codepilotSessionId)?.runtime || 'claude';
  if (runtime === 'claude') {
    await ctx.sendClaudeModeCard(address, 'switch', replyToMessageId, {
      selectedMode: resolveClaudeBindingMode(binding),
      bindingId: binding.id,
    });
    ctx.appendBindingCommandExchange(binding, text, 'Bridge 已打开 Claude mode 选择卡，等待用户确认新的 mode。');
    return;
  }
  const parts = text.trim().split(/\s+/);
  const mode = parts[1]?.toLowerCase() || '';
  if (!validateMode(mode)) {
    await ctx.sendAsPost(address, '用法：`/mode plan|code|ask`。', replyToMessageId);
    return;
  }
  if (runtime === 'codex' && mode === 'plan') {
    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      ensureCodexNativePlanAvailable?: () => Promise<void>;
    };
    try {
      await llm.ensureCodexNativePlanAvailable?.();
    } catch (error) {
      await ctx.sendAsPost(
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
  await ctx.syncChatName(address.chatId);
  const replyText = `已切换到 ${mode} 模式。`;
  await ctx.sendAsPost(address, replyText, replyToMessageId);
  ctx.appendBindingCommandExchange(binding, text, `Bridge 已将当前群会话切换到 ${mode} 模式。`);
}
