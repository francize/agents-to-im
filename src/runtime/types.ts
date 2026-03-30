import type { BridgeSession } from '../bridge/host.js';

export type RuntimeName = 'claude' | 'codex';

export type TitleStatus = 'pending' | 'running' | 'done' | 'failed';
export type DisplayNameMode = 'default' | 'native_locked';

export interface SessionExt {
  runtime: RuntimeName;
  title?: string;
  titleStatus?: TitleStatus;
  codexThreadId?: string;
  displayNameMode?: DisplayNameMode;
}

export interface SessionRecord extends BridgeSession {
  sdk_session_id?: string;
  ext?: SessionExt;
}
