import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ChannelBinding, OutboundMessage } from '../bridge/types.js';
import { htmlToFeishuMarkdown, preprocessFeishuMarkdown } from '../bridge/markdown/feishu.js';
import {
  getClaudeModeOptions,
  getClaudeModeSuffix,
} from '../runtime/claude-mode.js';
import type { ClaudePermissionMode } from '../runtime/claude-mode.js';
import type { RuntimeName } from '../runtime/types.js';
import {
  FEISHU_REQUIRED_APP_SCOPES,
  PLAN_SUFFIX,
} from './constants.js';
import type {
  RouteAddress,
  StructuredActionEvent,
} from './types.js';

export function buildRouteKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:thread:${threadId}` : `${chatId}:main`;
}

export function routeKeyForAddress(address: RouteAddress): string {
  return buildRouteKey(address.chatId, address.threadId);
}

export function previewKey(routeKey: string, draftId: number): string {
  return `${routeKey}:${draftId}`;
}

export function pendingInboundImageKey(
  chatId: string,
  senderId: string,
  messageId: string,
  threadId?: string,
): string {
  return `${chatId}:${threadId || 'main'}:${senderId}:${messageId}`;
}

export function activityKey(routeKey: string, activityId: string): string {
  return `${routeKey}:activity:${activityId}`;
}

export function stableMessageUuid(scope: string, key: string): string {
  const hash = createHash('sha256').update(`${scope}:${key}`).digest('hex').slice(0, 40);
  return `${scope}-${hash}`.slice(0, 50);
}

export function sanitizeTitleFallback(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 30) || '新会话';
}

export function normalizePath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function stripPlanSuffix(text: string): string {
  return text.replace(/\s*\[PLAN\]$/, '').trim();
}

export function stripClaudeModeSuffix(text: string): string {
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

export function resolveLegacyClaudePermissionMode(mode: 'code' | 'plan' | 'ask'): ClaudePermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'ask':
      return 'default';
    default:
      return 'acceptEdits';
  }
}

export function resolveClaudeBindingMode(
  binding: Pick<ChannelBinding, 'mode' | 'claudePermissionMode'>,
): ClaudePermissionMode {
  return binding.claudePermissionMode || resolveLegacyClaudePermissionMode(binding.mode);
}

export function defaultChatName(runtime: RuntimeName, claudePermissionMode?: ClaudePermissionMode): string {
  const base = runtime === 'codex' ? 'Codex 新会话' : 'Claude 新会话';
  return runtime === 'claude' ? `${base}${getClaudeModeSuffix(claudePermissionMode)}` : base;
}

export function collectTextFragments(value: unknown): string[] {
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

export function parseTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    return collectTextFragments(parsed).join('\n').trim();
  } catch {
    return content.trim();
  }
}

export function parseImageResourceKey(content: string): string {
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

export function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('bmp')) return 'bmp';
  return 'bin';
}

export function normalizeMarkdown(message: OutboundMessage): string {
  let text = message.text;
  if (message.parseMode === 'HTML') {
    text = htmlToFeishuMarkdown(text);
  }
  if (message.parseMode === 'Markdown' || message.parseMode === 'HTML') {
    text = preprocessFeishuMarkdown(text);
  }
  return text;
}

export function buildPlanningPrompt(requestText: string): string {
  return [
    '你现在处于 PLAN 阶段。',
    '只输出计划，不要执行，不要调用工具，不要修改文件，也不要声称已经完成。',
    '请给出简洁、可执行的步骤、前置条件和主要风险。',
    '',
    '需求如下：',
    requestText,
  ].join('\n');
}

export function buildPlanExecutionPrompt(requestText: string): string {
  return [
    '用户已经确认上一轮计划，现在开始实施。',
    '不要重复输出完整计划，直接执行当前需求；必要时只保留简短进度说明。',
    '',
    '原始需求如下：',
    requestText,
  ].join('\n');
}

export function assertLarkOk(response: { code?: number; msg?: string }, context: string): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`${context}: code=${response.code}, msg=${response.msg || 'unknown error'}`);
  }
}

export function isRecoverableMessageSendError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.message}\n${error.stack || ''}`
    : String(error);
  return /status code 504|gateway timeout|code=2200|etimedout/i.test(text);
}

export function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function resolveActionOpenMessageId(event: StructuredActionEvent): string {
  return event.open_message_id || event.context?.open_message_id || '';
}

export { FEISHU_REQUIRED_APP_SCOPES, PLAN_SUFFIX };
