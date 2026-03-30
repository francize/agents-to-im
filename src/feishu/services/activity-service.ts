import type { ChannelAddress, SendResult } from '../../bridge/types.js';
import { buildActivityCard, getActivityEventId } from '../cards/index.js';
import { LarkClient } from '../lark-client.js';
import type {
  ActivityArtifact,
  PendingActivitySend,
} from '../types.js';
import {
  activityKey,
  isRecoverableMessageSendError,
  routeKeyForAddress,
  stableMessageUuid,
} from '../utils.js';
import type { ActivityEvent } from '../../bridge/types.js';

export class ActivityService {
  readonly activityArtifacts = new Map<string, ActivityArtifact>();
  readonly pendingActivitySends = new Map<string, PendingActivitySend>();

  constructor(
    private readonly larkClient: LarkClient,
    private readonly getReplyToMessageId: (routeKey: string) => string | undefined,
  ) {}

  reset(): void {
    this.activityArtifacts.clear();
    this.pendingActivitySends.clear();
  }

  async upsertActivityEvent(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId: string | undefined,
    enabled: boolean,
  ): Promise<SendResult> {
    if (!this.larkClient.getClient() || !enabled || event.kind === 'context_usage') {
      return { ok: true };
    }
    const routeKey = routeKeyForAddress(address);
    const activityId = getActivityEventId(event);
    const key = activityKey(routeKey, activityId);
    const artifact = this.activityArtifacts.get(key);
    const card = buildActivityCard(event);

    if (artifact?.messageId) {
      await this.larkClient.patchCard(artifact.messageId, card);
      return {
        ok: true,
        messageId: artifact.messageId,
        openMessageId: artifact.openMessageId,
      };
    }

    const targetReplyId = replyToMessageId || this.getReplyToMessageId(routeKey);
    const pending = this.pendingActivitySends.get(key);
    const requestUuid = pending?.requestUuid || stableMessageUuid('activity', key);
    try {
      const sent = await this.larkClient.sendCard(address, card, targetReplyId, requestUuid);
      this.activityArtifacts.set(key, {
        key,
        routeKey,
        activityId,
        messageId: sent.messageId,
        openMessageId: sent.openMessageId,
        kind: event.kind,
      });
      this.pendingActivitySends.delete(key);
      if (pending?.needsRecoveryPatch) {
        await this.larkClient.patchCard(sent.messageId, card);
      }
      return {
        ok: true,
        messageId: sent.messageId,
        openMessageId: sent.openMessageId,
      };
    } catch (error) {
      if (isRecoverableMessageSendError(error)) {
        this.pendingActivitySends.set(key, {
          requestUuid,
          needsRecoveryPatch: true,
        });
        console.warn('[feishu-adapter] Activity card send timed out; keeping idempotent UUID for recovery:', error);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    }
  }
}
