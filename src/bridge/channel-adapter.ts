/**
 * Abstract base class for IM channel adapters.
 *
 * The current bridge ships with a Feishu/Lark adapter; this abstraction keeps
 * bridge lifecycle code decoupled from adapter-specific delivery details.
 */

import type {
  ActivityEvent,
  ChannelAddress,
  ChannelType,
  InboundMessage,
  OutboundImage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from './types.js';
import type { StructuredInputRequestInfo } from './host.js';

export abstract class BaseChannelAdapter {
  /** Which channel type this adapter handles */
  abstract readonly channelType: ChannelType;

  /** Stable adapter instance identifier. */
  get adapterId(): string {
    return this.channelType;
  }

  /** Stable profile identifier, if the adapter is backed by a named profile. */
  get profileId(): string {
    return this.adapterId;
  }

  /** Human-readable adapter label for status surfaces and redirect hints. */
  get label(): string {
    return this.profileId;
  }

  /**
   * Start the adapter (connect, begin polling/websocket, etc.).
   * Must be idempotent — calling start() on an already-running adapter is a no-op.
   */
  abstract start(): Promise<void>;

  /**
   * Stop the adapter gracefully.
   * Must be idempotent — calling stop() on an already-stopped adapter is a no-op.
   */
  abstract stop(): Promise<void>;

  /** Whether the adapter is currently running and consuming messages */
  abstract isRunning(): boolean;

  /**
   * Consume the next inbound message from the internal queue.
   * Blocks until a message is available or the adapter is stopped.
   * Returns null if the adapter was stopped while waiting.
   */
  abstract consumeOne(): Promise<InboundMessage | null>;

  /**
   * Send an outbound message to the channel.
   * Handles adapter-specific formatting and API calls.
   */
  abstract send(message: OutboundMessage): Promise<SendResult>;

  /**
   * Send a local image file to the channel as a native image message.
   */
  sendImage?(_image: OutboundImage): Promise<SendResult>;

  /**
   * Answer a callback query.
   * Default implementation is a no-op for adapters that do not need it.
   */
  async answerCallback(_callbackQueryId: string, _text?: string): Promise<void> {
    // No-op by default; override in adapters that support callback queries
  }

  /**
   * Validate that the adapter's configuration is complete.
   * Returns null if valid, or an error message string if invalid.
   */
  abstract validateConfig(): string | null;

  /**
   * Check whether a user is authorized to use this bridge.
   * Returns true if authorized, false otherwise.
   */
  abstract isAuthorized(userId: string, chatId: string): boolean;

  /** Called when message processing starts (e.g., typing indicator). */
  onMessageStart?(_address: ChannelAddress): void;

  /** Called when message processing ends. */
  onMessageEnd?(_address: ChannelAddress): void;

  /**
   * Acknowledge that an update has been fully processed.
   * Adapters that defer offset commits until after handleMessage should implement this.
   * Default is a no-op; override in adapters that need deferred offset tracking.
   */
  acknowledgeUpdate?(_updateId: number): void;

  /**
   * Return preview capabilities for a given chat.
   * Returning null means streaming preview is not available for this chat.
   * `finalDelivery=replace_preview` means the adapter can turn the preview
   * artifact itself into the final reply in place once per turn.
   * `finalDelivery=segment_replace_preview` means each completed response
   * segment should finalize the current preview artifact in place, then start
   * a fresh preview cycle for the next segment.
   */
  getPreviewCapabilities?(_address: ChannelAddress): PreviewCapabilities | null;

  /**
   * Send (or update) a streaming preview draft.
   * Returns 'sent' on success, 'skip' for transient failures (caller should
   * retry later), or 'degrade' for permanent failures (caller should stop).
   */
  sendPreview?(_address: ChannelAddress, _text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'>;

  /**
   * Create an empty preview artifact ahead of the next streamed segment.
   * Useful for channels that can show a "still responding" card before new
   * text arrives. The artifact will later be updated via sendPreview().
   */
  primePreview?(_address: ChannelAddress, _draftId: number): Promise<'sent' | 'skip' | 'degrade'>;

  /**
   * Signal the end of a preview cycle. The final message is sent via the
   * normal delivery path, so this is typically a no-op.
   */
  endPreview?(_address: ChannelAddress, _draftId: number): void;

  /**
   * Send a structured input card for runtimes that can pause and request
   * user answers mid-turn.
   */
  sendStructuredInputRequest?(
    _address: ChannelAddress,
    _request: StructuredInputRequestInfo,
    _replyToMessageId?: string,
  ): Promise<SendResult>;

  /**
   * Mark a previously sent structured-input card as resolved/disabled.
   */
  resolveStructuredInputRequest?(_requestId: string): Promise<void>;

  /**
   * Create or update a process-activity card tied to the current turn/item.
   * Adapters that support richer timeline projections can implement this to
   * surface lightweight activity, command execution, or file-change status.
   */
  upsertActivityEvent?(
    _address: ChannelAddress,
    _event: ActivityEvent,
    _replyToMessageId?: string,
  ): Promise<SendResult>;

  /**
   * Decide whether a given activity event should be projected into the channel.
   * Adapters can use this to suppress noisy activity surfaces before the bridge
   * marks progress cards as visible.
   */
  shouldProjectActivityEvent?(_event: ActivityEvent): boolean;

}

// ── Adapter Registry ────────────────────────────────────────────

const adapterFactories = new Map<string, () => BaseChannelAdapter>();

export function registerAdapterFactory(channelType: string, factory: () => BaseChannelAdapter): void {
  adapterFactories.set(channelType, factory);
}

export function createAdapter(channelType: string): BaseChannelAdapter | null {
  const factory = adapterFactories.get(channelType);
  return factory ? factory() : null;
}

export function getRegisteredTypes(): string[] {
  return Array.from(adapterFactories.keys());
}
