/**
 * Permission Broker — forwards Claude permission requests to IM channels
 * and handles user responses via inline buttons.
 *
 * When Claude needs tool approval, the broker:
 * 1. Formats a permission prompt with inline keyboard buttons
 * 2. Sends it via the delivery layer
 * 3. Records the link between permission ID and IM message
 * 4. When a callback arrives, resolves the permission via the gateway
 */

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelAddress, OutboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { buildInteractionTimeoutText } from './interaction-timeout.js';
import {
  PENDING_APPROVALS_TIMEOUT_MS,
  PENDING_PERMISSIONS_TIMEOUT_MS,
} from '../providers/claude/permission-gateway.js';

function summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string[] {
  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
    const description = typeof toolInput.description === 'string' ? toolInput.description.trim() : '';
    return [
      command ? `**命令**：\`${command}\`` : '',
      description ? `**说明**：${description}` : '',
    ].filter(Boolean);
  }

  const filePath = typeof toolInput.file_path === 'string'
    ? toolInput.file_path.trim()
    : typeof toolInput.filePath === 'string'
      ? toolInput.filePath.trim()
      : '';
  if (filePath) {
    return [`**文件**：\`${filePath}\``];
  }

  const query = typeof toolInput.query === 'string' ? toolInput.query.trim() : '';
  if (query) {
    return [`**参数**：${query}`];
  }

  const keys = Object.entries(toolInput)
    .filter(([, value]) => value !== undefined && value !== null && `${value}`.trim() !== '')
    .slice(0, 3)
    .map(([key, value]) => `**${key}**：\`${String(value).slice(0, 120)}\``);

  return keys;
}

function buildPermissionMarkdown(
  toolName: string,
  toolInput: Record<string, unknown>,
  timeoutHint: string,
): string {
  const lines = [
    '继续前需要你的授权。',
    '',
    `**工具**：\`${toolName}\``,
    ...summarizeToolInput(toolName, toolInput),
    '',
    timeoutHint,
  ];
  return lines.join('\n');
}

function resolvePermissionTimeoutMs(sessionId?: string): number {
  if (!sessionId) return PENDING_PERMISSIONS_TIMEOUT_MS;
  const runtime = getBridgeContext().store.getSessionExt(sessionId)?.runtime;
  return runtime === 'codex' ? PENDING_APPROVALS_TIMEOUT_MS : PENDING_PERMISSIONS_TIMEOUT_MS;
}

/**
 * Dedup recent permission forwards to prevent duplicate cards.
 * Key: permissionRequestId, value: timestamp. Entries expire after 30s.
 */
const recentPermissionForwards = new Map<string, number>();

/**
 * Forward a permission request to an IM channel as an interactive message.
 */
export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Dedup: prevent duplicate forwarding of the same permission request
  const now = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) {
    console.warn(`[permission-broker] Duplicate forward suppressed for ${permissionRequestId}`);
    return;
  }
  recentPermissionForwards.set(permissionRequestId, now);
  // Clean up old entries
  for (const [id, ts] of recentPermissionForwards) {
    if (now - ts > 30_000) recentPermissionForwards.delete(id);
  }

  console.log(`[permission-broker] Forwarding permission request: ${permissionRequestId} tool=${toolName} channel=${adapter.channelType}`);

  const timeoutHint = buildInteractionTimeoutText(
    resolvePermissionTimeoutMs(sessionId),
    '会自动拒绝',
  );

  const text = buildPermissionMarkdown(toolName, toolInput, timeoutHint);

  const message: OutboundMessage = {
    address,
    text,
    parseMode: 'Markdown',
    inlineButtons: [
      [
        { text: '本次允许', callbackData: `perm:allow:${permissionRequestId}` },
        { text: '本会话允许', callbackData: `perm:allow_session:${permissionRequestId}` },
        { text: '拒绝', callbackData: `perm:deny:${permissionRequestId}` },
      ],
    ],
    replyToMessageId,
    cardHeader: {
      title: '需要授权',
      template: 'orange',
    },
  };

  const result = await deliver(adapter, message, { sessionId });

  // Record the link so we can match callback queries back to this permission
  if (result.ok && result.messageId) {
    try {
      store.insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        channelInstanceId: address.channelInstanceId || adapter.profileId,
        chatId: address.chatId,
        messageId: result.messageId,
        ...(result.openMessageId ? { openMessageId: result.openMessageId } : {}),
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }
  }
}

/**
 * Handle a permission callback from an inline button press.
 * Validates that the callback came from the same chat AND same message that
 * received the permission request, prevents duplicate resolution via atomic
 * DB check-and-set, and implements real allow_session semantics by passing
 * updatedPermissions (suggestions).
 *
 * Returns true if the callback was recognized and handled.
 */
export function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
  callbackContext?: { channelType?: string; channelInstanceId?: string },
): boolean {
  const { store, permissions } = getBridgeContext();

  // Parse callback data: perm:action:permId
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') return false;

  const action = parts[1];
  const permissionRequestId = parts.slice(2).join(':'); // permId might contain colons

  // Look up the permission link to validate origin and check dedup
  const link = store.getPermissionLink(permissionRequestId);
  if (!link) {
    console.warn(`[permission-broker] No permission link found for ${permissionRequestId}`);
    return false;
  }

  // Security: verify the callback came from the same chat that received the request
  if (link.chatId !== callbackChatId) {
    console.warn(`[permission-broker] Chat ID mismatch: expected ${link.chatId}, got ${callbackChatId}`);
    return false;
  }

  if (callbackContext?.channelType && link.channelType !== callbackContext.channelType) {
    console.warn(
      `[permission-broker] Channel type mismatch: expected ${link.channelType}, got ${callbackContext.channelType}`,
    );
    return false;
  }

  if (
    callbackContext?.channelInstanceId
    && link.channelInstanceId !== callbackContext.channelInstanceId
  ) {
    console.warn(
      `[permission-broker] Channel instance mismatch: expected ${link.channelInstanceId}, got ${callbackContext.channelInstanceId}`,
    );
    return false;
  }

  // Security: verify the callback came from the original permission message
  if (
    callbackMessageId &&
    link.messageId !== callbackMessageId &&
    link.openMessageId !== callbackMessageId
  ) {
    console.warn(`[permission-broker] Message ID mismatch: expected ${link.messageId}, got ${callbackMessageId}`);
    return false;
  }

  // Dedup: reject if already resolved (fast path before expensive resolution)
  if (link.resolved) {
    console.warn(`[permission-broker] Permission ${permissionRequestId} already resolved`);
    return false;
  }

  // Atomically mark as resolved BEFORE calling resolvePendingPermission
  // to prevent race conditions with concurrent button clicks
  let claimed: boolean;
  try {
    claimed = store.markPermissionLinkResolved(permissionRequestId);
  } catch {
    return false;
  }

  if (!claimed) {
    // Another concurrent handler already resolved this permission
    console.warn(`[permission-broker] Permission ${permissionRequestId} already claimed by concurrent handler`);
    return false;
  }

  let resolved: boolean;

  switch (action) {
    case 'allow':
      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
        scope: 'turn',
      });
      break;

    case 'allow_session': {
      // Parse stored suggestions so subsequent same-tool calls auto-approve
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (link.suggestions) {
        try {
          updatedPermissions = JSON.parse(link.suggestions) as PermissionUpdate[];
        } catch { /* fall through without updatedPermissions */ }
      }

      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'allow',
        scope: 'session',
        ...(updatedPermissions ? { updatedPermissions } : {}),
      });
      break;
    }

    case 'deny':
      resolved = permissions.resolvePendingPermission(permissionRequestId, {
        behavior: 'deny',
        message: 'Denied via IM bridge',
        scope: 'turn',
      });
      break;

    default:
      return false;
  }

  return resolved;
}
