import type { BridgeStore } from './host.js';

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'');
}

export function normalizeLocalCommandReply(reply: string): string {
  const withBreaks = reply.replace(/<br\s*\/?>/gi, '\n');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, '');
  const normalizedLines = decodeHtmlEntities(withoutTags)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  return normalizedLines || '本地命令已处理。';
}

export function appendLocalCommandExchange(
  store: BridgeStore,
  sessionId: string,
  commandText: string,
  reply: string,
): void {
  const normalizedCommand = commandText.trim();
  if (!sessionId || !normalizedCommand) return;
  store.addMessage(sessionId, 'user', normalizedCommand);
  store.addMessage(sessionId, 'assistant', normalizeLocalCommandReply(reply));
}
