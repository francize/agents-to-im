import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeName } from '../runtime/types.js';

type JsonRecord = Record<string, unknown>;

export interface NativeSessionSummary {
  runtime: RuntimeName;
  nativeSessionId: string;
  title: string;
  updatedAt: string;
  cwd: string;
  rawPath: string;
}

export interface NativeReplayItem {
  kind: 'user_message' | 'assistant_message' | 'tool_result';
  text: string;
  toolName?: string;
  isError?: boolean;
}

export interface NativeSessionTranscript {
  session: NativeSessionSummary;
  items: NativeReplayItem[];
}

function resolveCodexRootDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function resolveClaudeRootDir(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function resolveCodexSessionsRoots(): string[] {
  const codexRoot = resolveCodexRootDir();
  return [
    path.join(codexRoot, 'sessions'),
    path.join(codexRoot, 'archived_sessions'),
  ];
}

function resolveClaudeProjectsRoot(): string {
  return path.join(resolveClaudeRootDir(), 'projects');
}

function normalizePathCandidate(rawPath: string | null | undefined): string {
  return path.resolve(rawPath || '.');
}

function isPathWithin(root: string, target: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (normalizedRoot === normalizedTarget) return true;
  if (normalizedRoot === path.parse(normalizedRoot).root) {
    return normalizedTarget.startsWith(normalizedRoot);
  }
  return normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function safeReadDir(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkJsonlFiles(rootDir: string): string[] {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of safeReadDir(current)) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile() && absolutePath.endsWith('.jsonl')) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

function readFirstLine(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    let offset = 0;
    let chunk = '';
    while (offset < 65536) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) break;
      chunk += buffer.toString('utf8', 0, bytesRead);
      const newlineIndex = chunk.indexOf('\n');
      if (newlineIndex >= 0) {
        return chunk.slice(0, newlineIndex).trim() || null;
      }
      offset += bytesRead;
    }
    return chunk.trim() || null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

function parseJsonLine(line: string): JsonRecord | null {
  try {
    return JSON.parse(line) as JsonRecord;
  } catch {
    return null;
  }
}

function readJsonlRecords(filePath: string): JsonRecord[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseJsonLine(line))
      .filter((value): value is JsonRecord => !!value);
  } catch {
    return [];
  }
}

function coerceText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => coerceText(item)).filter(Boolean).join('\n').trim();
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const record = value as JsonRecord;
  const directText = typeof record.text === 'string' ? record.text.trim() : '';
  if (directText) return directText;
  return Object.values(record).map((item) => coerceText(item)).filter(Boolean).join('\n').trim();
}

function sanitizeTitle(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function appendJsonlRecord(filePath: string, record: Record<string, unknown>): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let prefix = '';
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > 0) {
        const fd = fs.openSync(filePath, 'r');
        try {
          const lastByte = Buffer.alloc(1);
          fs.readSync(fd, lastByte, 0, 1, stats.size - 1);
          if (lastByte.toString('utf8') !== '\n') prefix = '\n';
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    fs.appendFileSync(filePath, `${prefix}${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function isCodexMetaUserText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('# AGENTS.md instructions') ||
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('<INSTRUCTIONS>')
  );
}

const CLAUDE_SKIP_FIRST_PROMPT_PATTERN = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

function isClaudeMetaUserText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('Generate a concise conversation title.') ||
    trimmed.startsWith('<command-message>') ||
    trimmed.startsWith('Base directory for this skill:') ||
    trimmed.startsWith('Caveat: The messages below') ||
    CLAUDE_SKIP_FIRST_PROMPT_PATTERN.test(trimmed)
  );
}

function isCodexTextBlockType(type: string): boolean {
  return type === 'input_text'
    || type === 'output_text'
    || type === 'input_markdown'
    || type === 'output_markdown'
    || type === 'text';
}

function extractCodexMessageText(payload: JsonRecord): string {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return coerceText(content);
  }
  return content
    .map((block) => {
      if (typeof block === 'string') {
        return block.trim();
      }
      if (!block || typeof block !== 'object') {
        return '';
      }
      const record = block as JsonRecord;
      const type = typeof record.type === 'string' ? record.type : '';
      if (!isCodexTextBlockType(type)) {
        return '';
      }
      return coerceText(record.text ?? record.content ?? record.value);
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function extractClaudeMessageText(entry: JsonRecord, role: 'user' | 'assistant'): string {
  const message = entry.message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as JsonRecord).content;
  if (!Array.isArray(content)) return '';
  const fragments = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as JsonRecord;
      if (record.type === 'text') {
        return coerceText(record.text);
      }
      return '';
    })
    .filter(Boolean);
  const text = fragments.join('\n\n').trim();
  if (role === 'user' && isClaudeMetaUserText(text)) return '';
  return text;
}

function extractClaudeToolResultText(entry: JsonRecord): { text: string; isError: boolean } | null {
  const message = entry.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as JsonRecord).content;
  if (!Array.isArray(content)) return null;
  const blocks = content
    .filter((block): block is JsonRecord => !!block && typeof block === 'object' && (block as JsonRecord).type === 'tool_result');
  if (blocks.length === 0) return null;
  const combined = blocks
    .map((block) => {
      const direct = coerceText(block.content);
      if (direct) return direct;
      return coerceText((entry as JsonRecord).toolUseResult);
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
  if (!combined) return null;
  const isError = blocks.some((block) => block.is_error === true);
  return { text: combined, isError };
}

function formatToolResult(toolName: string | undefined, text: string): string {
  const normalized = text.trim();
  if (!normalized) return '';
  return toolName ? `${toolName}\n${normalized}` : normalized;
}

function resolveCodexSessionMeta(filePath: string): { id: string; cwd: string } | null {
  const firstLine = readFirstLine(filePath);
  const record = firstLine ? parseJsonLine(firstLine) : null;
  if (!record || record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') {
    return null;
  }
  const payload = record.payload as JsonRecord;
  if (typeof payload.id !== 'string' || typeof payload.cwd !== 'string') {
    return null;
  }
  return {
    id: payload.id,
    cwd: normalizePathCandidate(payload.cwd),
  };
}

function scanCodexSessions(): Map<string, { rawPath: string; cwd: string }> {
  const resolved = new Map<string, { rawPath: string; cwd: string }>();
  for (const root of resolveCodexSessionsRoots()) {
    for (const filePath of walkJsonlFiles(root)) {
      const meta = resolveCodexSessionMeta(filePath);
      if (!meta || resolved.has(meta.id)) continue;
      resolved.set(meta.id, { rawPath: filePath, cwd: meta.cwd });
    }
  }
  return resolved;
}

function extractCodexFallbackTitle(rawPath: string): string {
  for (const record of readJsonlRecords(rawPath)) {
    if (record.type !== 'response_item' || !record.payload || typeof record.payload !== 'object') continue;
    const payload = record.payload as JsonRecord;
    if (payload.type !== 'message' || payload.role !== 'user') continue;
    const text = extractCodexMessageText(payload);
    if (!text || isCodexMetaUserText(text)) continue;
    return sanitizeTitle(text, 'Codex 会话');
  }
  return 'Codex 会话';
}

function extractCodexReplayItems(rawPath: string): NativeReplayItem[] {
  const items: NativeReplayItem[] = [];
  const toolNames = new Map<string, string>();
  for (const record of readJsonlRecords(rawPath)) {
    if (record.type !== 'response_item' || !record.payload || typeof record.payload !== 'object') continue;
    const payload = record.payload as JsonRecord;
    if (payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractCodexMessageText(payload);
      if (!text) continue;
      if (role === 'user' && isCodexMetaUserText(text)) continue;
      items.push({
        kind: role === 'user' ? 'user_message' : 'assistant_message',
        text,
      });
      continue;
    }
    if (payload.type === 'function_call') {
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const name = typeof payload.name === 'string' ? payload.name : '';
      if (callId && name) {
        toolNames.set(callId, name);
      }
      continue;
    }
    if (payload.type === 'function_call_output') {
      const output = coerceText(payload.output);
      if (!output) continue;
      const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
      const toolName = callId ? toolNames.get(callId) : undefined;
      items.push({
        kind: 'tool_result',
        text: formatToolResult(toolName, output),
        toolName,
        isError: false,
      });
    }
  }
  return items;
}

function readCodexSessionIndex(): Array<{ id: string; title: string; updatedAt: string }> {
  const indexPath = path.join(resolveCodexRootDir(), 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return [];
  return readJsonlRecords(indexPath)
    .map((record) => ({
      id: typeof record.id === 'string' ? record.id : '',
      title: typeof record.thread_name === 'string' ? record.thread_name : '',
      updatedAt: typeof record.updated_at === 'string' ? record.updated_at : '',
    }))
    .filter((record) => record.id);
}

function normalizeClaudeProjectDir(workingDirectory: string): string {
  const normalized = normalizePathCandidate(workingDirectory);
  const parts = normalized.split(path.sep).filter(Boolean);
  return `-${parts.join('-')}`;
}

function resolveClaudeSessionPath(nativeSessionId: string, workingDirectory: string): string {
  return path.join(
    resolveClaudeProjectsRoot(),
    normalizeClaudeProjectDir(workingDirectory),
    `${nativeSessionId}.jsonl`,
  );
}

function extractClaudeMetadataTitle(records: JsonRecord[], type: 'custom-title' | 'ai-title'): string {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type !== type) continue;
    const title = type === 'custom-title'
      ? coerceText(record.customTitle ?? record.title ?? record.text)
      : coerceText(record.aiTitle ?? record.title ?? record.text);
    if (title) return sanitizeTitle(title, '');
  }
  return '';
}

function extractClaudeFirstPromptTitle(records: JsonRecord[]): string {
  for (const record of records) {
    if (record.type !== 'user') continue;
    const text = extractClaudeMessageText(record, 'user');
    if (!text) continue;
    return sanitizeTitle(text, '');
  }
  return '';
}

function extractClaudeDisplayTitle(records: JsonRecord[], fallback: string): string {
  const customTitle = extractClaudeMetadataTitle(records, 'custom-title');
  if (customTitle) return customTitle;
  const aiTitle = extractClaudeMetadataTitle(records, 'ai-title');
  if (aiTitle) return aiTitle;
  const firstPromptTitle = extractClaudeFirstPromptTitle(records);
  if (firstPromptTitle) return sanitizeTitle(firstPromptTitle, fallback);
  for (const record of records) {
    if (typeof record.slug === 'string' && record.slug.trim()) {
      return sanitizeTitle(record.slug, fallback);
    }
  }
  return fallback;
}

export function readClaudeSessionTitle(
  nativeSessionId: string,
  workingDirectory: string,
): string | null {
  const rawPath = resolveClaudeSessionPath(nativeSessionId, workingDirectory);
  if (!fs.existsSync(rawPath)) return null;
  const title = extractClaudeDisplayTitle(readJsonlRecords(rawPath), '');
  return title || null;
}

export function writeClaudeSessionTitle(
  nativeSessionId: string,
  workingDirectory: string,
  title: string,
): boolean {
  const rawPath = resolveClaudeSessionPath(nativeSessionId, workingDirectory);
  if (!fs.existsSync(rawPath)) return false;
  const normalizedTitle = sanitizeTitle(title, '');
  if (!normalizedTitle) return false;
  return appendJsonlRecord(rawPath, {
    type: 'custom-title',
    customTitle: normalizedTitle,
    sessionId: nativeSessionId,
  });
}

function extractClaudeReplayItems(rawPath: string): NativeReplayItem[] {
  const items: NativeReplayItem[] = [];
  for (const record of readJsonlRecords(rawPath)) {
    if (record.type === 'user') {
      const toolResult = extractClaudeToolResultText(record);
      if (toolResult) {
        items.push({
          kind: 'tool_result',
          text: toolResult.text,
          isError: toolResult.isError,
        });
        continue;
      }
      const text = extractClaudeMessageText(record, 'user');
      if (text) {
        items.push({
          kind: 'user_message',
          text,
        });
      }
      continue;
    }
    if (record.type === 'assistant') {
      const text = extractClaudeMessageText(record, 'assistant');
      if (text) {
        items.push({
          kind: 'assistant_message',
          text,
        });
      }
    }
  }
  return items;
}

export function listRecentNativeSessions(
  runtime: RuntimeName,
  workingDirectory: string,
  limit = 5,
): NativeSessionSummary[] {
  const normalizedWorkingDirectory = normalizePathCandidate(workingDirectory);
  if (runtime === 'codex') {
    const codexSessions = scanCodexSessions();
    const sessions: NativeSessionSummary[] = [];
    for (const entry of readCodexSessionIndex()) {
        const resolved = codexSessions.get(entry.id);
        if (!resolved) continue;
        if (!isPathWithin(normalizedWorkingDirectory, resolved.cwd)) continue;
        sessions.push({
          runtime,
          nativeSessionId: entry.id,
          title: sanitizeTitle(entry.title, extractCodexFallbackTitle(resolved.rawPath)),
          updatedAt: entry.updatedAt || fs.statSync(resolved.rawPath).mtime.toISOString(),
          cwd: resolved.cwd,
          rawPath: resolved.rawPath,
        });
    }
    return sessions.slice(0, limit);
  }

  const projectDir = path.join(resolveClaudeProjectsRoot(), normalizeClaudeProjectDir(normalizedWorkingDirectory));
  return walkJsonlFiles(projectDir)
    .map((rawPath) => {
      const stats = fs.statSync(rawPath);
      const records = readJsonlRecords(rawPath);
      const nativeSessionId = path.basename(rawPath, '.jsonl');
      return {
        runtime,
        nativeSessionId,
        title: extractClaudeDisplayTitle(records, nativeSessionId),
        updatedAt: stats.mtime.toISOString(),
        cwd: normalizedWorkingDirectory,
        rawPath,
      } satisfies NativeSessionSummary;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export function loadNativeSessionTranscript(
  runtime: RuntimeName,
  nativeSessionId: string,
  workingDirectory: string,
): NativeSessionTranscript | null {
  const session = listRecentNativeSessions(runtime, workingDirectory, Number.MAX_SAFE_INTEGER)
    .find((item) => item.nativeSessionId === nativeSessionId);
  if (!session) return null;
  const items = runtime === 'codex'
    ? extractCodexReplayItems(session.rawPath)
    : extractClaudeReplayItems(session.rawPath);
  return {
    session,
    items,
  };
}
