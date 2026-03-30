import path from 'node:path';

import type { ChannelBinding } from '../bridge/types.js';

export interface RecentWorkspaceOption {
  shortLabel: string;
  label: string;
  value: string;
  updatedAt: string;
}

interface WorkspaceSource {
  workingDirectory: string;
  updatedAt: string;
}

function normalizeWorkspacePath(rawPath: string | null | undefined): string | null {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function buildWorkspaceLabel(workspacePath: string): { shortLabel: string; label: string } {
  const shortLabel = path.basename(workspacePath) || workspacePath;
  return {
    shortLabel,
    label: `${shortLabel} · ${workspacePath}`,
  };
}

export function listRecentWorkspaces(
  bindings: Array<Pick<ChannelBinding, 'workingDirectory' | 'updatedAt'>> | WorkspaceSource[],
  defaultWorkdir?: string | null,
  limit = 5,
): RecentWorkspaceOption[] {
  const deduped = new Map<string, RecentWorkspaceOption>();
  const normalizedBindings = [...bindings].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  for (const binding of normalizedBindings) {
    const workspacePath = normalizeWorkspacePath(binding.workingDirectory);
    if (!workspacePath || deduped.has(workspacePath)) continue;
    const labels = buildWorkspaceLabel(workspacePath);
    deduped.set(workspacePath, {
      ...labels,
      value: workspacePath,
      updatedAt: binding.updatedAt,
    });
  }

  const defaultPath = normalizeWorkspacePath(defaultWorkdir || undefined);
  if (defaultPath && !deduped.has(defaultPath)) {
    const labels = buildWorkspaceLabel(defaultPath);
    deduped.set(defaultPath, {
      ...labels,
      value: defaultPath,
      updatedAt: '',
    });
    const ordered = [defaultPath, ...Array.from(deduped.keys()).filter((value) => value !== defaultPath)];
    return ordered.slice(0, limit).map((key) => deduped.get(key)!);
  }

  return Array.from(deduped.values()).slice(0, limit);
}
