/**
 * Bridge Manager — singleton orchestrator for the multi-IM bridge system.
 *
 * Manages adapter lifecycles, routes inbound messages through the
 * conversation engine, and coordinates permission handling.
 *
 * Uses globalThis to survive Next.js HMR in development.
 */

import type { StructuredInputRequestInfo } from './host.js';
import type { BridgeStatus, InboundMessage, OutboundMessage, StreamingPreviewState } from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { markdownToDiscordChunks } from './markdown/discord.js';
import { getBridgeContext } from './context.js';
import { escapeHtml } from './adapters/telegram-utils.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';

const GLOBAL_KEY = '__bridge_manager__';

// ── Streaming preview helpers ──────────────────────────────────

/** Generate a non-zero random 31-bit integer for use as draft_id. */
function generateDraftId(): number {
  return (Math.floor(Math.random() * 0x7FFFFFFE) + 1); // 1 .. 2^31-1
}

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

/** Default stream config per channel type. */
const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 700, minDeltaChars: 20, maxChars: 3900 },
  discord: { intervalMs: 1500, minDeltaChars: 40, maxChars: 1900 },
};

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

function getPlanWorkflowMeta(msg: InboundMessage): NonNullable<InboundMessage['bridgeMeta']>['planWorkflow'] | null {
  return msg.bridgeMeta?.planWorkflow || null;
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

/**
 * Check if a message looks like a numeric permission shortcut (1/2/3) for
 * feishu/qq channels WITH at least one pending permission in that chat.
 *
 * This is used by the adapter loop to route these messages to the inline
 * (non-session-locked) path, avoiding deadlock: the session is blocked
 * waiting for the permission to be resolved, so putting "1" behind the
 * session lock would deadlock.
 */
function isNumericPermissionShortcut(channelType: string, rawText: string, chatId: string): boolean {
  if (channelType !== 'feishu' && channelType !== 'qq') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  const pending = store.listPendingPermissionLinksByChat(chatId);
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
  state.draftId = generateDraftId();
  state.lastSentText = '';
  state.lastSentAt = 0;
  state.pendingText = '';
  state.inFlightSend = null;
}

// ── Channel-aware rendering dispatch ──────────────────────────

import type { ChannelAddress, SendResult } from './types.js';

/**
 * Render response text and deliver via the appropriate channel format.
 * Telegram: Markdown → HTML chunks via deliverRendered.
 * Other channels: plain text via deliver (no HTML).
 */
async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  responseText: string,
  sessionId: string,
  replyToMessageId?: string,
): Promise<SendResult> {
  if (adapter.channelType === 'telegram') {
    const chunks = markdownToTelegramChunks(responseText, 4096);
    if (chunks.length > 0) {
      return deliverRendered(adapter, address, chunks, { sessionId, replyToMessageId });
    }
    return { ok: true };
  }
  if (adapter.channelType === 'discord') {
    // Discord: native markdown, chunk at 2000 chars with fence repair
    const chunks = markdownToDiscordChunks(responseText, 2000);
    for (let i = 0; i < chunks.length; i++) {
      const result = await deliver(adapter, {
        address,
        text: chunks[i].text,
        parseMode: 'Markdown',
        replyToMessageId,
      }, { sessionId });
      if (!result.ok) return result;
    }
    return { ok: true };
  }
  if (adapter.channelType === 'feishu') {
    // Feishu: pass markdown through for adapter to format as post/card
    return deliver(adapter, {
      address,
      text: responseText,
      parseMode: 'Markdown',
      replyToMessageId,
    }, { sessionId });
  }
  // Generic fallback: deliver as plain text (deliver() handles chunking internally)
  return deliver(adapter, {
    address,
    text: responseText,
    parseMode: 'plain',
    replyToMessageId,
  }, { sessionId });
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, AdapterMeta>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
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
      sessionLocks: new Map(),
      autoStartChecked: false,
    };
  }
  // Backfill sessionLocks for states created before this field existed
  if (!g[GLOBAL_KEY].sessionLocks) {
    g[GLOBAL_KEY].sessionLocks = new Map();
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

  // Iterate all registered adapter types and create those that are enabled
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

  // Start all registered adapters, track how many succeeded
  let startedCount = 0;
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.start();
      console.log(`[bridge-manager] Started adapter: ${type}`);
      startedCount++;
    } catch (err) {
      console.error(`[bridge-manager] Failed to start adapter ${type}:`, err);
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

  // Stop all adapters
  for (const [type, adapter] of state.adapters) {
    try {
      await adapter.stop();
      console.log(`[bridge-manager] Stopped adapter: ${type}`);
    } catch (err) {
      console.error(`[bridge-manager] Error stopping adapter ${type}:`, err);
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
    adapters: Array.from(state.adapters.entries()).map(([type, adapter]) => {
      const meta = state.adapterMeta.get(type);
      return {
        channelType: adapter.channelType,
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
  state.adapters.set(adapter.channelType, adapter);
}

/**
 * Run the event loop for a single adapter.
 * Messages for different sessions are dispatched concurrently;
 * messages for the same session are serialized via session locks.
 */
function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue; // Adapter stopped

        // Callback queries, commands, and numeric permission shortcuts are
        // lightweight — process inline (outside session lock).
        // Regular messages use per-session locking for concurrency.
        //
        // IMPORTANT: numeric shortcuts (1/2/3) for feishu/qq MUST run outside
        // the session lock. The current session is blocked waiting for the
        // permission to be resolved; if "1" enters the session lock queue it
        // deadlocks (permission waits for "1", "1" waits for lock release).
        if (
          msg.callbackData ||
          msg.text.trim().startsWith('/') ||
          isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), msg.address.chatId)
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
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        // Track last error per adapter
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        // Brief delay to prevent tight error loops
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })().catch(err => {
    if (!abort.signal.aborted) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
      const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
      meta.lastError = errMsg;
      state.adapterMeta.set(adapter.channelType, meta);
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
  const meta = adapterState.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  adapterState.adapterMeta.set(adapter.channelType, meta);

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
    const handled = broker.handlePermissionCallback(msg.callbackData, msg.address.chatId, msg.callbackMessageId);
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

  // ── Numeric shortcut for permission replies (feishu/qq only) ──
  // On mobile, typing `/perm allow <uuid>` is painful.
  // If the user sends "1", "2", or "3" and there is exactly one pending
  // permission for this chat, map it: 1→allow, 2→allow_session, 3→deny.
  //
  // Input normalization: mobile keyboards / IM clients may send fullwidth
  // digits (１２３), digits with zero-width joiners, or other Unicode
  // variants. NFKC normalization folds them all to ASCII 1/2/3.
  if (adapter.channelType === 'feishu' || adapter.channelType === 'qq') {
    // eslint-disable-next-line no-control-regex
    const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (/^[123]$/.test(normalized)) {
      const pendingLinks = store.listPendingPermissionLinksByChat(msg.address.chatId);
      if (pendingLinks.length === 1) {
        const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
        const action = actionMap[normalized];
        const permId = pendingLinks[0].permissionRequestId;
        const callbackData = `perm:${action}:${permId}`;
        const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
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
          text: `Multiple pending permissions (${pendingLinks.length}). Please use the full command:\n/perm allow|allow_session|deny <id>`,
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
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: `[TRUNCATED] Input truncated from ${rawText.length} chars`,
    });
  }

  if (!text && !hasAttachments) { ack(); return; }

  // Regular message — route to conversation engine
  const binding = router.resolve(msg.address);

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
      lastSentText: '',
      lastSentAt: 0,
      degraded: false,
      throttleTimer: null,
      pendingText: '',
      inFlightSend: null,
    };
  }

  const streamCfg = previewState ? getStreamConfig(adapter.channelType) : null;
  const previewFinalDelivery = caps?.finalDelivery || 'separate_message';
  const previewFinalizesPerSegment = previewFinalDelivery === 'segment_replace_preview';

  // Build the onPartialText callback (or undefined if preview not supported)
  const onPartialText = (previewState && streamCfg) ? (fullText: string) => {
    const ps = previewState!;
    const cfg = streamCfg!;
    if (ps.degraded) return;

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
    const normalized = segmentText.trim();
    if (!normalized) return;
    const ps = previewState!;
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
    }
    adapter.endPreview?.(msg.address, ps.draftId);
    resetPreviewState(ps);
  } : undefined;

  try {
    // Pass permission callback so requests are forwarded to IM immediately
    // during streaming (the stream blocks until permission is resolved).
    // Use text or empty string for image-only messages (prompt is still required by streamClaude)
    const promptText = planWorkflowMeta?.promptText || text || (hasAttachments ? 'Describe this image.' : '');
    const storedUserText = planWorkflowMeta?.storedUserText || text || (hasAttachments ? 'Describe this image.' : '');

    const result = await engine.processMessage(binding, promptText, async (perm) => {
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
      permissionModeOverride: planWorkflowMeta?.permissionMode,
      collaborationModeOverride: resolveCodexCollaborationMode(binding, planWorkflowMeta),
    }, async (request: StructuredInputRequestInfo) => {
      const hasPreviewOutput = !!(
        previewState &&
        (previewState.lastSentText.trim() || previewState.pendingText.trim() || previewState.lastSentAt > 0)
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
        text: '当前运行时请求补充信息，但该渠道尚未实现结构化问答卡。请转到本地 Codex 继续。',
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
    }, onResponseSegment);

    // Send response text — render via channel-appropriate format
    let responseDelivery: SendResult | null = null;
    await settlePreview(previewState);
    const remainingSegments = result.responseSegments
      .filter((segment) => segment.trim())
      .slice(streamedSegmentCount);
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
      } else if (result.hasError) {
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
      } else if (result.hasError) {
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
    } else if (result.hasError) {
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
    ): Promise<boolean> => {
      const workflow = store.getPlanWorkflow(workflowId);
      if (!workflow) return false;
      const actionCard = await deliver(adapter, {
        address: msg.address,
        text,
        parseMode: 'Markdown',
        inlineButtons: [[
          { text: '执行', callbackData: `plan:execute:${workflow.workflowId}` },
          { text: '继续', callbackData: `plan:continue:${workflow.workflowId}` },
          { text: '取消', callbackData: `plan:cancel:${workflow.workflowId}` },
        ]],
        replyToMessageId: responseDelivery?.messageId || msg.messageId,
        cardHeader: {
          title,
          template: 'blue',
        },
      }, { sessionId: binding.codepilotSessionId });
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

    if (planWorkflowMeta?.kind === 'plan_request') {
      const workflow = store.getPlanWorkflow(planWorkflowMeta.workflowId);
      if (workflow) {
        if (result.responseText) {
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

    if (planWorkflowMeta?.kind === 'native_plan_request') {
      const workflow = store.getPlanWorkflow(planWorkflowMeta.workflowId);
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
              'Codex 已输出方案。确认后开始实施，或继续保持 PLAN 流程。',
            );
            if (!sent) {
              store.updatePlanWorkflow(workflow.workflowId, {
                status: 'awaiting_input',
                resolved: true,
              });
              await deliver(adapter, {
                address: msg.address,
                text: '原生计划已生成，但确认卡发送失败。请重新执行 `/plan`，或直接切换 `/mode code` 继续。',
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
      await settlePreview(previewState);
      const hasActivePreviewDraft = !!(previewState.lastSentText || previewState.pendingText || previewState.lastSentAt > 0);
      if (!previewClosed && hasActivePreviewDraft) {
        adapter.endPreview?.(msg.address, previewState.draftId);
      }
    }

    state.activeTasks.delete(binding.codepilotSessionId);
    // Notify adapter that message processing ended
    adapter.onMessageEnd?.(msg.address);
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

  switch (command) {
    case '/start':
      response = [
        '<b>CodePilot Bridge</b>',
        '',
        'Send any message to interact with Claude.',
        '',
        '<b>Commands:</b>',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission',
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
      const bindings = router.listBindings(adapter.channelType);
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
      const st = getState();
      const taskAbort = st.activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        st.activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      // Text-based permission approval fallback (for channels without inline buttons)
      // Usage: /perm allow <id> | /perm allow_session <id> | /perm deny <id>
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny &lt;permission_id&gt;';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = broker.handlePermissionCallback(callbackData, msg.address.chatId);
      if (handled) {
        response = `Permission ${permAction}: recorded.`;
      } else {
        response = `Permission not found or already resolved.`;
      }
      break;
    }

    case '/help':
      response = [
        '<b>CodePilot Bridge Commands</b>',
        '',
        '/new [path] - Start new session',
        '/bind &lt;session_id&gt; - Bind to existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current status',
        '/sessions - List recent sessions',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny &lt;id&gt; - Respond to permission request',
        '1/2/3 - Quick permission reply (Feishu/QQ, single pending)',
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
