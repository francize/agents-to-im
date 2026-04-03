/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in the configured CTI_HOME data directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  PlanWorkflowInput,
  PlanWorkflowRecord,
  StructuredInputRequestInput,
  StructuredInputRequestRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from '../bridge/host.js';
import {
  DEFAULT_CHANNEL_INSTANCE_ID,
  resolveChannelInstanceId,
  type ChannelBinding,
  type ChannelType,
} from '../bridge/types.js';
import { normalizeClaudePermissionMode } from '../runtime/claude-mode.js';
import { CTI_HOME } from '../config/config.js';
import type {
  DisplayNameMode,
  RuntimeName,
  SessionExt,
  SessionRecord,
  TitleStatus,
} from '../runtime/types.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function bindingKey(channelType: string, chatId: string, channelInstanceId?: string): string {
  return `${channelType}:${resolveChannelInstanceId({ channelInstanceId })}:${chatId}`;
}

function normalizeTitleStatus(value: unknown): TitleStatus | undefined {
  return value === 'done' ? 'done' : value === 'pending' ? 'pending' : undefined;
}

function normalizeLegacyTitleStatus(value: unknown): TitleStatus {
  return normalizeTitleStatus(value) || 'pending';
}

function normalizeDisplayNameMode(value: unknown): DisplayNameMode | undefined {
  return value === 'default' || value === 'native_locked' || value === 'manual_locked'
    ? value
    : undefined;
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, SessionRecord>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private planWorkflows = new Map<string, PlanWorkflowRecord>();
  private structuredInputRequests = new Map<string, StructuredInputRequestRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, SessionRecord>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    let sessionsChanged = false;
    for (const [id, s] of Object.entries(sessions)) {
      const normalized = this.normalizeSessionRecord(s);
      if (normalized !== s) sessionsChanged = true;
      this.sessions.set(id, normalized);
    }
    if (sessionsChanged) this.persistSessions();

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    let bindingsChanged = false;
    for (const [key, b] of Object.entries(bindings)) {
      const normalized = this.normalizeChannelBindingRecord(b);
      const normalizedKey = bindingKey(
        normalized.channelType,
        normalized.chatId,
        normalized.channelInstanceId,
      );
      if (normalized !== b || normalizedKey !== key) bindingsChanged = true;
      this.bindings.set(normalizedKey, normalized);
    }
    if (bindingsChanged) this.persistBindings();

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    let permissionsChanged = false;
    for (const [id, p] of Object.entries(perms)) {
      const normalized = this.normalizePermissionLinkRecord(p);
      if (normalized !== p) permissionsChanged = true;
      this.permissionLinks.set(id, normalized);
    }
    if (permissionsChanged) this.persistPermissions();

    const workflows = readJson<Record<string, PlanWorkflowRecord>>(
      path.join(DATA_DIR, 'plan-workflows.json'),
      {},
    );
    let workflowsChanged = false;
    for (const [id, workflow] of Object.entries(workflows)) {
      const normalized = this.normalizePlanWorkflowRecord(workflow);
      if (normalized !== workflow) workflowsChanged = true;
      this.planWorkflows.set(id, normalized);
    }
    if (workflowsChanged) this.persistPlanWorkflows();

    const structuredInputs = readJson<Record<string, StructuredInputRequestRecord>>(
      path.join(DATA_DIR, 'structured-inputs.json'),
      {},
    );
    let structuredInputsChanged = false;
    for (const [id, request] of Object.entries(structuredInputs)) {
      const normalized = this.normalizeStructuredInputRequestRecord(request);
      if (normalized !== request) structuredInputsChanged = true;
      this.structuredInputRequests.set(id, normalized);
    }
    if (structuredInputsChanged) this.persistStructuredInputs();

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistPlanWorkflows(): void {
    writeJson(
      path.join(DATA_DIR, 'plan-workflows.json'),
      Object.fromEntries(this.planWorkflows),
    );
  }

  private persistStructuredInputs(): void {
    writeJson(
      path.join(DATA_DIR, 'structured-inputs.json'),
      Object.fromEntries(this.structuredInputRequests),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(
      path.join(MESSAGES_DIR, `${sessionId}.json`),
      [],
    );
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  private normalizeSessionRecord(session: BridgeSession | SessionRecord): SessionRecord {
    const record = session as SessionRecord & Record<string, unknown>;
    const extPartial: Partial<SessionExt> = { ...(record.ext || {}) };
    const legacyRuntime = typeof record.runtime === 'string' ? record.runtime : undefined;
    const legacyTitle = typeof record.title === 'string' ? record.title : undefined;
    const legacyTitleStatus = typeof record.title_status === 'string' ? record.title_status : undefined;
    if (!extPartial.runtime) {
      extPartial.runtime = (legacyRuntime as RuntimeName)
        || 'claude';
    }
    if (!extPartial.title && legacyTitle) extPartial.title = legacyTitle;
    extPartial.titleStatus = normalizeTitleStatus(extPartial.titleStatus)
      || normalizeTitleStatus(legacyTitleStatus)
      || 'pending';
    if (!extPartial.codexThreadId && typeof record.sdk_session_id === 'string' && extPartial.runtime === 'codex') {
      extPartial.codexThreadId = record.sdk_session_id;
    }
    extPartial.displayNameMode = normalizeDisplayNameMode(extPartial.displayNameMode);
    const ext: SessionExt = {
      runtime: extPartial.runtime || 'claude',
      ...(extPartial.title ? { title: extPartial.title } : {}),
      titleStatus: extPartial.titleStatus || 'pending',
      ...(extPartial.codexThreadId ? { codexThreadId: extPartial.codexThreadId } : {}),
      ...(extPartial.displayNameMode ? { displayNameMode: extPartial.displayNameMode } : {}),
    };
    return {
      ...record,
      ext,
    };
  }

  private normalizeChannelBindingRecord(binding: ChannelBinding): ChannelBinding {
    const record = binding as ChannelBinding & Record<string, unknown>;
    const mode = record.mode === 'plan' || record.mode === 'ask' || record.mode === 'code'
      ? record.mode
      : 'code';
    const claudePermissionMode = normalizeClaudePermissionMode(
      typeof record.claudePermissionMode === 'string' ? record.claudePermissionMode : undefined,
    );
    return {
      ...binding,
      channelInstanceId: resolveChannelInstanceId(record),
      mode,
      claudePermissionMode,
    };
  }

  private normalizePermissionLinkRecord(link: PermissionLinkRecord): PermissionLinkRecord {
    const record = link as PermissionLinkRecord & Record<string, unknown>;
    return {
      ...link,
      channelType: typeof record.channelType === 'string' && record.channelType
        ? record.channelType
        : 'feishu',
      channelInstanceId: resolveChannelInstanceId(record),
    };
  }

  private normalizePlanWorkflowRecord(workflow: PlanWorkflowRecord): PlanWorkflowRecord {
    const record = workflow as PlanWorkflowRecord & Record<string, unknown>;
    const channelInstanceId = resolveChannelInstanceId(record);
    return {
      ...workflow,
      channelInstanceId,
      address: {
        ...workflow.address,
        channelInstanceId: resolveChannelInstanceId(workflow.address || { channelInstanceId }),
      },
      ...(workflow.pendingAddress
        ? {
            pendingAddress: {
              ...workflow.pendingAddress,
              channelInstanceId: resolveChannelInstanceId(
                workflow.pendingAddress || { channelInstanceId },
              ),
            },
          }
        : {}),
    };
  }

  private normalizeStructuredInputRequestRecord(
    request: StructuredInputRequestRecord,
  ): StructuredInputRequestRecord {
    const record = request as StructuredInputRequestRecord & Record<string, unknown>;
    const channelInstanceId = resolveChannelInstanceId(record);
    return {
      ...request,
      channelInstanceId,
      address: {
        ...request.address,
        channelInstanceId: resolveChannelInstanceId(request.address || { channelInstanceId }),
      },
    };
  }

  private setSession(session: SessionRecord): void {
    this.sessions.set(session.id, this.normalizeSessionRecord(session));
    this.persistSessions();
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string, channelInstanceId?: string): ChannelBinding | null {
    return this.bindings.get(bindingKey(channelType, chatId, channelInstanceId)) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = bindingKey(data.channelType, data.chatId, data.channelInstanceId);
    const existing = this.bindings.get(key);
    if (existing) {
      const updated = this.normalizeChannelBindingRecord({
        ...existing,
        codepilotSessionId: data.codepilotSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        ...(data.claudePermissionMode !== undefined
          ? { claudePermissionMode: data.claudePermissionMode }
          : {}),
        updatedAt: now(),
      });
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }
    const binding = this.normalizeChannelBindingRecord({
      id: uuid(),
      channelType: data.channelType,
      channelInstanceId: resolveChannelInstanceId(data),
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: 'code',
      ...(data.claudePermissionMode !== undefined
        ? { claudePermissionMode: data.claudePermissionMode }
        : {}),
      active: true,
      createdAt: now(),
      updatedAt: now(),
    });
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        this.bindings.set(
          key,
          this.normalizeChannelBindingRecord({ ...b, ...updates, updatedAt: now() }),
        );
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session: SessionRecord = {
      id: uuid(),
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
      ext: {
        runtime: 'claude',
        titleStatus: 'pending',
      },
    };
    this.setSession(session);
    return session;
  }

  createRuntimeSession(params: {
    runtime: RuntimeName;
    model: string;
    cwd?: string;
    systemPrompt?: string;
    titleStatus?: TitleStatus;
  }): SessionRecord {
    const session = this.createSession(
      `Bridge: ${params.runtime}`,
      params.model,
      params.systemPrompt,
      params.cwd,
      'code',
    ) as SessionRecord;
    session.ext = {
      runtime: params.runtime,
      titleStatus: params.titleStatus || 'pending',
    };
    this.setSession(session);
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      this.persistSessions();
    }
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    msgs.push({ role, content });
    this.persistMessages(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // no-op for file-based store
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.sdk_session_id = sdkSessionId;
      this.persistSessions();
    }
    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  getCodexThreadId(sessionId: string): string {
    return this.sessions.get(sessionId)?.ext?.codexThreadId || '';
  }

  updateCodexThreadId(sessionId: string, threadId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.ext = {
      ...(session.ext || {
        runtime: 'claude',
        titleStatus: 'pending',
      }),
      codexThreadId: threadId,
    };
    this.persistSessions();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  getSessionExt(sessionId: string): SessionExt | null {
    const session = this.sessions.get(sessionId);
    return session?.ext ? { ...session.ext } : null;
  }

  updateSessionExt(sessionId: string, updates: Partial<SessionExt>): SessionExt | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.ext = {
      ...(session.ext || {
        runtime: 'claude',
        titleStatus: 'pending',
      }),
      ...updates,
    };
    this.persistSessions();
    return { ...session.ext };
  }

  getSessionSdkSessionId(sessionId: string): string {
    return this.sessions.get(sessionId)?.sdk_session_id || '';
  }

  migrateLegacySessions(defaultRuntime: RuntimeName = 'claude'): boolean {
    let changed = false;
    for (const session of this.sessions.values()) {
      if (!session.ext?.runtime) {
        session.ext = {
          ...(session.ext || {}),
          runtime: defaultRuntime,
          titleStatus: normalizeLegacyTitleStatus(session.ext?.titleStatus),
          ...(session.sdk_session_id && defaultRuntime === 'codex' ? { codexThreadId: session.sdk_session_id } : {}),
        };
        changed = true;
      }
      const normalizedTitleStatus = normalizeLegacyTitleStatus(session.ext?.titleStatus);
      if (session.ext?.titleStatus !== normalizedTitleStatus) {
        session.ext = {
          ...(session.ext || {}),
          runtime: session.ext?.runtime || defaultRuntime,
          titleStatus: normalizedTitleStatus,
        };
        changed = true;
      }
    }
    if (changed) this.persistSessions();
    return changed;
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep last 1000
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record = this.normalizePermissionLinkRecord({
      permissionRequestId: link.permissionRequestId,
      channelType: link.channelType,
      channelInstanceId: resolveChannelInstanceId(link),
      chatId: link.chatId,
      messageId: link.messageId,
      ...(typeof (link as PermissionLinkInput & { openMessageId?: string }).openMessageId === 'string'
        ? { openMessageId: (link as PermissionLinkInput & { openMessageId?: string }).openMessageId }
        : {}),
      resolved: false,
      suggestions: link.suggestions,
    });
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(
    chatId: string,
    channelType?: string,
    channelInstanceId?: string,
  ): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (
        link.chatId === chatId
        && !link.resolved
        && (!channelType || link.channelType === channelType)
        && (!channelInstanceId || link.channelInstanceId === channelInstanceId)
      ) {
        result.push(link);
      }
    }
    return result;
  }

  upsertPlanWorkflow(workflow: PlanWorkflowInput): PlanWorkflowRecord {
    const existing = workflow.workflowId ? this.planWorkflows.get(workflow.workflowId) : undefined;
    const channelInstanceId = resolveChannelInstanceId(workflow);
    const record = this.normalizePlanWorkflowRecord({
      workflowId: existing?.workflowId || workflow.workflowId || uuid(),
      bindingId: workflow.bindingId,
      channelType: workflow.channelType,
      channelInstanceId,
      chatId: workflow.chatId,
      codepilotSessionId: workflow.codepilotSessionId,
      status: workflow.status,
      previousMode: workflow.previousMode,
      requestText: workflow.requestText,
      address: {
        ...workflow.address,
        channelInstanceId: resolveChannelInstanceId(workflow.address || { channelInstanceId }),
      },
      routeKey: workflow.routeKey,
      ...(workflow.requestMessageId ? { requestMessageId: workflow.requestMessageId } : {}),
      ...(workflow.planMessageId ? { planMessageId: workflow.planMessageId } : {}),
      ...(workflow.actionCardMessageId ? { actionCardMessageId: workflow.actionCardMessageId } : {}),
      ...(workflow.actionCardOpenMessageId ? { actionCardOpenMessageId: workflow.actionCardOpenMessageId } : {}),
      ...(workflow.approvalRequestId ? { approvalRequestId: workflow.approvalRequestId } : {}),
      ...(workflow.planText ? { planText: workflow.planText } : {}),
      ...(workflow.planFilePath ? { planFilePath: workflow.planFilePath } : {}),
      ...(workflow.allowedPrompts ? { allowedPrompts: workflow.allowedPrompts } : {}),
      ...(typeof workflow.activeAttemptId === 'string' ? { activeAttemptId: workflow.activeAttemptId } : {}),
      ...(typeof workflow.pendingFollowUpText === 'string' ? { pendingFollowUpText: workflow.pendingFollowUpText } : {}),
      ...(workflow.pendingFollowUpAttachments ? { pendingFollowUpAttachments: workflow.pendingFollowUpAttachments } : {}),
      ...(typeof workflow.pendingRequestMessageId === 'string' ? { pendingRequestMessageId: workflow.pendingRequestMessageId } : {}),
      ...(workflow.pendingAddress ? { pendingAddress: workflow.pendingAddress } : {}),
      ...(typeof workflow.pendingRouteKey === 'string' ? { pendingRouteKey: workflow.pendingRouteKey } : {}),
      resolved: workflow.resolved ?? existing?.resolved ?? false,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    });
    this.planWorkflows.set(record.workflowId, record);
    this.persistPlanWorkflows();
    return { ...record };
  }

  getPlanWorkflow(workflowId: string): PlanWorkflowRecord | null {
    const record = this.planWorkflows.get(workflowId);
    return record ? { ...record } : null;
  }

  getActivePlanWorkflowByBinding(bindingId: string): PlanWorkflowRecord | null {
    for (const workflow of this.planWorkflows.values()) {
      if (workflow.bindingId === bindingId) {
        return { ...workflow };
      }
    }
    return null;
  }

  getActivePlanWorkflowByChat(
    channelType: string,
    chatId: string,
    channelInstanceId?: string,
  ): PlanWorkflowRecord | null {
    for (const workflow of this.planWorkflows.values()) {
      if (
        workflow.channelType === channelType
        && workflow.chatId === chatId
        && workflow.channelInstanceId === resolveChannelInstanceId({ channelInstanceId })
      ) {
        return { ...workflow };
      }
    }
    return null;
  }

  updatePlanWorkflow(
    workflowId: string,
    updates: Partial<Omit<PlanWorkflowRecord, 'workflowId' | 'bindingId' | 'channelType' | 'chatId' | 'codepilotSessionId' | 'createdAt'>>,
  ): PlanWorkflowRecord | null {
    const record = this.planWorkflows.get(workflowId);
    if (!record) return null;
    const next = this.normalizePlanWorkflowRecord({
      ...record,
      ...updates,
      updatedAt: now(),
    });
    this.planWorkflows.set(workflowId, next);
    this.persistPlanWorkflows();
    return { ...next };
  }

  markPlanWorkflowResolved(workflowId: string): boolean {
    const workflow = this.planWorkflows.get(workflowId);
    if (!workflow || workflow.resolved) return false;
    workflow.resolved = true;
    workflow.updatedAt = now();
    this.persistPlanWorkflows();
    return true;
  }

  deletePlanWorkflow(workflowId: string): boolean {
    const deleted = this.planWorkflows.delete(workflowId);
    if (deleted) this.persistPlanWorkflows();
    return deleted;
  }

  upsertStructuredInputRequest(request: StructuredInputRequestInput): StructuredInputRequestRecord {
    const existing = this.structuredInputRequests.get(request.requestId);
    const channelInstanceId = resolveChannelInstanceId(request);
    const record = this.normalizeStructuredInputRequestRecord({
      requestId: request.requestId,
      channelType: request.channelType,
      channelInstanceId,
      chatId: request.chatId,
      codepilotSessionId: request.codepilotSessionId,
      address: {
        ...request.address,
        channelInstanceId: resolveChannelInstanceId(request.address || { channelInstanceId }),
      },
      routeKey: request.routeKey,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      questions: request.questions,
      draftAnswers: request.draftAnswers ?? existing?.draftAnswers ?? {},
      ...(request.messageId ? { messageId: request.messageId } : {}),
      ...(request.openMessageId ? { openMessageId: request.openMessageId } : {}),
      resolved: request.resolved ?? existing?.resolved ?? false,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    });
    this.structuredInputRequests.set(record.requestId, record);
    this.persistStructuredInputs();
    return { ...record };
  }

  getStructuredInputRequest(requestId: string): StructuredInputRequestRecord | null {
    const record = this.structuredInputRequests.get(requestId);
    return record ? { ...record } : null;
  }

  updateStructuredInputRequest(
    requestId: string,
    updates: Partial<Omit<StructuredInputRequestRecord, 'requestId' | 'channelType' | 'chatId' | 'codepilotSessionId' | 'createdAt'>>,
  ): StructuredInputRequestRecord | null {
    const current = this.structuredInputRequests.get(requestId);
    if (!current) return null;
    const next = this.normalizeStructuredInputRequestRecord({
      ...current,
      ...updates,
      updatedAt: now(),
    });
    this.structuredInputRequests.set(requestId, next);
    this.persistStructuredInputs();
    return { ...next };
  }

  markStructuredInputRequestResolved(requestId: string): boolean {
    const record = this.structuredInputRequests.get(requestId);
    if (!record || record.resolved) return false;
    record.resolved = true;
    record.updatedAt = now();
    this.persistStructuredInputs();
    return true;
  }

  deleteStructuredInputRequest(requestId: string): boolean {
    const deleted = this.structuredInputRequests.delete(requestId);
    if (deleted) this.persistStructuredInputs();
    return deleted;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}
