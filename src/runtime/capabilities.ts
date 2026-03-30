import type { RuntimeName } from './types.js';

export interface ProviderCapabilities {
  nativePlanProtocol: boolean;
  askUserQuestion: boolean;
  structuredInput: boolean;
  approvalKinds: 'rich' | 'permission_callback';
  activityGranularity: 'rich' | 'basic';
  resumeKinds: Array<'sdkSessionId' | 'runtimeThreadId'>;
  elicitation: boolean;
}

export const RUNTIME_CAPABILITIES: Record<RuntimeName, ProviderCapabilities> = {
  claude: {
    nativePlanProtocol: false,
    askUserQuestion: true,
    structuredInput: true,
    approvalKinds: 'permission_callback',
    activityGranularity: 'basic',
    resumeKinds: ['sdkSessionId'],
    elicitation: true,
  },
  codex: {
    nativePlanProtocol: true,
    askUserQuestion: false,
    structuredInput: true,
    approvalKinds: 'rich',
    activityGranularity: 'rich',
    resumeKinds: ['sdkSessionId', 'runtimeThreadId'],
    elicitation: false,
  },
};
