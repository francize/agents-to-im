import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const daemonScriptSource = path.join(repoRoot, 'scripts', 'daemon.sh');

function writeStubSupervisor(filePath: string) {
  fs.writeFileSync(filePath, `#!/usr/bin/env bash
supervisor_is_running() { return 1; }
supervisor_is_managed() { return 1; }
supervisor_start() {
  mkdir -p "$CTI_HOME/runtime"
  printf '%s\\n' "$$" > "$PID_FILE"
  cat > "$STATUS_FILE" <<'JSON'
{"running": true}
JSON
}
supervisor_stop() { return 0; }
supervisor_status_extra() { :; }
`);
  fs.chmodSync(filePath, 0o755);
}

describe('daemon.sh packaged install behavior', () => {
  it('does not rebuild when a packaged install already has a daemon bundle', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-daemon-test-'));
    const ctiHome = path.join(tempRoot, 'cti-home');
    const scriptsDir = path.join(tempRoot, 'scripts');
    const srcDir = path.join(tempRoot, 'src');
    const distDir = path.join(tempRoot, 'dist');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });

    const daemonScript = path.join(scriptsDir, 'daemon.sh');
    fs.copyFileSync(daemonScriptSource, daemonScript);
    fs.chmodSync(daemonScript, 0o755);
    writeStubSupervisor(path.join(scriptsDir, 'supervisor-macos.sh'));
    writeStubSupervisor(path.join(scriptsDir, 'supervisor-linux.sh'));

    const bundlePath = path.join(distDir, 'daemon.mjs');
    const sourcePath = path.join(srcDir, 'main.ts');
    fs.writeFileSync(bundlePath, '// built bundle\n');
    fs.writeFileSync(sourcePath, '// newer source file\n');

    const older = new Date('2024-01-01T00:00:00.000Z');
    const newer = new Date('2024-01-02T00:00:00.000Z');
    fs.utimesSync(bundlePath, older, older);
    fs.utimesSync(sourcePath, newer, newer);
    fs.mkdirSync(ctiHome, { recursive: true });
    fs.writeFileSync(path.join(ctiHome, 'config.env'), '# test config\n');

    const result = spawnSync('bash', [daemonScript, 'start'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
      },
    });

    fs.rmSync(tempRoot, { recursive: true, force: true });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Bridge started/);
    assert.doesNotMatch(result.stdout, /Building daemon bundle|Rebuilding daemon bundle/);
  });

  it('treats an already-running supervisor as a successful no-op start', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-daemon-running-'));
    const ctiHome = path.join(tempRoot, 'cti-home');
    const scriptsDir = path.join(tempRoot, 'scripts');
    const distDir = path.join(tempRoot, 'dist');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(path.join(ctiHome, 'runtime'), { recursive: true });

    const daemonScript = path.join(scriptsDir, 'daemon.sh');
    fs.copyFileSync(daemonScriptSource, daemonScript);
    fs.chmodSync(daemonScript, 0o755);
    fs.writeFileSync(path.join(distDir, 'daemon.mjs'), '// built bundle\n');
    fs.writeFileSync(path.join(ctiHome, 'config.env'), '# test config\n');
    fs.writeFileSync(path.join(ctiHome, 'runtime', 'status.json'), JSON.stringify({
      running: false,
      pid: 96410,
      lastExitReason: 'signal: SIGTERM',
    }, null, 2));

    const runningSupervisor = path.join(scriptsDir, 'supervisor-macos.sh');
    fs.writeFileSync(runningSupervisor, `#!/usr/bin/env bash
supervisor_is_running() { return 0; }
supervisor_is_managed() { return 0; }
supervisor_start() { return 0; }
supervisor_stop() { return 0; }
supervisor_status_extra() { :; }
`);
    fs.chmodSync(runningSupervisor, 0o755);
    fs.copyFileSync(runningSupervisor, path.join(scriptsDir, 'supervisor-linux.sh'));

    const result = spawnSync('bash', [daemonScript, 'start'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
      },
    });

    fs.rmSync(tempRoot, { recursive: true, force: true });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Bridge already running/);
    assert.match(result.stdout, /status\.json is stale/);
  });
});
