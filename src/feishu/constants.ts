export const STREAM_ELEMENT_ID = 'stream_content';
export const TYPING_EMOJI = 'Typing';
export const STREAM_PLACEHOLDER_TEXT = '🤖 努力回答中...';
export const PLAN_SUFFIX = ' [PLAN]';
export const STRUCTURED_INPUT_PREFIX = 'structured-input';
export const NEW_SESSION_WORKDIR_FIELD = 'new_session_workdir';
export const PENDING_INBOUND_IMAGE_TTL_MS = 15 * 60 * 1000;

export const FEISHU_REQUIRED_APP_SCOPES = [
  'im:message:send_as_bot',
  'im:message:readonly',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:message:update',
  'im:message.reactions:read',
  'im:message.reactions:write_only',
  'im:chat:read',
  'im:chat:update',
  'im:resource',
  'cardkit:card:write',
  'cardkit:card:read',
] as const;

export function findMissingAppScopes(visibleScopes: readonly string[]): string[] {
  const granted = new Set(visibleScopes);
  return FEISHU_REQUIRED_APP_SCOPES.filter((scope) => !granted.has(scope));
}
