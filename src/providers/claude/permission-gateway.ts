export const PENDING_PERMISSIONS_TIMEOUT_MS = 15 * 60 * 1000;
export const PENDING_APPROVALS_TIMEOUT_MS = 10 * 60 * 1000;
export const PENDING_STRUCTURED_INPUTS_TIMEOUT_MS = 10 * 60 * 1000;

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
  scope?: 'turn' | 'session';
  updatedPermissions?: unknown[];
  interrupt?: boolean;
}

export interface PermissionResolution {
  behavior: 'allow' | 'deny';
  message?: string;
  scope?: 'turn' | 'session';
  updatedPermissions?: unknown[];
  interrupt?: boolean;
}

export interface StructuredInputResolution {
  answers: Record<string, { answers: string[] }>;
}

export class PendingPermissions {
  private pending = new Map<string, {
    resolve: (r: PermissionResult) => void;
    timer: NodeJS.Timeout;
  }>();
  private timeoutMs = PENDING_PERMISSIONS_TIMEOUT_MS;

  waitFor(toolUseID: string): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(toolUseID);
        resolve({ behavior: 'deny', message: 'Permission request timed out' });
      }, this.timeoutMs);
      this.pending.set(toolUseID, { resolve, timer });
    });
  }

  resolve(permissionRequestId: string, resolution: PermissionResolution): boolean {
    const entry = this.pending.get(permissionRequestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    if (resolution.behavior === 'allow') {
      entry.resolve({
        behavior: 'allow',
        scope: resolution.scope,
        updatedPermissions: resolution.updatedPermissions,
      });
    } else {
      entry.resolve({
        behavior: 'deny',
        message: resolution.message || 'Denied by user',
        scope: resolution.scope,
        interrupt: resolution.interrupt,
      });
    }
    this.pending.delete(permissionRequestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ behavior: 'deny', message: 'Bridge shutting down' });
    }
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

export class PendingApprovals {
  private pending = new Map<string, {
    resolve: (r: PermissionResolution) => void;
    timer: NodeJS.Timeout;
  }>();
  private timeoutMs = PENDING_APPROVALS_TIMEOUT_MS;

  waitFor(requestId: string): Promise<PermissionResolution> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          behavior: 'deny',
          message: 'Permission request timed out',
          scope: 'turn',
        });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
    });
  }

  resolve(requestId: string, resolution: PermissionResolution): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
      entry.resolve(resolution);
    this.pending.delete(requestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        behavior: 'deny',
        message: 'Bridge shutting down',
        scope: 'turn',
      });
    }
    this.pending.clear();
  }
}

export class PendingStructuredInputs {
  private pending = new Map<string, {
    resolve: (r: StructuredInputResolution) => void;
    timer: NodeJS.Timeout;
  }>();
  private timeoutMs = PENDING_STRUCTURED_INPUTS_TIMEOUT_MS;

  waitFor(requestId: string): Promise<StructuredInputResolution> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ answers: {} });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
    });
  }

  resolve(requestId: string, resolution: StructuredInputResolution): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.resolve(resolution);
    this.pending.delete(requestId);
    return true;
  }

  denyAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ answers: {} });
    }
    this.pending.clear();
  }
}
