import type { InboundMessage } from '../../bridge/types.js';
import type {
  AdapterContext,
  FeishuMessageEventData,
  SenderIdentity,
} from '../types.js';
import { buildRouteKey, parseImageResourceKey, parseTextContent } from '../utils.js';
import { pendingInboundImageKey } from '../utils.js';

export async function handleIncomingEvent(
  ctx: AdapterContext,
  data: FeishuMessageEventData,
): Promise<void> {
  const messageId = data.message.message_id;
  if (data.sender.sender_type === 'app') return;
  if (!ctx.markSeenMessage(messageId)) return;

  const sender = extractSenderIdentity(data);
  if (!sender || !ctx.isAuthorized(sender.id, data.message.chat_id)) {
    console.warn(
      `[feishu-adapter] Dropped inbound message ${messageId}: unauthorized or sender identity missing ` +
      `(chat=${data.message.chat_id})`,
    );
    return;
  }

  const threadId = data.message.thread_id || undefined;
  const routeKey = buildRouteKey(data.message.chat_id, threadId);
  ctx.setLastIncomingMessageId(routeKey, messageId);
  console.log(
    `[feishu-adapter] Inbound message ${messageId} chat=${data.message.chat_id}` +
    `${threadId ? ` thread=${threadId}` : ''} type=${data.message.message_type} chatType=${data.message.chat_type}`,
  );

  await ctx.enqueueChatTask(routeKey, async () => {
    ctx.prunePendingInboundImages();
    const inbound: InboundMessage = {
      messageId,
      address: {
        channelType: ctx.channelType,
        channelInstanceId: ctx.profileId,
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
        ctx.setPendingInboundImage({
          key: pendingKey,
          chatId: data.message.chat_id,
          threadId,
          senderId: sender.id,
          messageId,
          createdAt: Date.now(),
          errorMessage: '这张图片的资源标识缺失，请重新发送图片后再直接回复文字。',
        });
        await ctx.sendAsPost(
          inbound.address,
          '已收到图片，但读取图片资源失败。请重新发送图片后，再直接回复这张图片补充文字。',
          messageId,
        );
        return;
      }
      try {
        const attachment = await ctx.downloadInboundImageAttachment(messageId, imageKey);
        ctx.setPendingInboundImage({
          key: pendingKey,
          chatId: data.message.chat_id,
          threadId,
          senderId: sender.id,
          messageId,
          createdAt: Date.now(),
          attachments: [attachment],
        });
        await ctx.sendAsPost(
          inbound.address,
          '已收到图片。请直接回复这张图片本身补充文字，我会把图文一起发给模型。',
          messageId,
        );
      } catch (error) {
        const errorMessage = `这张图片下载失败，请重新发送图片后再直接回复文字。${
          error instanceof Error && error.message ? `\n原因：${error.message}` : ''
        }`;
        ctx.setPendingInboundImage({
          key: pendingKey,
          chatId: data.message.chat_id,
          threadId,
          senderId: sender.id,
          messageId,
          createdAt: Date.now(),
          errorMessage,
        });
        console.warn('[feishu-adapter] Failed to download inbound image:', error);
        await ctx.sendAsPost(inbound.address, errorMessage, messageId);
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

    const referencedImages = ctx.resolveReferencedInboundImages(
      data.message.chat_id,
      sender.id,
      threadId,
      [data.message.parent_id, data.message.root_id],
    );
    if (referencedImages.errorMessage) {
      await ctx.sendAsPost(inbound.address, referencedImages.errorMessage, messageId);
      return;
    }
    if (referencedImages.attachments?.length) {
      inbound.attachments = referencedImages.attachments;
    }

    if (data.message.chat_type === 'p2p') {
      await handleDirectMessage(ctx, sender, inbound);
      return;
    }
    await handleGroupMessage(ctx, sender, inbound);
  });
}

export async function handleDirectMessage(
  ctx: AdapterContext,
  sender: SenderIdentity,
  inbound: InboundMessage,
): Promise<void> {
  const command = inbound.text.trim().toLowerCase();
  if (command === '/new:claude') {
    await ctx.handleCreateSessionCommand(sender, inbound, 'claude');
    return;
  }
  if (command === '/new:codex') {
    await ctx.handleCreateSessionCommand(sender, inbound, 'codex');
    return;
  }
  if (command === '/resume:claude') {
    await ctx.handleResumeSessionCommand(sender, inbound, 'claude');
    return;
  }
  if (command === '/resume:codex') {
    await ctx.handleResumeSessionCommand(sender, inbound, 'codex');
    return;
  }
  await ctx.sendAsPost(
    inbound.address,
    '私聊仅支持 `/new:claude`、`/new:codex`、`/resume:claude` 和 `/resume:codex`。',
    inbound.messageId,
  );
}

export async function handleGroupMessage(
  ctx: AdapterContext,
  _sender: SenderIdentity,
  inbound: InboundMessage,
): Promise<void> {
  const store = ctx.getStore();
  const text = inbound.text.trim();
  const lower = text.toLowerCase();
  const binding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
  const workflow = binding ? store.getActivePlanWorkflowByBinding(binding.id) : null;

  if (lower === '/reset') {
    await ctx.handleResetCommand(inbound.address, inbound.messageId);
    return;
  }
  if (lower === '/stop') {
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    ctx.enqueue(inbound);
    return;
  }
  if (lower.startsWith('/mode')) {
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    await ctx.handleModeCommand(binding.id, text, inbound.address, inbound.messageId);
    return;
  }
  if (lower === '/plan' || lower.startsWith('/plan ')) {
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    await ctx.handlePlanCommand(binding.id, inbound);
    return;
  }
  if (lower.startsWith('/new')) {
    await ctx.sendAsPost(inbound.address, '请先私聊 Bot 使用 `/new:claude` 或 `/new:codex` 创建新会话。', inbound.messageId);
    return;
  }
  if (lower.startsWith('/')) {
    await ctx.sendAsPost(inbound.address, '该群仅支持普通对话、`/plan`、`/mode`、`/stop`、`/reset`。权限请求请直接使用卡片按钮处理；如需新会话，请私聊 Bot。', inbound.messageId);
    return;
  }

  if (!binding) {
    await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
    return;
  }
  if (workflow) {
    const consumed = await ctx.handlePlanWorkflowMessage(binding.id, workflow.workflowId, inbound);
    if (consumed) return;
  }
  ctx.enqueue(inbound);
}

function extractSenderIdentity(data: FeishuMessageEventData): SenderIdentity | null {
  const senderId = data.sender.sender_id;
  if (senderId?.open_id) return { id: senderId.open_id, type: 'open_id' };
  if (senderId?.user_id) return { id: senderId.user_id, type: 'user_id' };
  if (senderId?.union_id) return { id: senderId.union_id, type: 'union_id' };
  return null;
}
