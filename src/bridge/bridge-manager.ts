/**
 * Bridge Manager — singleton orchestrator for the Feishu bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { MessageContentBlock, StructuredInputRequestInfo } from './host.js';
import type {
  ActivityEvent,
  BridgeStatus,
  InboundMessage,
  OutboundMessage,
  SendResult,
  StreamingPreviewState,
} from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver } from './delivery-layer.js';
import { buildInteractionTimeoutText } from './interaction-timeout.js';
import { getBridgeContext } from './context.js';
import {
  buildClaudePlanExitCard,
  buildClaudePlanExecutionPrompt,
  buildClaudePlanModeUpdates,
  CLAUDE_PLAN_EXIT_BYPASS_LABEL,
  CLAUDE_PLAN_EXIT_CLEAR_BYPASS_LABEL,
  CLAUDE_PLAN_EXIT_MANUAL_LABEL,
  parseClaudeAllowedPrompts,
  parseClaudePlanFilePath,
  parseClaudePlanText,
  truncateClaudePlanCardText,
} from '../runtime/claude-plan-exit.js';
import type { ClaudePermissionMode } from '../runtime/claude-mode.js';
import { PENDING_PERMISSIONS_TIMEOUT_MS } from '../providers/claude/permission-gateway.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';
import { appendLocalCommandExchange } from './local-command-history.js';

const GLOBAL_KEY = '__bridge_manager__';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
  primeDelayMs: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  feishu: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900, primeDelayMs: 900 },
};

function getStreamConfig(channelType = 'feishu'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.feishu;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  const primeDelayMs = parseInt(store.getSetting(`${prefix}prime_delay_ms`) || '', 10) || defaults.primeDelayMs;
  return { intervalMs, minDeltaChars, maxChars, primeDelayMs };
}

function clearPrimeTimer(state: StreamingPreviewState): void {
  if (state.primeTimer) {
    clearTimeout(state.primeTimer);
    state.primeTimer = null;
  }
}

function getPlanWorkflowMeta(msg: InboundMessage): NonNullable<InboundMessage['bridgeMeta']>['planWorkflow'] | null {
  return msg.bridgeMeta?.planWorkflow || null;
}

function routeKeyForAddress(address: InboundMessage['address']): string {
  return address.threadId
    ? `${address.chatId}:thread:${address.threadId}`
    : `${address.chatId}:main`;
}

function createPlanAttemptId(): string {
  return randomUUID();
}

function isPlanAttemptCurrent(
  meta: NonNullable<InboundMessage['bridgeMeta']>['planWorkflow'] | null,
): boolean {
  if (!meta?.workflowId || !meta.attemptId) return true;
  const { store } = getBridgeContext();
  const workflow = store.getPlanWorkflow(meta.workflowId);
  return !!workflow && workflow.activeAttemptId === meta.attemptId;
}

export function interruptActiveTask(sessionId: string): boolean {
  const state = getState();
  const taskAbort = state.activeTasks.get(sessionId);
  if (!taskAbort) return false;
  taskAbort.abort();
  state.activeTasks.delete(sessionId);
  return true;
}

function hasPendingStopFeedback(sessionId: string): boolean {
  return getState().pendingStopFeedback.has(sessionId);
}

function ensurePendingStopFeedback(
  sessionId: string,
  address: ChannelAddress,
  replyToMessageId?: string,
): void {
  const state = getState();
  if (state.pendingStopFeedback.has(sessionId)) return;
  state.pendingStopFeedback.set(sessionId, {
    address,
    replyToMessageId,
  });
}

function clearPendingStopFeedback(sessionId: string): void {
  getState().pendingStopFeedback.delete(sessionId);
}

async function sendPendingStopCompletion(
  adapter: BaseChannelAdapter,
  sessionId: string,
): Promise<void> {
  const pending = getState().pendingStopFeedback.get(sessionId);
  if (!pending) return;
  try {
    await deliver(adapter, {
      address: pending.address,
      text: 'Current task stopped.',
      parseMode: 'plain',
      replyToMessageId: pending.replyToMessageId,
    }, { sessionId });
  } catch (error) {
    console.warn(`[bridge-manager] Failed to send stop completion for session ${sessionId}:`, error);
  } finally {
    clearPendingStopFeedback(sessionId);
  }
}

function releasePlanWorkflowAfterStop(
  binding: import('./types.js').ChannelBinding,
  address: InboundMessage['address'],
): boolean {
  const { store, permissions } = getBridgeContext();
  const workflow = store.getActivePlanWorkflowByBinding(binding.id);
  if (!workflow) return false;
  if (workflow.approvalRequestId) {
    permissions.resolvePendingPermission?.(workflow.approvalRequestId, {
      behavior: 'deny',
      message: 'Interrupted by /stop',
      interrupt: true,
    });
  }
  store.updatePlanWorkflow(workflow.workflowId, {
    status: 'awaiting_input',
    requestText: '',
    address,
    routeKey: routeKeyForAddress(address),
    requestMessageId: '',
    planMessageId: '',
    actionCardMessageId: '',
    actionCardOpenMessageId: '',
    approvalRequestId: '',
    planText: '',
    planFilePath: '',
    allowedPrompts: null,
    activeAttemptId: '',
    pendingFollowUpText: '',
    pendingFollowUpAttachments: [],
    pendingRequestMessageId: '',
    pendingAddress: undefined,
    pendingRouteKey: '',
    resolved: true,
  });
  return true;
}

function isCodexRuntime(sessionId: string): boolean {
  const { store } = getBridgeContext();
  return store.getSessionExt(sessionId)?.runtime === 'codex';
}

function isApprovalRequest(perm: engine.PermissionRequestInfo): boolean {
  return typeof perm.method === 'string'
    && perm.method.trim().replace(/[_-]/g, '').toLowerCase().endsWith('requestapproval');
}

function resolveCodexCollaborationMode(
  binding: import('./types.js').ChannelBinding,
  planWorkflowMeta: NonNullable<InboundMessage['bridgeMeta']>['planWorkflow'] | null,
): 'plan' | 'default' | undefined {
  if (!isCodexRuntime(binding.codepilotSessionId)) return undefined;
  if (planWorkflowMeta?.collaborationMode) {
    return planWorkflowMeta.collaborationMode;
  }
  if (planWorkflowMeta?.kind === 'native_plan_request') {
    return 'plan';
  }
  if (binding.mode === 'plan') {
    return 'plan';
  }
  if (binding.mode === 'code') {
    return 'default';
  }
  return undefined;
}

function resolveClaudePermissionMode(
  binding: import('./types.js').ChannelBinding,
): ClaudePermissionMode {
  if (binding.claudePermissionMode) return binding.claudePermissionMode;
  switch (binding.mode) {
    case 'plan':
      return 'plan';
    case 'ask':
      return 'default';
    default:
      return 'acceptEdits';
  }
}

function isClaudePlanExitPermission(perm: engine.PermissionRequestInfo): boolean {
  return perm.toolName === 'ExitPlanMode';
}

function hasActivePreviewDraft(state: StreamingPreviewState): boolean {
  return !!(
    state.placeholderPrimed
    || state.lastSentText.trim()
    || state.pendingText.trim()
    || state.lastSentAt > 0
  );
}

async function dismissPreviewForConfirmationCard(
  adapter: BaseChannelAdapter,
  address: InboundMessage['address'],
  state: StreamingPreviewState | null,
): Promise<void> {
  if (!state) return;
  if (state.throttleTimer) {
    clearTimeout(state.throttleTimer);
    state.throttleTimer = null;
  }
  clearPrimeTimer(state);
  await settlePreview(state);
  if (hasActivePreviewDraft(state)) {
    adapter.endPreview?.(address, state.draftId);
    resetPreviewState(state);
  }
}

function buildClaudePlanExitButtons(
  workflowId: string,
  showClearContext: boolean,
): NonNullable<OutboundMessage['inlineButtons']> {
  const primary = [
    { text: CLAUDE_PLAN_EXIT_BYPASS_LABEL, callbackData: `planexit:approve:bypass:${workflowId}` },
    { text: CLAUDE_PLAN_EXIT_MANUAL_LABEL, callbackData: `planexit:approve:manual:${workflowId}` },
  ];
  const secondary = showClearContext
    ? [{ text: CLAUDE_PLAN_EXIT_CLEAR_BYPASS_LABEL, callbackData: `planexit:clear:bypass:${workflowId}` }]
    : [];
  return secondary.length > 0 ? [primary, secondary] : [primary];
}

function buildClaudePlanExitFallbackText(
  planText: string,
  allowedPrompts: Array<{ tool: string; prompt: string }>,
  showClearContext: boolean,
): string {
  const lines = [
    'Claude 已经写好计划，确认后会退出 PLAN 并继续执行。',
    '',
    truncateClaudePlanCardText(planText || 'Claude 已生成计划，请确认是否继续。'),
  ];
  if (allowedPrompts.length > 0) {
    lines.push('', '**执行时会申请的提示级权限**');
    for (const item of allowedPrompts) {
      lines.push(`- ${item.tool}: ${item.prompt}`);
    }
  }
  lines.push('', '如需继续规划，请直接在本线程回复你希望调整的地方。');
  if (showClearContext) {
    lines.push('也可以选择“清空上下文后执行”，桥会以新会话重新开始实施。');
  }
  lines.push('', buildInteractionTimeoutText(PENDING_PERMISSIONS_TIMEOUT_MS, '会自动拒绝'));
  return lines.join('\n');
}

function buildStructuredInputPreface(request: StructuredInputRequestInfo): string {
  const headers = request.questions
    .map((question) => question.header.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (headers.length > 0) {
    return `我先梳理了这个请求，继续前还需要确认 ${headers.join('、')}。你补充后我再继续。`;
  }
  return '我先梳理了这个请求，继续前还需要你补充一些关键信息。你回答下面问题后我再继续。';
}

const AUTO_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const ABSOLUTE_IMAGE_PATH_RE = /((?:\/|[A-Za-z]:[\\/])[^\s"'`<>|]+?\.(?:png|jpe?g|gif|webp))/gi;
const TOOL_RESULT_PATH_KEYS = new Set(['path', 'file', 'filePath', 'file_path']);

function isSupportedAutoImagePath(filePath: string): boolean {
  return AUTO_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of paths) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    ordered.push(candidate);
  }
  return ordered;
}

function extractAbsoluteImagePaths(text: string | undefined): string[] {
  if (!text) return [];
  const matches = text.matchAll(ABSOLUTE_IMAGE_PATH_RE);
  const found: string[] = [];
  for (const match of matches) {
    const rawPath = match[1]?.trim();
    if (!rawPath || !path.isAbsolute(rawPath) || !isSupportedAutoImagePath(rawPath)) continue;
    found.push(rawPath);
  }
  return uniquePaths(found);
}

function resolveFileChangeImagePath(rawPath: string, cwd?: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : (cwd ? path.resolve(cwd, trimmed) : null);
  if (!resolved || !isSupportedAutoImagePath(resolved)) return null;
  return resolved;
}

function isFreshNonEmptyFile(filePath: string, turnStartedAtMs: number): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 && stat.mtimeMs >= turnStartedAtMs;
  } catch {
    return false;
  }
}

function imageExtensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/png':
    default:
      return '.png';
  }
}

function resolveToolResultImagePath(rawPath: string, cwd?: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : (cwd ? path.resolve(cwd, trimmed) : null);
  if (!resolved || !isSupportedAutoImagePath(resolved)) return null;
  return resolved;
}

function collectToolResultImagePaths(
  value: unknown,
  cwd: string | undefined,
  currentKey: string | undefined,
  found: string[],
): void {
  if (typeof value === 'string') {
    found.push(...extractAbsoluteImagePaths(value));
    if (currentKey && TOOL_RESULT_PATH_KEYS.has(currentKey)) {
      const resolved = resolveToolResultImagePath(value, cwd);
      if (resolved) found.push(resolved);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectToolResultImagePaths(item, cwd, undefined, found));
    return;
  }
  if (!value || typeof value !== 'object') return;

  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    collectToolResultImagePaths(child, cwd, key, found);
  });
}

function extractToolResultImagePaths(blocks: MessageContentBlock[], cwd?: string): string[] {
  const found: string[] = [];

  for (const block of blocks) {
    if (block.type !== 'tool_result' || block.is_error) continue;
    found.push(...extractAbsoluteImagePaths(block.content));
    try {
      const parsed = JSON.parse(block.content);
      collectToolResultImagePaths(parsed, cwd, undefined, found);
    } catch {
      // Plain-text tool results are already covered by the raw content scan.
    }
  }

  return uniquePaths(found);
}

function extractInlineToolResultImagePayload(item: Record<string, unknown>): {
  mediaType: string;
  data: string;
} | null {
  if (item.type !== 'image') return null;

  const source = item.source;
  if (source && typeof source === 'object') {
    const imageSource = source as Record<string, unknown>;
    const mediaType = typeof imageSource.media_type === 'string' ? imageSource.media_type.trim() : '';
    const data = typeof imageSource.data === 'string' ? imageSource.data.trim() : '';
    if (imageSource.type === 'base64' && mediaType.startsWith('image/') && data) {
      return { mediaType, data };
    }
  }

  const mediaType = typeof item.mimeType === 'string'
    ? item.mimeType.trim()
    : typeof item.mime_type === 'string'
      ? item.mime_type.trim()
      : '';
  const data = typeof item.data === 'string' ? item.data.trim() : '';
  if (mediaType.startsWith('image/') && data) {
    return { mediaType, data };
  }

  return null;
}

function extractInlineToolResultImages(blocks: MessageContentBlock[]): Array<{
  digest: string;
  mediaType: string;
  data: string;
}> {
  const images: Array<{ digest: string; mediaType: string; data: string }> = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (block.type !== 'tool_result' || block.is_error) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(block.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const image = extractInlineToolResultImagePayload(item as Record<string, unknown>);
      if (!image) continue;
      const { mediaType, data } = image;
      const digest = createHash('sha1').update(data).digest('hex');
      if (seen.has(digest)) continue;
      seen.add(digest);
      images.push({ digest, mediaType, data });
    }
  }

  return images;
}

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * Feishu chats with at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(
  channelType: string,
  rawText: string,
  chatId: string,
  channelInstanceId?: string,
): boolean {
  if (channelType !== 'feishu') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId, channelType, channelInstanceId);
  return pending.length > 0; // any pending → route to inline path
}

/** Queue a preview draft update. Only degrades on permanent failure. */
function flushPreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  config: StreamConfig,
): void {
  if (state.degraded || !adapter.sendPreview) return;

  const text = state.pendingText.length > config.maxChars
    ? state.pendingText.slice(0, config.maxChars) + '...'
    : state.pendingText;
  if (!text.trim()) return;

  state.placeholderPrimed = false;
  state.lastSentText = text;
  state.lastSentAt = Date.now();
  const draftId = state.draftId;
  const send = async (): Promise<void> => {
    try {
      const result = await adapter.sendPreview!(state.address, text, draftId);
      if (state.draftId !== draftId) return;
      if (result === 'degrade') state.degraded = true;
      // 'skip' — transient failure, next flush will retry naturally
    } catch {
      // Network error — transient, don't degrade
    }
  };
  const previous = state.inFlightSend;
  const next = (previous
    ? previous.catch(() => undefined).then(send)
    : send()
  ).finally(() => {
    if (state.inFlightSend === next) {
      state.inFlightSend = null;
    }
  });
  state.inFlightSend = next;
}

function primePreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
): void {
  if (state.degraded || state.placeholderPrimed || !adapter.primePreview) return;

  const draftId = state.draftId;
  const send = async (): Promise<void> => {
    try {
      const result = await adapter.primePreview!(state.address, draftId);
      if (state.draftId !== draftId) return;
      if (result === 'sent') state.placeholderPrimed = true;
      if (result === 'degrade') state.degraded = true;
    } catch {
      // Network error — transient, don't degrade
    }
  };
  const previous = state.inFlightSend;
  const next = (previous
    ? previous.catch(() => undefined).then(send)
    : send()
  ).finally(() => {
    if (state.inFlightSend === next) {
      state.inFlightSend = null;
    }
  });
  state.inFlightSend = next;
}

function schedulePrimePreview(
  adapter: BaseChannelAdapter,
  state: StreamingPreviewState,
  delayMs: number,
): void {
  clearPrimeTimer(state);
  if (
    state.degraded
    || state.placeholderPrimed
    || state.lastSentText.trim()
    || state.pendingText.trim()
    || state.lastSentAt > 0
    || !adapter.primePreview
  ) {
    return;
  }

  const draftId = state.draftId;
  state.primeTimer = setTimeout(() => {
    state.primeTimer = null;
    if (
      state.degraded
      || state.draftId !== draftId
      || state.placeholderPrimed
      || state.lastSentText.trim()
      || state.pendingText.trim()
      || state.lastSentAt > 0
    ) {
      return;
    }
    primePreview(adapter, state);
  }, delayMs);
}

async function settlePreview(state: StreamingPreviewState | null): Promise<void> {
  if (!state?.inFlightSend) return;
  try {
    await state.inFlightSend;
  } catch {
    // best effort
  }
}

function resetPreviewState(state: StreamingPreviewState): void {
  if (state.throttleTimer) {
    clearTimeout(state.throttleTimer);
    state.throttleTimer = null;
  }
  clearPrimeTimer(state);
  state.draftId = generateDraftId();
  state.placeholderPrimed = false;
  state.lastSentText = '';
  state.lastSentAt = 0;
  state.pendingText = '';
  state.inFlightSend = null;
}

interface LightweightActivityState {
  current: Extract<ActivityEvent, { kind: 'lightweight_activity' }> | null;
  visible: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
}

function clearLightweightActivityTimer(state: LightweightActivityState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function normalizeCompletedLightweightText(text: string): string {
  const trimmed = text.trim().replace(/(?:\.\.\.|…)+$/u, '').trim();
  if (!trimmed) return '已完成当前步骤';
  if (trimmed.startsWith('已')) return trimmed;
  if (trimmed.startsWith('正在')) {
    return `已${trimmed.slice(2).trimStart()}`.trim();
  }
  return `已完成：${trimmed}`;
}

function finalizeLightweightActivity(
  event: Extract<ActivityEvent, { kind: 'lightweight_activity' }> | null,
): Extract<ActivityEvent, { kind: 'lightweight_activity' }> | null {
  if (!event || event.status !== 'running') return event;
  return {
    ...event,
    status: 'completed',
    text: normalizeCompletedLightweightText(event.text),
  };
}

function queueLightweightActivityUpsert(
  adapter: BaseChannelAdapter,
  state: LightweightActivityState,
  address: ChannelAddress,
  event: Extract<ActivityEvent, { kind: 'lightweight_activity' }>,
  replyToMessageId?: string,
): Promise<void> {
  const send = async (): Promise<void> => {
    await adapter.upsertActivityEvent?.(address, event, replyToMessageId);
  };
  const previous = state.inFlight;
  const next = (previous
    ? previous.catch(() => undefined).then(send)
    : send()
  ).finally(() => {
    if (state.inFlight === next) {
      state.inFlight = null;
    }
  });
  state.inFlight = next;
  return next;
}

async function settleLightweightActivity(state: LightweightActivityState | null): Promise<void> {
  if (!state?.inFlight) return;
  try {
    await state.inFlight;
  } catch {
    // best effort
  }
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress } from './types.js';

/**
 * Render response text and deliver it through the Feishu adapter.
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'Markdown',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface PendingStopFeedback {
  address: ChannelAddress;
  replyToMessageId?: string;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  pendingStopFeedback: Map<string, PendingStopFeedback>;
  /** Per-session processing chains for concurrency control */
  sessionLocks: Map<string, Promise<void>>;
  autoStartChecked: boolean;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapters: new Map(),
      adapterMeta: new Map(),
      running: false,
      startedAt: null,
      loopAborts: new Map(),
      activeTasks: new Map(),
      pendingStopFeedback: new Map(),
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
  }
  if (!g[GLOBAL_KEY].pendingStopFeedback) {
    g[GLOBAL_KEY].pendingStopFeedback = new Map();
  }
  return g[GLOBAL_KEY];
}

/**
 * Process a function with per-session serialization.
 * Different sessions run concurrently; same-session requests are serialized.
 */
function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  state.sessionLocks.set(sessionId, current);
  // Cleanup when the chain completes.
  // Suppress rejection on the cleanup chain — callers handle errors on `current` directly.
  current.finally(() => {
    if (state.sessionLocks.get(sessionId) === current) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

/**
 * Start the bridge system.
 * Checks feature flags, registers enabled adapters, starts polling loops.
 */
export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const { store, lifecycle } = getBridgeContext();

  const bridgeEnabled = store.getSetting('remote_bridge_enabled') === 'true';
  if (!bridgeEnabled) {
    console.log('[bridge-manager] Bridge not enabled (remote_bridge_enabled != true)');
    return;
  }

  // Backward compatibility for adapters that still self-register through the
  // factory registry. Explicitly registered adapters win and can coexist even
  // when they share the same channelType.
  if (state.adapters.size === 0) {
    for (const channelType of getRegisteredTypes()) {
      const settingKey = `bridge_${channelType}_enabled`;
      if (store.getSetting(settingKey) !== 'true') continue;

      const adapter = createAdapter(channelType);
      if (!adapter) continue;

      const configError = adapter.validateConfig();
      if (!configError) {
        registerAdapter(adapter);
      } else {
        console.warn(`[bridge-manager] ${channelType} adapter not valid:`, configError);
      }
    }
  }

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [adapterId, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${adapterId} (${adapter.channelType})`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${adapterId}:`, err);
    }
  }

  // Only mark as running if at least one adapter started successfully
  if (startedCount === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters.clear();
    state.adapterMeta.clear();
    return;
  }

  // Mark running BEFORE starting consumer loops — runAdapterLoop checks
  // state.running in its while-condition, so it must be true first.
  state.running = true;
  state.startedAt = new Date().toISOString();

  // Notify host that bridge is starting (e.g., suppress competing polling)
  lifecycle.onBridgeStart?.();

  // Now start the consumer loops (state.running is already true)
  for (const [, adapter] of state.adapters) {
    if (adapter.isRunning()) {
      runAdapterLoop(adapter);
    }
  }

  console.log(`[bridge-manager] Bridge started with ${startedCount} adapter(s)`);
}

/**
 * Stop the bridge system gracefully.
 */
export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  const { lifecycle } = getBridgeContext();

  state.running = false;

  // Abort all event loops
  for (const [, abort] of state.loopAborts) {
    abort.abort();
  }
  state.loopAborts.clear();
  state.pendingStopFeedback.clear();

  // Stop all adapters
  for (const [adapterId, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${adapterId}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${adapterId}:`, err);
    }
  }

  state.adapters.clear();
  state.adapterMeta.clear();
  state.startedAt = null;

  // Notify host that bridge stopped
  lifecycle.onBridgeStop?.();

  console.log('[bridge-manager] Bridge stopped');
}

/**
 * Lazy auto-start: checks bridge_auto_start setting once and starts if enabled.
 * Called from POST /api/bridge with action 'auto-start' (triggered by Electron on startup).
 */
export function tryAutoStart(): void {
  const state = getState();
  if (state.autoStartChecked) return;
  state.autoStartChecked = true;

  if (state.running) return;

  const { store } = getBridgeContext();
  const autoStart = store.getSetting('bridge_auto_start');
  if (autoStart !== 'true') return;

  start().catch(err => {
    console.error('[bridge-manager] Auto-start failed:', err);
  });
}

/**
 * Get the current bridge status.
 */
export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: Array.from(state.adapters.entries()).map(([adapterId, adapter]) => {
      const meta = state.adapterMeta.get(adapterId);
      return {
        adapterId,
        channelType: adapter.channelType,
        profileId: adapter.profileId,
        label: adapter.label,
        running: adapter.isRunning(),
        connectedAt: state.startedAt,
        lastMessageAt: meta?.lastMessageAt ?? null,
        error: meta?.lastError ?? null,
      };
    }),
  };
}

/**
 * Register a channel adapter.
 */
export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  state.adapters.set(adapter.adapterId, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const adapterKey = adapter.adapterId;
  const abort = new AbortController();
  state.loopAborts.set(adapterKey, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for Feishu MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(
            adapter.channelType,
            msg.text.trim(),
            msg.address.chatId,
            msg.address.channelInstanceId,
          )
        ) {
          await handleMessage(adapter, msg);
        } else {
          const binding = router.resolve(msg.address);
          // Fire-and-forget into session lock — loop continues to accept
          // messages for other sessions immediately.
          processWithSessionLock(binding.codepilotSessionId, () =>
            handleMessage(adapter, msg),
          ).catch(err => {
            console.error(`[bridge-manager] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
          });
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapterKey} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapterKey) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapterKey, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapterKey} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapterKey) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapterKey, meta);
    }
  });
}

/**
 * Handle a single inbound message.
 */
async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
): Promise<void> {
  const { store } = getBridgeContext();

  // Update lastMessageAt for this adapter
  const adapterState = getState();
  const meta = adapterState.adapterMeta.get(adapter.adapterId) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.adapterId, meta);

  // Acknowledge the update offset after processing completes (or fails).
  // This ensures the adapter only advances its committed offset once the
  // message has been fully handled, preventing message loss on crash.
  const ack = () => {
    if (msg.updateId != null && adapter.acknowledgeUpdate) {
      adapter.acknowledgeUpdate(msg.updateId);
    }
  };

  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(
      msg.callbackData,
      msg.address.chatId,
      msg.callbackMessageId,
      {
        channelType: msg.address.channelType,
        channelInstanceId: msg.address.channelInstanceId,
      },
    );
    if (handled) {
      // Send confirmation
      const confirmMsg: OutboundMessage = {
        address: msg.address,
        text: 'Permission response recorded.',
        parseMode: 'plain',
      };
      await deliver(adapter, confirmMsg);
    }
    ack();
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;
  const planWorkflowMeta = getPlanWorkflowMeta(msg);

  // Handle image-only download failures — surface error to user instead of silently dropping
  if (!rawText && !hasAttachments) {
    const rawData = msg.raw as { imageDownloadFailed?: boolean; failedCount?: number } | undefined;
    if (rawData?.imageDownloadFailed) {
      await deliver(adapter, {
        address: msg.address,
        text: `Failed to download ${rawData.failedCount ?? 1} image(s). Please try sending again.`,
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      });
    }
    ack();
    return;
  }

  // ── Numeric shortcut for permission replies (Feishu only) ──
  // On some mobile clients, a short numeric reply is more reliable than
  // returning to the original approval UI.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(
        msg.address.chatId,
        msg.address.channelType,
        msg.address.channelInstanceId,
      );
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId, undefined, {
          channelType: msg.address.channelType,
          channelInstanceId: msg.address.channelInstanceId,
        });
        const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
        if (handled) {
          await deliver(adapter, {
            address: msg.address,
            text: `${label}: recorded.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        } else {
          await deliver(adapter, {
            address: msg.address,
            text: `Permission not found or already resolved.`,
            parseMode: 'plain',
            replyToMessageId: msg.messageId,
          });
        }
        ack();
        return;
      }
      if (pendingLinks.length > 1) {
        // Multiple pending permissions — numeric shortcut is ambiguous.
        await deliver(adapter, {
          address: msg.address,
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the original permission card or wait until only one request is pending.`,
          parseMode: 'plain',
          replyToMessageId: msg.messageId,
        });
        ack();
        return;
      }
      // pendingLinks.length === 0: no pending permissions, fall through as normal message
    } else if (rawText !== normalized && /^[123]$/.test(rawText) === false) {
      // Log when normalization changed the text — helps diagnose encoding issues
      const codePoints = [...rawText].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
      console.log(`[bridge-manager] Shortcut candidate raw codepoints: ${codePoints.join(' ')} → normalized: "${normalized}"`);
    }
  }

  // Check for IM commands (before sanitization — commands are validated individually)
  if (rawText.startsWith('/')) {
    await handleCommand(adapter, msg, rawText);
    ack();
    return;
  }

  // Sanitize general message text before routing to conversation engine
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge-manager] Input truncated from ${rawText.length} to ${text.length} chars for chat ${msg.address.chatId}`);
    store.insertAuditLog({
      channelType: adapter.channelType,
      channelInstanceId: msg.address.channelInstanceId || adapter.profileId,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);
  const effectivePlanWorkflowMeta = (() => {
    if (planWorkflowMeta) return planWorkflowMeta;
    const requestText = text || (hasAttachments ? 'Describe this image.' : '');
    if (isCodexRuntime(binding.codepilotSessionId)) {
      if (binding.mode !== 'plan') return null;
      const attemptId = createPlanAttemptId();
      const workflow = store.upsertPlanWorkflow({
        bindingId: binding.id,
        channelType: adapter.channelType,
        channelInstanceId: msg.address.channelInstanceId || adapter.profileId,
        chatId: msg.address.chatId,
        codepilotSessionId: binding.codepilotSessionId,
        status: 'planning',
        previousMode: binding.mode,
        requestText,
        address: msg.address,
        routeKey: routeKeyForAddress(msg.address),
        requestMessageId: msg.messageId,
        activeAttemptId: attemptId,
        pendingFollowUpText: '',
        pendingFollowUpAttachments: [],
        pendingRequestMessageId: '',
        pendingAddress: undefined,
        pendingRouteKey: '',
        resolved: true,
      });
      return {
        kind: 'native_plan_request' as const,
        workflowId: workflow.workflowId,
        attemptId,
        promptText: requestText,
        storedUserText: requestText,
        permissionMode: 'plan' as const,
        collaborationMode: 'plan' as const,
      };
    }
    if (resolveClaudePermissionMode(binding) !== 'plan') return null;
    const attemptId = createPlanAttemptId();
    const workflow = store.upsertPlanWorkflow({
      bindingId: binding.id,
      channelType: adapter.channelType,
      channelInstanceId: msg.address.channelInstanceId || adapter.profileId,
      chatId: msg.address.chatId,
      codepilotSessionId: binding.codepilotSessionId,
      status: 'planning',
      previousMode: binding.mode,
      requestText,
      address: msg.address,
      routeKey: routeKeyForAddress(msg.address),
      requestMessageId: msg.messageId,
      activeAttemptId: attemptId,
      pendingFollowUpText: '',
      pendingFollowUpAttachments: [],
      pendingRequestMessageId: '',
      pendingAddress: undefined,
      pendingRouteKey: '',
      resolved: true,
    });
    return {
      kind: 'plan_request' as const,
      workflowId: workflow.workflowId,
      attemptId,
      promptText: requestText,
      storedUserText: requestText,
      permissionMode: 'plan' as const,
    };
  })();
  if (effectivePlanWorkflowMeta?.attemptId && !isPlanAttemptCurrent(effectivePlanWorkflowMeta)) {
    ack();
    return;
  }
  if (effectivePlanWorkflowMeta?.workflowId && effectivePlanWorkflowMeta.attemptId) {
    const workflow = store.getPlanWorkflow(effectivePlanWorkflowMeta.workflowId);
    if (
      workflow
      && workflow.activeAttemptId === effectivePlanWorkflowMeta.attemptId
      && workflow.status === 'interrupting'
    ) {
      store.updatePlanWorkflow(workflow.workflowId, {
        status: 'planning',
        requestText: effectivePlanWorkflowMeta.storedUserText || text || '',
        address: msg.address,
        routeKey: routeKeyForAddress(msg.address),
        requestMessageId: msg.messageId,
        pendingFollowUpText: '',
        pendingFollowUpAttachments: [],
        pendingRequestMessageId: '',
        pendingAddress: undefined,
        pendingRouteKey: '',
        resolved: true,
      });
    }
  }
  const turnStartedAtMs = Date.now();
  const sentAutoImagePaths = new Set<string>();
  const sentInlineToolResultImageDigests = new Set<string>();
  const autoImageSendEnabled = !!adapter.sendImage;

  // Notify adapter that message processing is starting (e.g., typing indicator)
  adapter.onMessageStart?.(msg.address);

  // Create an AbortController so /stop can cancel this task externally
  const taskAbort = new AbortController();
  const state = getState();
  state.activeTasks.set(binding.codepilotSessionId, taskAbort);

  // ── Streaming preview setup ──────────────────────────────────
  let previewState: StreamingPreviewState | null = null;
  const caps = adapter.getPreviewCapabilities?.(msg.address) ?? null;
  if (caps?.supported) {
    previewState = {
      draftId: generateDraftId(),
      address: msg.address,
      placeholderPrimed: false,
      primeTimer: null,
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
      inFlightSend: null,
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;
  const activityDelayMs = getStreamConfig(adapter.channelType).primeDelayMs;
  const previewFinalDelivery = caps?.finalDelivery || 'separate_message';
  const previewFinalizesPerSegment = previewFinalDelivery === 'segment_replace_preview';
  const lightweightActivityState: LightweightActivityState | null = adapter.upsertActivityEvent
    ? {
        current: null,
        visible: false,
        timer: null,
        inFlight: null,
      }
    : null;
  const activeActivityIdByRawKey = new Map<string, string>();
  const activeRawKeysByActivityId = new Map<string, Set<string>>();
  const activeCommandActivityBySignature = new Map<string, string>();
  const activeFileActivityBySignature = new Map<string, string>();
  const activityVersionBySignature = new Map<string, number>();
  const activitySignatureById = new Map<string, string>();
  let hasVisibleProgressCard = false;
  const planAttemptIsCurrent = (): boolean => isPlanAttemptCurrent(effectivePlanWorkflowMeta);

  const compactActivityText = (value: string | undefined): string => (value || '').replace(/\s+/g, ' ').trim();

  const activitySignatureToken = (signature: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < signature.length; index += 1) {
      hash ^= signature.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };

  const nextActivitySlotId = (
    prefix: 'command' | 'file',
    turnScope: string,
    signature: string,
  ): string => {
    const current = activityVersionBySignature.get(signature) || 0;
    const next = current + 1;
    activityVersionBySignature.set(signature, next);
    return `${prefix}:${turnScope}:${activitySignatureToken(signature)}:${next}`;
  };

  const bindActiveRawKey = (rawKey: string, canonical: string): void => {
    activeActivityIdByRawKey.set(rawKey, canonical);
    let rawKeys = activeRawKeysByActivityId.get(canonical);
    if (!rawKeys) {
      rawKeys = new Set<string>();
      activeRawKeysByActivityId.set(canonical, rawKeys);
    }
    rawKeys.add(rawKey);
  };

  const unbindActiveRawKey = (rawKey: string, canonical: string): void => {
    activeActivityIdByRawKey.delete(rawKey);
    const rawKeys = activeRawKeysByActivityId.get(canonical);
    if (!rawKeys) return;
    rawKeys.delete(rawKey);
    if (rawKeys.size === 0) {
      activeRawKeysByActivityId.delete(canonical);
    }
  };

  const clearActiveCommandActivity = (canonical: string): void => {
    const signature = activitySignatureById.get(canonical);
    if (signature && activeCommandActivityBySignature.get(signature) === canonical) {
      activeCommandActivityBySignature.delete(signature);
    }
    const rawKeys = activeRawKeysByActivityId.get(canonical);
    if (rawKeys) {
      for (const rawKey of rawKeys) {
        activeActivityIdByRawKey.delete(rawKey);
      }
      activeRawKeysByActivityId.delete(canonical);
    }
  };

  const clearActiveFileActivity = (canonical: string): void => {
    const signature = activitySignatureById.get(canonical);
    if (signature && activeFileActivityBySignature.get(signature) === canonical) {
      activeFileActivityBySignature.delete(signature);
    }
    const rawKeys = activeRawKeysByActivityId.get(canonical);
    if (rawKeys) {
      for (const rawKey of rawKeys) {
        activeActivityIdByRawKey.delete(rawKey);
      }
      activeRawKeysByActivityId.delete(canonical);
    }
  };

  const normalizeCommandActivityId = (
    event: Extract<ActivityEvent, { kind: 'command_execution' }>,
    turnScope: string,
  ): string => {
    const rawKey = `command:${event.id}`;
    const signature = `command:${turnScope}:${compactActivityText(event.command)}:${event.cwd || ''}`;
    const aliased = activeActivityIdByRawKey.get(rawKey);
    if (aliased) {
      const currentSignature = activitySignatureById.get(aliased);
      if (!currentSignature || currentSignature === signature) {
        activitySignatureById.set(aliased, signature);
        if (event.status === 'running') {
          activeCommandActivityBySignature.set(signature, aliased);
        } else {
          clearActiveCommandActivity(aliased);
        }
        return aliased;
      }
      unbindActiveRawKey(rawKey, aliased);
    }
    const active = activeCommandActivityBySignature.get(signature);
    const canonical = active || nextActivitySlotId('command', turnScope, signature);
    activitySignatureById.set(canonical, signature);
    bindActiveRawKey(rawKey, canonical);
    if (event.status === 'running') {
      activeCommandActivityBySignature.set(signature, canonical);
    } else {
      clearActiveCommandActivity(canonical);
    }
    return canonical;
  };

  const normalizeFileActivityId = (
    event: Extract<ActivityEvent, { kind: 'file_change' }>,
    turnScope: string,
  ): string => {
    const rawKey = `file:${event.id}`;
    const signaturePayload = event.changes.length > 0
      ? event.changes
          .map((change) => `${change.kind}:${change.path}`)
          .sort()
          .join('|')
      : compactActivityText(event.summary);
    const signature = `file:${turnScope}:${signaturePayload}`;
    const aliased = activeActivityIdByRawKey.get(rawKey);
    if (aliased) {
      const currentSignature = activitySignatureById.get(aliased);
      if (!currentSignature || currentSignature === signature) {
        activitySignatureById.set(aliased, signature);
        if (event.status === 'running') {
          activeFileActivityBySignature.set(signature, aliased);
        } else {
          clearActiveFileActivity(aliased);
        }
        return aliased;
      }
      unbindActiveRawKey(rawKey, aliased);
    }
    const active = activeFileActivityBySignature.get(signature);
    const canonical = active || nextActivitySlotId('file', turnScope, signature);
    activitySignatureById.set(canonical, signature);
    bindActiveRawKey(rawKey, canonical);
    if (event.status === 'running') {
      activeFileActivityBySignature.set(signature, canonical);
    } else {
      clearActiveFileActivity(canonical);
    }
    return canonical;
  };

  const normalizeActivityEvent = (event: ActivityEvent): ActivityEvent => {
    const turnScope = event.turnId || msg.messageId;
    switch (event.kind) {
      case 'lightweight_activity':
        return { ...event, id: `lightweight-slot:${turnScope}` };
      case 'reasoning_activity':
        return { ...event, turnId: turnScope };
      case 'tool_activity':
        return { ...event, turnId: turnScope };
      case 'command_execution':
        return { ...event, id: normalizeCommandActivityId(event, turnScope) };
      case 'file_change':
        return { ...event, id: normalizeFileActivityId(event, turnScope) };
      case 'context_usage':
        return { ...event, id: `context:${turnScope}` };
    }
  };

  const dismissPlaceholderPreviewIfIdle = async (): Promise<void> => {
    if (!previewState) return;
    clearPrimeTimer(previewState);
    if (previewState.throttleTimer) {
      clearTimeout(previewState.throttleTimer);
      previewState.throttleTimer = null;
    }
    if (
      previewState.placeholderPrimed
      && !previewState.lastSentText.trim()
      && !previewState.pendingText.trim()
      && previewState.lastSentAt === 0
    ) {
      await settlePreview(previewState);
      adapter.endPreview?.(msg.address, previewState.draftId);
      resetPreviewState(previewState);
    }
  };

  const markProgressCardVisible = async (): Promise<void> => {
    hasVisibleProgressCard = true;
    await dismissPlaceholderPreviewIfIdle();
  };

  const cancelPendingLightweightActivity = (): void => {
    if (!lightweightActivityState) return;
    clearLightweightActivityTimer(lightweightActivityState);
  };

  const upsertLightweightActivityNow = async (
    event: Extract<ActivityEvent, { kind: 'lightweight_activity' }>,
  ): Promise<void> => {
    if (!lightweightActivityState) return;
    clearLightweightActivityTimer(lightweightActivityState);
    lightweightActivityState.current = event;
    lightweightActivityState.visible = true;
    await queueLightweightActivityUpsert(
      adapter,
      lightweightActivityState,
      msg.address,
      event,
      msg.messageId,
    );
  };

  const scheduleLightweightActivity = (
    event: Extract<ActivityEvent, { kind: 'lightweight_activity' }>,
  ): void => {
    if (!lightweightActivityState) return;
    clearLightweightActivityTimer(lightweightActivityState);
    lightweightActivityState.current = event;
    lightweightActivityState.timer = setTimeout(() => {
      lightweightActivityState.timer = null;
      if (
        !lightweightActivityState.current
        || lightweightActivityState.visible
        || lightweightActivityState.current.id !== event.id
        || lightweightActivityState.current.text !== event.text
        || lightweightActivityState.current.status !== event.status
      ) {
        return;
      }
      lightweightActivityState.visible = true;
      void queueLightweightActivityUpsert(
        adapter,
        lightweightActivityState,
        msg.address,
        event,
        msg.messageId,
      );
    }, activityDelayMs);
  };

  const finalizeVisibleLightweightActivity = async (): Promise<void> => {
    if (!lightweightActivityState?.visible) return;
    if (lightweightActivityState.current?.status !== 'running') return;
    const finalized = finalizeLightweightActivity(lightweightActivityState.current);
    if (!finalized) return;
    lightweightActivityState.current = finalized;
    await queueLightweightActivityUpsert(
      adapter,
      lightweightActivityState,
      msg.address,
      finalized,
      msg.messageId,
    );
  };

  const maybeSendAutoImages = async (event: ActivityEvent): Promise<void> => {
    if (!planAttemptIsCurrent()) return;
    if (!autoImageSendEnabled || !adapter.sendImage) return;
    if (event.kind !== 'command_execution' && event.kind !== 'file_change') return;
    if (event.status !== 'completed') return;

    let candidates: string[] = [];
    if (event.kind === 'file_change') {
      candidates = uniquePaths(
        event.changes
          .map((change) => resolveFileChangeImagePath(change.path, binding.workingDirectory))
          .filter((candidate): candidate is string => Boolean(candidate)),
      );
    } else {
      candidates = uniquePaths([
        ...extractAbsoluteImagePaths(event.command),
        ...extractAbsoluteImagePaths(event.output),
      ]);
    }

    for (const candidate of candidates) {
      const normalizedPath = path.resolve(candidate);
      if (sentAutoImagePaths.has(normalizedPath)) continue;
      if (!isFreshNonEmptyFile(normalizedPath, turnStartedAtMs)) continue;
      try {
        const result = await adapter.sendImage({
          address: msg.address,
          filePath: normalizedPath,
          replyToMessageId: msg.messageId,
        });
        if (result.ok) {
          sentAutoImagePaths.add(normalizedPath);
        } else {
          console.warn(
            `[bridge-manager] Failed to auto-send image ${normalizedPath}: ${result.error || 'unknown error'}`,
          );
        }
      } catch (error) {
        console.warn(`[bridge-manager] Failed to auto-send image ${normalizedPath}:`, error);
      }
    }
  };

  const maybeSendToolResultImages = async (blocks: MessageContentBlock[]): Promise<void> => {
    if (!planAttemptIsCurrent()) return;
    if (!autoImageSendEnabled || !adapter.sendImage) return;

    const pathCandidates = extractToolResultImagePaths(blocks, binding.workingDirectory);
    for (const candidate of pathCandidates) {
      const normalizedPath = path.resolve(candidate);
      if (sentAutoImagePaths.has(normalizedPath)) continue;
      if (!isFreshNonEmptyFile(normalizedPath, turnStartedAtMs)) continue;
      try {
        const result = await adapter.sendImage({
          address: msg.address,
          filePath: normalizedPath,
          replyToMessageId: msg.messageId,
        });
        if (result.ok) {
          sentAutoImagePaths.add(normalizedPath);
        } else {
          console.warn(
            `[bridge-manager] Failed to auto-send tool-result image ${normalizedPath}: ${result.error || 'unknown error'}`,
          );
        }
      } catch (error) {
        console.warn(`[bridge-manager] Failed to auto-send tool-result image ${normalizedPath}:`, error);
      }
    }

    const images = extractInlineToolResultImages(blocks);
    for (const image of images) {
      if (sentInlineToolResultImageDigests.has(image.digest)) continue;
      const tempPath = path.join(
        os.tmpdir(),
        `cti-inline-tool-result-${image.digest}${imageExtensionForMediaType(image.mediaType)}`,
      );
      try {
        fs.writeFileSync(tempPath, Buffer.from(image.data, 'base64'));
        const result = await adapter.sendImage({
          address: msg.address,
          filePath: tempPath,
          replyToMessageId: msg.messageId,
        });
        if (result.ok) {
          sentInlineToolResultImageDigests.add(image.digest);
        } else {
          console.warn(
            `[bridge-manager] Failed to auto-send inline tool-result image ${image.digest}: ${result.error || 'unknown error'}`,
          );
        }
      } catch (error) {
        console.warn(`[bridge-manager] Failed to auto-send inline tool-result image ${image.digest}:`, error);
      } finally {
        try {
          fs.rmSync(tempPath, { force: true });
        } catch {
          // Best effort cleanup.
        }
      }
    }
  };

  const handleActivityEvent = async (event: ActivityEvent): Promise<void> => {
    if (!planAttemptIsCurrent()) return;
    if (event.kind !== 'context_usage') {
      await maybeSendAutoImages(event);
    }
    if (!adapter.upsertActivityEvent) return;
    if (event.kind === 'context_usage') return;
    const normalized = normalizeActivityEvent(event);
    const shouldProjectActivity = adapter.shouldProjectActivityEvent?.(normalized) ?? true;
    if (!shouldProjectActivity) return;
    await markProgressCardVisible();
    if (normalized.kind === 'lightweight_activity') {
      if (
        lightweightActivityState?.current
        && lightweightActivityState.current.id === normalized.id
        && lightweightActivityState.current.status === normalized.status
        && lightweightActivityState.current.text === normalized.text
      ) {
        return;
      }
      if (normalized.status === 'running' && !lightweightActivityState?.visible) {
        scheduleLightweightActivity(normalized);
        return;
      }
      await upsertLightweightActivityNow(normalized);
      return;
    }
    await adapter.upsertActivityEvent(msg.address, normalized, msg.messageId);
  };

  // Build the onPartialText callback (or undefined if preview not supported)
  const onPartialText = (previewState && streamCfg) ? (fullText: string) => {
    if (!planAttemptIsCurrent()) return;
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;
    clearPrimeTimer(ps);

    // Truncate to maxChars + ellipsis
    ps.pendingText = fullText.length > cfg.maxChars
      ? fullText.slice(0, cfg.maxChars) + '...'
      : fullText;

    const delta = ps.pendingText.length - ps.lastSentText.length;
    const elapsed = Date.now() - ps.lastSentAt;

    if (delta < cfg.minDeltaChars && ps.lastSentAt > 0) {
      // Not enough new content — schedule trailing-edge timer if not already set
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs);
      }
      return;
    }

    if (elapsed < cfg.intervalMs && ps.lastSentAt > 0) {
      // Too soon — schedule trailing-edge timer to ensure latest text is sent
      if (!ps.throttleTimer) {
        ps.throttleTimer = setTimeout(() => {
          ps.throttleTimer = null;
          if (!ps.degraded) flushPreview(adapter, ps, cfg);
        }, cfg.intervalMs - elapsed);
      }
      return;
    }

    // Clear any pending trailing-edge timer and flush immediately
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    flushPreview(adapter, ps, cfg);
  } : undefined;

  let previewClosed = false;
  let streamedSegmentCount = 0;
  let streamedSegmentDelivery: SendResult | null = null;
  let hasVisibleAssistantOutput = false;

  const onResponseSegment = (previewState && (
    previewFinalDelivery === 'separate_message' || previewFinalizesPerSegment
  )) ? async (segmentText: string) => {
    if (!planAttemptIsCurrent()) return;
    const normalized = segmentText.trim();
    if (!normalized) return;
    const ps = previewState!;
    cancelPendingLightweightActivity();
    clearPrimeTimer(ps);
    if (ps.throttleTimer) {
      clearTimeout(ps.throttleTimer);
      ps.throttleTimer = null;
    }
    await settlePreview(ps);
    const delivery = await deliverResponse(
      adapter,
      msg.address,
      normalized,
      binding.codepilotSessionId,
      msg.messageId,
    );
    if (delivery.ok) {
      streamedSegmentCount += 1;
      streamedSegmentDelivery = delivery;
      hasVisibleAssistantOutput = true;
      await finalizeVisibleLightweightActivity();
    }
    adapter.endPreview?.(msg.address, ps.draftId);
    resetPreviewState(ps);
    if (delivery.ok && !hasVisibleProgressCard) {
      schedulePrimePreview(adapter, ps, streamCfg!.primeDelayMs);
    }
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = effectivePlanWorkflowMeta?.promptText || text || (hasAttachments ? 'Describe this image.' : '');
    const storedUserText = effectivePlanWorkflowMeta?.storedUserText || text || (hasAttachments ? 'Describe this image.' : '');
    const sendClaudePlanConfirmationCard = async (
      workflowId: string,
      planText: string,
      allowedPrompts: Array<{ tool: string; prompt: string }>,
      showClearContext: boolean,
      approvalRequestId: string,
      planFilePath: string,
    ): Promise<boolean> => {
      if (!planAttemptIsCurrent()) return false;
      const workflow = store.getPlanWorkflow(workflowId);
      if (!workflow) return false;
      hasVisibleProgressCard = true;
      cancelPendingLightweightActivity();
      await dismissPreviewForConfirmationCard(adapter, msg.address, previewState);
      const approvalMessage: OutboundMessage = adapter.channelType === 'feishu'
        ? {
            address: msg.address,
            text: '',
            rawCard: buildClaudePlanExitCard(workflow.workflowId, planText, allowedPrompts, showClearContext),
            replyToMessageId: msg.messageId,
          }
        : {
            address: msg.address,
            text: buildClaudePlanExitFallbackText(planText, allowedPrompts, showClearContext),
            parseMode: 'Markdown',
            inlineButtons: buildClaudePlanExitButtons(workflow.workflowId, showClearContext),
            replyToMessageId: msg.messageId,
            cardHeader: {
              title: '计划已就绪',
              template: 'blue',
            },
          };
      let cardDelivery: SendResult;
      try {
        cardDelivery = await deliver(adapter, approvalMessage, { sessionId: binding.codepilotSessionId });
      } catch (error) {
        console.warn('[bridge-manager] Failed to send Claude plan confirmation card:', error);
        return false;
      }
      if (!cardDelivery.ok) return false;
      store.updatePlanWorkflow(workflow.workflowId, {
        status: 'awaiting_confirmation',
        approvalRequestId,
        planText,
        planFilePath,
        allowedPrompts,
        actionCardMessageId: cardDelivery.messageId || '',
        actionCardOpenMessageId: cardDelivery.openMessageId || '',
        resolved: false,
      });
      return true;
    };

    const result = await engine.processMessage(binding, promptText, async (perm) => {
      if (!planAttemptIsCurrent()) {
        getBridgeContext().permissions.resolvePendingPermission?.(perm.permissionRequestId, {
          behavior: 'deny',
          message: 'Interrupted by a newer PLAN follow-up',
          interrupt: true,
        });
        return;
      }
      const workflowId = effectivePlanWorkflowMeta?.workflowId;
      const workflow = workflowId ? store.getPlanWorkflow(workflowId) : null;
      const isClaudePlanExit =
        effectivePlanWorkflowMeta?.kind === 'plan_request'
        && workflow
        && !isCodexRuntime(binding.codepilotSessionId)
        && isClaudePlanExitPermission(perm);

      if (isClaudePlanExit) {
        const planText = parseClaudePlanText(perm.toolInput);
        const planFilePath = parseClaudePlanFilePath(perm.toolInput);
        const allowedPrompts = parseClaudeAllowedPrompts(perm.toolInput);
        const showClearContext = true;
      const sent = await sendClaudePlanConfirmationCard(
        workflow.workflowId,
        planText,
        allowedPrompts,
        showClearContext,
          perm.permissionRequestId,
          planFilePath,
      );
      if (sent) {
        return;
      }

        store.updatePlanWorkflow(workflow.workflowId, {
          status: 'awaiting_confirmation',
          approvalRequestId: perm.permissionRequestId,
          planText,
          planFilePath,
          allowedPrompts,
          resolved: false,
        });
        return;
      }

      hasVisibleProgressCard = true;
      await dismissPlaceholderPreviewIfIdle();
      await broker.forwardPermissionRequest(
        adapter,
        msg.address,
        perm.permissionRequestId,
        perm.toolName,
        perm.toolInput,
        binding.codepilotSessionId,
        perm.suggestions,
        msg.messageId,
      );
    }, taskAbort.signal, hasAttachments ? msg.attachments : undefined, onPartialText, {
      storedUserText,
      permissionModeOverride: effectivePlanWorkflowMeta?.permissionMode,
      collaborationModeOverride: resolveCodexCollaborationMode(binding, effectivePlanWorkflowMeta),
      onModeChanged: async (mode) => {
        if (!planAttemptIsCurrent()) return;
        if (isCodexRuntime(binding.codepilotSessionId)) return;
        if (binding.claudePermissionMode === mode) return;
        store.updateChannelBinding(binding.id, { claudePermissionMode: mode, mode: 'code' });
        binding.claudePermissionMode = mode;
        binding.mode = 'code';
        if (adapter.channelType === 'feishu') {
          const feishuAdapter = adapter as BaseChannelAdapter & { syncChatName?: (chatId: string) => Promise<void> };
          await feishuAdapter.syncChatName?.(msg.address.chatId);
        }
      },
    }, async (request: StructuredInputRequestInfo) => {
      if (!planAttemptIsCurrent()) {
        getBridgeContext().permissions.resolvePendingStructuredInput?.(request.requestId, { answers: {} });
        return;
      }
      hasVisibleProgressCard = true;
      cancelPendingLightweightActivity();
      if (previewState) {
        clearPrimeTimer(previewState);
      }
      const hasPreviewOutput = !!(
        previewState &&
        (
          previewState.placeholderPrimed
          || previewState.lastSentText.trim()
          || previewState.pendingText.trim()
          || previewState.lastSentAt > 0
        )
      );
      if (!hasVisibleAssistantOutput && !hasPreviewOutput) {
        const preface = await deliverResponse(
          adapter,
          msg.address,
          buildStructuredInputPreface(request),
          binding.codepilotSessionId,
          msg.messageId,
        );
        if (preface.ok) {
          hasVisibleAssistantOutput = true;
        }
      }
      if (adapter.sendStructuredInputRequest) {
        try {
          const sent = await adapter.sendStructuredInputRequest(msg.address, request, msg.messageId);
          if (sent.ok && sent.messageId) {
            try {
              store.upsertStructuredInputRequest({
                requestId: request.requestId,
                channelType: adapter.channelType,
                channelInstanceId: msg.address.channelInstanceId || adapter.profileId,
                chatId: msg.address.chatId,
                codepilotSessionId: binding.codepilotSessionId,
                address: msg.address,
                routeKey: msg.address.threadId
                  ? `${msg.address.chatId}:thread:${msg.address.threadId}`
                  : `${msg.address.chatId}:main`,
                threadId: request.threadId,
                turnId: request.turnId,
                itemId: request.itemId,
                questions: request.questions,
                messageId: sent.messageId,
                openMessageId: sent.openMessageId,
                resolved: false,
              });
            } catch {
              // best effort
            }
            return;
          }
        } catch (error) {
          console.error('[bridge-manager] Failed to deliver structured input card:', error);
        }
      }

      await deliver(adapter, {
        address: msg.address,
        text: '当前运行时请求补充信息，但该渠道尚未实现结构化问答卡。请转到本地命令行继续。',
        parseMode: 'plain',
        replyToMessageId: msg.messageId,
      }, { sessionId: binding.codepilotSessionId });
    }, async (requestId: string) => {
      try {
        store.markStructuredInputRequestResolved(requestId);
      } catch {
        // ignore
      }
      await adapter.resolveStructuredInputRequest?.(requestId);
    }, onResponseSegment, handleActivityEvent);
    const stopRequestedByUser =
      taskAbort.signal.aborted && hasPendingStopFeedback(binding.codepilotSessionId);

    // Send response text — render via channel-appropriate format
    let responseDelivery: SendResult | null = null;
    await settlePreview(previewState);
    if (!planAttemptIsCurrent()) {
      return;
    }
    await maybeSendToolResultImages(result.contentBlocks);
    const remainingSegments = result.responseSegments
      .filter((segment) => segment.trim())
      .slice(streamedSegmentCount);
    const hasVisibleResponseBody = remainingSegments.length > 0 || !!streamedSegmentDelivery || !!result.responseText;
    if (hasVisibleResponseBody) {
      await finalizeVisibleLightweightActivity();
    }
    if (previewState && previewFinalDelivery === 'replace_preview') {
      const finalResponseText = result.responseText || remainingSegments.join('\n\n').trim();
      if (finalResponseText) {
        responseDelivery = await deliverResponse(
          adapter,
          msg.address,
          finalResponseText,
          binding.codepilotSessionId,
          msg.messageId,
        );
        if (responseDelivery.ok) {
          adapter.endPreview?.(msg.address, previewState.draftId);
          previewClosed = true;
          hasVisibleAssistantOutput = true;
        }
      } else if (result.hasError && !stopRequestedByUser) {
        const errorResponse: OutboundMessage = {
          address: msg.address,
          text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        };
        await deliver(adapter, errorResponse);
      }
    } else if (previewState && previewFinalizesPerSegment) {
      if (remainingSegments.length > 0) {
        for (const segment of remainingSegments) {
          const nextDelivery = await deliverResponse(
            adapter,
            msg.address,
            segment,
            binding.codepilotSessionId,
            msg.messageId,
          );
          responseDelivery = nextDelivery;
          adapter.endPreview?.(msg.address, previewState.draftId);
          resetPreviewState(previewState);
          if (!nextDelivery.ok) break;
        }
      } else if (streamedSegmentDelivery) {
        responseDelivery = streamedSegmentDelivery;
      } else if (result.responseText) {
        responseDelivery = await deliverResponse(
          adapter,
          msg.address,
          result.responseText,
          binding.codepilotSessionId,
          msg.messageId,
        );
        if (responseDelivery.ok) {
          adapter.endPreview?.(msg.address, previewState.draftId);
          previewClosed = true;
        }
      } else if (result.hasError && !stopRequestedByUser) {
        const errorResponse: OutboundMessage = {
          address: msg.address,
          text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
          parseMode: 'HTML',
          replyToMessageId: msg.messageId,
        };
        await deliver(adapter, errorResponse);
      }
    } else if (remainingSegments.length > 1) {
      const [firstSegment, ...restSegments] = remainingSegments;
      if (firstSegment) {
        responseDelivery = await deliverResponse(adapter, msg.address, firstSegment, binding.codepilotSessionId, msg.messageId);
        if (previewState && responseDelivery.ok) {
          adapter.endPreview?.(msg.address, previewState.draftId);
          previewClosed = true;
        }
        if (responseDelivery.ok) {
          hasVisibleAssistantOutput = true;
        }
      }
      if (!responseDelivery || responseDelivery.ok) {
        for (const segment of restSegments) {
          const nextDelivery = await deliverResponse(adapter, msg.address, segment, binding.codepilotSessionId, msg.messageId);
          responseDelivery = nextDelivery;
          if (nextDelivery.ok) {
            hasVisibleAssistantOutput = true;
          }
          if (!nextDelivery.ok) break;
        }
      }
    } else if (remainingSegments.length === 1) {
      responseDelivery = await deliverResponse(
        adapter,
        msg.address,
        remainingSegments[0],
        binding.codepilotSessionId,
        msg.messageId,
      );
      if (responseDelivery.ok) {
        hasVisibleAssistantOutput = true;
      }
    } else if (streamedSegmentDelivery) {
      responseDelivery = streamedSegmentDelivery;
    } else if (result.responseText) {
      responseDelivery = await deliverResponse(adapter, msg.address, result.responseText, binding.codepilotSessionId, msg.messageId);
      if (responseDelivery.ok) {
        hasVisibleAssistantOutput = true;
      }
    } else if (result.hasError && !stopRequestedByUser) {
      const errorResponse: OutboundMessage = {
        address: msg.address,
        text: `<b>Error:</b> ${escapeHtml(result.errorMessage)}`,
        parseMode: 'HTML',
        replyToMessageId: msg.messageId,
      };
      await deliver(adapter, errorResponse);
    }

    const sendPlanConfirmationCard = async (
      workflowId: string,
      title: string,
      text: string,
      buttons: NonNullable<OutboundMessage['inlineButtons']> = [[
        { text: '执行', callbackData: `plan:execute:${workflowId}` },
        { text: '继续', callbackData: `plan:continue:${workflowId}` },
        { text: '取消', callbackData: `plan:cancel:${workflowId}` },
      ]],
    ): Promise<boolean> => {
      if (!planAttemptIsCurrent()) return false;
      const workflow = store.getPlanWorkflow(workflowId);
      if (!workflow) return false;
      cancelPendingLightweightActivity();
      await dismissPreviewForConfirmationCard(adapter, msg.address, previewState);
      let actionCard: SendResult;
      try {
        actionCard = await deliver(adapter, {
          address: msg.address,
          text,
          parseMode: 'Markdown',
          inlineButtons: buttons,
          replyToMessageId: responseDelivery?.messageId || msg.messageId,
          cardHeader: {
            title,
            template: 'blue',
          },
        }, { sessionId: binding.codepilotSessionId });
      } catch (error) {
        console.warn('[bridge-manager] Failed to send plan confirmation card:', error);
        return false;
      }
      if (!actionCard.ok) return false;
      store.updatePlanWorkflow(workflow.workflowId, {
        status: 'awaiting_confirmation',
        planMessageId: responseDelivery?.messageId || '',
        actionCardMessageId: actionCard.messageId || '',
        actionCardOpenMessageId: actionCard.openMessageId || '',
        resolved: false,
      });
      return true;
    };

    if (effectivePlanWorkflowMeta?.kind === 'plan_request') {
      const workflow = store.getPlanWorkflow(effectivePlanWorkflowMeta.workflowId);
      if (workflow) {
        const handledByClaudeExitPlan = result.permissionRequests.some(isClaudePlanExitPermission);
        if (handledByClaudeExitPlan) {
          // Claude SDK already surfaced its native plan-exit approval. Do not
          // stack the legacy bridge-owned execute/continue/cancel card on top.
          if (
            effectivePlanWorkflowMeta?.attemptId
            && workflow.activeAttemptId === effectivePlanWorkflowMeta.attemptId
            && workflow.status !== 'awaiting_confirmation'
          ) {
            store.deletePlanWorkflow(workflow.workflowId);
          }
        } else if (!isCodexRuntime(binding.codepilotSessionId) && result.responseText) {
          const sent = await sendClaudePlanConfirmationCard(
            workflow.workflowId,
            result.responseText,
            workflow.allowedPrompts || [],
            true,
            workflow.approvalRequestId || '',
            workflow.planFilePath || '',
          );
          if (!sent) {
            store.updatePlanWorkflow(workflow.workflowId, {
              status: 'awaiting_input',
              resolved: true,
            });
            await deliver(adapter, {
              address: msg.address,
              text: '计划已生成，但 Claude 确认卡发送失败。请直接在本线程继续发送需求，或重新执行 `/plan`。',
              parseMode: 'Markdown',
              replyToMessageId: responseDelivery?.messageId || msg.messageId,
            }, { sessionId: binding.codepilotSessionId });
          }
        } else if (result.responseText) {
          const sent = await sendPlanConfirmationCard(
            workflow.workflowId,
            '计划已生成',
            '计划已经准备好。选择下一步操作。',
          );
          if (!sent) {
            store.updatePlanWorkflow(workflow.workflowId, {
              status: 'awaiting_input',
              resolved: true,
            });
            await deliver(adapter, {
              address: msg.address,
              text: '计划已生成，但操作卡片发送失败。请直接继续发送需求，或重新执行 `/plan`。',
              parseMode: 'Markdown',
              replyToMessageId: responseDelivery?.messageId || msg.messageId,
            }, { sessionId: binding.codepilotSessionId });
          }
        } else {
          store.updatePlanWorkflow(workflow.workflowId, {
            status: 'awaiting_input',
            resolved: true,
          });
        }
      }
    }

    if (effectivePlanWorkflowMeta?.kind === 'native_plan_request') {
      const workflow = store.getPlanWorkflow(effectivePlanWorkflowMeta.workflowId);
      if (workflow) {
        if (result.responseText) {
          const nativeApprovalReceived = result.permissionRequests.some(isApprovalRequest);
          if (nativeApprovalReceived) {
            store.updatePlanWorkflow(workflow.workflowId, {
              status: 'awaiting_confirmation',
              planMessageId: responseDelivery?.messageId || '',
              actionCardMessageId: '',
              actionCardOpenMessageId: '',
              resolved: true,
            });
          } else {
            const sent = await sendPlanConfirmationCard(
              workflow.workflowId,
              '原生计划已生成',
              'Codex 已输出方案。若需要调整，请直接在群聊回复告诉 Codex 如何调整；若确认无误，点击“是，实施此计划”开始实施。',
              [[
                { text: '是，实施此计划', callbackData: `plan:execute:${workflow.workflowId}` },
              ]],
            );
            if (!sent) {
              store.updatePlanWorkflow(workflow.workflowId, {
                status: 'awaiting_input',
                resolved: true,
              });
              await deliver(adapter, {
                address: msg.address,
                text: '原生计划已生成，但确认卡发送失败。若要继续调整，请直接在本线程回复；若要开始实施，请切换 `/mode code` 后继续，或重新执行 `/plan`。',
                parseMode: 'Markdown',
                replyToMessageId: responseDelivery?.messageId || msg.messageId,
              }, { sessionId: binding.codepilotSessionId });
            }
          }
        } else {
          store.updatePlanWorkflow(workflow.workflowId, {
            status: 'awaiting_input',
            resolved: true,
          });
        }
      }
    }

    // Persist the actual SDK session ID for future resume.
    // If the result has an error and no session ID was captured, clear the
    // stale ID so the next message starts fresh instead of retrying a broken resume.
    if (binding.id && !isCodexRuntime(binding.codepilotSessionId)) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    // Clean up preview state
    if (previewState) {
      if (previewState.throttleTimer) {
        clearTimeout(previewState.throttleTimer);
        previewState.throttleTimer = null;
      }
      clearPrimeTimer(previewState);
      await settlePreview(previewState);
      const hasActivePreviewDraft = !!(
        previewState.placeholderPrimed
        || previewState.lastSentText
        || previewState.pendingText
        || previewState.lastSentAt > 0
      );
      if (!previewClosed && hasActivePreviewDraft) {
        adapter.endPreview?.(msg.address, previewState.draftId);
      }
    }
    cancelPendingLightweightActivity();
    await settleLightweightActivity(lightweightActivityState);

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address);
    if (taskAbort.signal.aborted) {
      await sendPendingStopCompletion(adapter, binding.codepilotSessionId);
    } else {
      clearPendingStopFeedback(binding.codepilotSessionId);
    }
    // Commit the offset only after full processing (success or failure)
    ack();
  }
}

/**
 * Handle IM slash commands.
 */
async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const { store } = getBridgeContext();

  // Extract command and args (handle /command@botname format)
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Run dangerous-input detection on the full command text
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    store.insertAuditLog({
      channelType: adapter.channelType,
      channelInstanceId: msg.address.channelInstanceId || adapter.profileId,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[BLOCKED] Dangerous input detected: ${dangerCheck.reason}`,
    });
    console.warn(`[bridge-manager] Blocked dangerous command input from chat ${msg.address.chatId}: ${dangerCheck.reason}`);
    await deliver(adapter, {
      address: msg.address,
      text: `Command rejected: invalid input detected.`,
      parseMode: 'plain',
      replyToMessageId: msg.messageId,
    });
    return;
  }

  let response = '';
  let historySessionId = '';
  let shouldAppendLocalHistory = false;

  switch (command) {
    case '/start':
      response = [
        '<b>agents-to-im</b>',
        '',
        'Send any message to interact with the current agent session.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = router.createBinding(msg.address, workDir);
      response = `New session created.\nSession: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>\nCWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`;
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind &lt;session_id&gt;';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format. Expected a 32-64 character hex/UUID string.';
        break;
      }
      const binding = router.bindToSession(msg.address, args);
      if (binding) {
        response = `Bound to session <code>${args.slice(0, 8)}...</code>`;
      } else {
        response = 'Session not found.';
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path. Must be an absolute path without traversal sequences or special characters.';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to <code>${escapeHtml(validatedPath)}</code>`;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = router.resolve(msg.address);
      router.updateBinding(binding.id, { mode: args });
      response = `Mode set to <b>${args}</b>`;
      historySessionId = binding.codepilotSessionId;
      shouldAppendLocalHistory = true;
      break;
    }

    case '/status': {
      const binding = router.resolve(msg.address);
      response = [
        '<b>Bridge Status</b>',
        '',
        `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
        `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
        `Mode: <b>${binding.mode}</b>`,
        `Model: <code>${binding.model || 'default'}</code>`,
      ].join('\n');
      break;
    }

    case '/sessions': {
      const bindings = router
        .listBindings(adapter.channelType)
        .filter((binding) => binding.channelInstanceId === adapter.profileId);
      if (bindings.length === 0) {
        response = 'No sessions found.';
      } else {
        const lines = ['<b>Sessions:</b>', ''];
        for (const b of bindings.slice(0, 10)) {
          const active = b.active ? 'active' : 'inactive';
          lines.push(`<code>${b.codepilotSessionId.slice(0, 8)}...</code> [${active}] ${escapeHtml(b.workingDirectory || '~')}`);
        }
        response = lines.join('\n');
      }
      break;
    }

    case '/stop': {
      const binding = router.resolve(msg.address);
      const alreadyStopping = hasPendingStopFeedback(binding.codepilotSessionId);
      const stoppedTask = interruptActiveTask(binding.codepilotSessionId);
      if (stoppedTask) {
        ensurePendingStopFeedback(binding.codepilotSessionId, msg.address, msg.messageId);
      }
      const releasedWorkflow = releasePlanWorkflowAfterStop(binding, msg.address);
      if (stoppedTask || alreadyStopping) {
        response = 'Stopping current task...';
      } else if (releasedWorkflow) {
        response = 'Current task stopped.';
      } else {
        response = 'No task is currently running.';
      }
      historySessionId = binding.codepilotSessionId;
      shouldAppendLocalHistory = true;
      break;
    }

    case '/help':
      response = [
        '<b>agents-to-im Commands</b>',
        '',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '1/2/3 - Quick permission reply (Feishu, single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    default:
      response = `Unknown command: ${escapeHtml(command)}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(adapter, {
      address: msg.address,
      text: response,
      parseMode: 'HTML',
      replyToMessageId: msg.messageId,
    });
    if (shouldAppendLocalHistory && historySessionId) {
      appendLocalCommandExchange(store, historySessionId, text, response);
    }
  }
}

// ── SDK Session Update Logic ─────────────────────────────────

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 *
 * Rules:
 * - If result has sdkSessionId AND no error → save the new ID
 * - If result has error (regardless of sdkSessionId) → clear to empty string
 * - Otherwise → no update needed
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) {
    return sdkSessionId;
  }
  if (hasError) {
    return '';
  }
  return null;
}

// ── Test-only export ─────────────────────────────────────────
// Exposed so integration tests can exercise handleMessage directly
// without wiring up the full adapter loop.
/** @internal */
export const _testOnly = { handleMessage };
