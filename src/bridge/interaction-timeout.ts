export function formatInteractionTimeout(timeoutMs: number): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} 小时`;
  }
  return `${minutes} 分钟`;
}

function buildInteractionTimeoutSentence(timeoutMs: number, expiredOutcome: string): string {
  return `请在 ${formatInteractionTimeout(timeoutMs)} 内处理，超时后${expiredOutcome}`;
}

export function buildInteractionTimeoutText(timeoutMs: number, expiredOutcome: string): string {
  return `超时提示：${buildInteractionTimeoutSentence(timeoutMs, expiredOutcome)}。`;
}

export function buildInteractionTimeoutMarkdown(timeoutMs: number, expiredOutcome: string): string {
  return `:StatusFlashOfInspiration: <font color=orange>超时提示：${buildInteractionTimeoutSentence(timeoutMs, expiredOutcome)}。</font>`;
}
