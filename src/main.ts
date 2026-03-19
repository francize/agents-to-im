/**
 * Daemon entry point for agents-to-im.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from './bridge/context.js';
import * as bridgeManager from './bridge/bridge-manager.js';

import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import './feishu/adapter.js';
import { MultiplexLLMProvider } from './multiplex-llm-provider.js';
import { JsonFileStore } from './store.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';
import { startDashboard, stopDashboard } from './dashboard.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

function applyConfigToEnv(config: ReturnType<typeof loadConfig>): void {
  if (config.claudeDefaultModel && !process.env.CTI_CLAUDE_DEFAULT_MODEL) {
    process.env.CTI_CLAUDE_DEFAULT_MODEL = config.claudeDefaultModel;
  }
  if (config.codexDefaultModel && !process.env.CTI_CODEX_DEFAULT_MODEL) {
    process.env.CTI_CODEX_DEFAULT_MODEL = config.codexDefaultModel;
  }
  if (config.claudeCliExecutable && !process.env.CTI_CLAUDE_CODE_EXECUTABLE) {
    process.env.CTI_CLAUDE_CODE_EXECUTABLE = config.claudeCliExecutable;
  }
  if (config.codexApiKey && !process.env.CTI_CODEX_API_KEY) {
    process.env.CTI_CODEX_API_KEY = config.codexApiKey;
  }
  if (config.codexBaseUrl && !process.env.CTI_CODEX_BASE_URL) {
    process.env.CTI_CODEX_BASE_URL = config.codexBaseUrl;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();
  applyConfigToEnv(config);

  const runId = crypto.randomUUID();
  const startTime = Date.now();
  console.log(`[agents-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  store.migrateLegacySessions(config.legacyRuntime || 'claude');
  const pendingPerms = new PendingPermissions();
  const llm = new MultiplexLLMProvider(store, pendingPerms, config);
  console.log('[agents-to-im] Runtime selection: per-session multiplex (claude/codex)');

  const gateway = {
    resolvePendingPermission: (
      id: string,
      resolution: { behavior: 'allow' | 'deny'; message?: string; updatedPermissions?: unknown[] },
    ) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: ['feishu'],
        });
        console.log(`[agents-to-im] Bridge started (PID: ${process.pid}, channels: feishu)`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[agents-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Start the dashboard status panel
  try {
    startDashboard({
      store,
      getUptime: () => (Date.now() - startTime) / 1000,
      getBridgeStatus: bridgeManager.getStatus,
    });
  } catch (err) {
    console.warn('[agents-to-im] Dashboard failed to start:', err instanceof Error ? err.message : err);
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[agents-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    stopDashboard();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[agents-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[agents-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[agents-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[agents-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[agents-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
