/**
 * SSE Utilities — canonical turn-event encoding shared by all runtime drivers.
 *
 * Providers should emit CanonicalTurnEvent values rather than formatting the
 * wire string themselves so the bridge consumes one stable SSE contract.
 */

import type { SSEEventType } from '../bridge/host.js';

export interface CanonicalTurnEvent<TType extends SSEEventType = SSEEventType> {
  type: TType;
  data: unknown;
}

export function encodeCanonicalTurnEvent(event: CanonicalTurnEvent): string {
  const payload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  return `data: ${JSON.stringify({ type: event.type, data: payload })}\n`;
}

export function emitCanonicalTurnEvent(
  controller: ReadableStreamDefaultController<string>,
  event: CanonicalTurnEvent,
): void {
  controller.enqueue(encodeCanonicalTurnEvent(event));
}

export function sseEvent(type: string, data: unknown): string {
  return encodeCanonicalTurnEvent({ type: type as SSEEventType, data });
}
