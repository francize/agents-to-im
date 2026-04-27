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
const dumpEnvSource = path.join(repoRoot, 'scripts', 'dump-env.mjs');

function copyHarnessScripts(scriptsDir: string) {
  fs.mkdirSync(scriptsDir, { recursive: true });
  const daemonScript = path.join(scriptsDir, 'daemon.sh');
  fs.copyFileSync(daemonScriptSource, daemonScript);
  fs.chmodSync(daemonScript, 0o755);
  fs.copyFileSync(dumpEnvSource, path.join(scriptsDir, 'dump-env.mjs'));
  return daemonScript;
}

function writeSecureConfig(ctiHome: string, body: string) {
  fs.mkdirSync(ctiHome, { recursive: true });
  const cfg = path.join(ctiHome, 'config.env');
  fs.writeFileSync(cfg, body);
  fs.chmodSync(cfg, 0o600);
  return cfg;
}

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

    const daemonScript = copyHarnessScripts(scriptsDir);
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
    writeSecureConfig(ctiHome, '# test config\n');

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

    const daemonScript = copyHarnessScripts(scriptsDir);
    fs.writeFileSync(path.join(distDir, 'daemon.mjs'), '// built bundle\n');
    writeSecureConfig(ctiHome, '# test config\n');
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

describe('daemon.sh config.env safe loader', () => {
  // 这一组用例锁定 M3 的安全性质：config.env 不再被 shell 当脚本执行，
  // 且只有白名单前缀的变量能正确进入子进程。

  function setupHarness(tempRoot: string, options: { configBody: string }) {
    const ctiHome = path.join(tempRoot, 'cti-home');
    const scriptsDir = path.join(tempRoot, 'scripts');
    const distDir = path.join(tempRoot, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(ctiHome, { recursive: true });
    const daemonScript = copyHarnessScripts(scriptsDir);
    writeStubSupervisor(path.join(scriptsDir, 'supervisor-macos.sh'));
    writeStubSupervisor(path.join(scriptsDir, 'supervisor-linux.sh'));
    fs.writeFileSync(path.join(distDir, 'daemon.mjs'), '// built bundle\n');
    const cfg = path.join(ctiHome, 'config.env');
    fs.writeFileSync(cfg, options.configBody);
    return { ctiHome, daemonScript };
  }

  it('does not execute shell payloads embedded in config.env (no command substitution)', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-daemon-payload-'));
    const canary = path.join(tempRoot, 'pwned.flag');
    // 旧 `set -a; source config.env` 会把 $(touch pwned.flag) 当命令展开执行；
    // 新加载流程必须把整段 payload 当字符串读入，永不触发文件系统副作用。
    const { ctiHome, daemonScript } = setupHarness(tempRoot, {
      configBody: `EVIL=$(touch ${canary})\nCTI_FOO=$(touch ${canary})\n`,
    });

    const result = spawnSync('bash', [daemonScript, 'start'], {
      encoding: 'utf-8',
      env: { ...process.env, CTI_HOME: ctiHome },
    });

    const canaryExists = fs.existsSync(canary);
    fs.rmSync(tempRoot, { recursive: true, force: true });

    assert.equal(canaryExists, false, 'config.env shell payload was executed during load');
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  it('forwards arbitrary config.env variables verbatim, preserving shell-tricky values', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-daemon-forward-'));
    const ctiHome = path.join(tempRoot, 'cti-home');
    const scriptsDir = path.join(tempRoot, 'scripts');
    const distDir = path.join(tempRoot, 'dist');
    const envDump = path.join(tempRoot, 'forwarded.env');
    fs.mkdirSync(distDir, { recursive: true });
    fs.mkdirSync(ctiHome, { recursive: true });
    const daemonScript = copyHarnessScripts(scriptsDir);

    // 自定义 stub supervisor：启动 node 进程前把当前 shell 中的关键变量
    // 落盘到 envDump，测试里再读回来比对。
    const stub = `#!/usr/bin/env bash
supervisor_is_running() { return 1; }
supervisor_is_managed() { return 1; }
supervisor_start() {
  mkdir -p "$CTI_HOME/runtime"
  printf '%s\\n' "$$" > "$PID_FILE"
  cat > "$STATUS_FILE" <<'JSON'
{"running": true}
JSON
  : > "${envDump}"
  printf 'CTI_FOO=%s\\n' "\${CTI_FOO:-}" >> "${envDump}"
  printf 'CTI_BAR_TRICKY=%s\\n' "\${CTI_BAR_TRICKY:-}" >> "${envDump}"
  printf 'ANTHROPIC_TEST=%s\\n' "\${ANTHROPIC_TEST:-}" >> "${envDump}"
  printf 'CUSTOM_USER_VAR=%s\\n' "\${CUSTOM_USER_VAR:-}" >> "${envDump}"
}
supervisor_stop() { return 0; }
supervisor_status_extra() { :; }
`;
    fs.writeFileSync(path.join(scriptsDir, 'supervisor-macos.sh'), stub);
    fs.writeFileSync(path.join(scriptsDir, 'supervisor-linux.sh'), stub);
    fs.writeFileSync(path.join(distDir, 'daemon.mjs'), '// built bundle\n');

    // 混入：常规变量、含特殊字符的值（验证 POSIX 单引号转义）、
    // 任意自定义前缀的变量（验证 dump-env.mjs 不再做白名单过滤）。
    const cfg = path.join(ctiHome, 'config.env');
    fs.writeFileSync(cfg, [
      `CTI_FOO=hello`,
      `CTI_BAR_TRICKY=a'b$(echo nope)\`echo nope\``,
      `ANTHROPIC_TEST=ant-value`,
      `CUSTOM_USER_VAR=user-defined`,
      ``,
    ].join('\n'));

    const result = spawnSync('bash', [daemonScript, 'start'], {
      encoding: 'utf-8',
      env: { ...process.env, CTI_HOME: ctiHome },
    });

    const dump = fs.readFileSync(envDump, 'utf-8');
    fs.rmSync(tempRoot, { recursive: true, force: true });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(dump, /^CTI_FOO=hello$/m);
    // 单引号转义必须保留字面值，不允许 $() 或反引号被展开成 'nope'。
    assert.match(dump, /^CTI_BAR_TRICKY=a'b\$\(echo nope\)`echo nope`$/m);
    assert.match(dump, /^ANTHROPIC_TEST=ant-value$/m);
    // 自定义前缀的变量也应该被透传（不再有白名单过滤）。
    assert.match(dump, /^CUSTOM_USER_VAR=user-defined$/m);
  });

  it('does not re-export parent-shell variables that pre-existed before --env-file ran', () => {
    // 父 shell 自带的变量（baseline）不应该被 dump-env.mjs 重复 export，
    // 否则所有继承自父进程的环境都会被 eval 一遍，毫无意义且增大风险面。
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-to-im-daemon-baseline-'));
    const { ctiHome, daemonScript } = setupHarness(tempRoot, {
      configBody: 'CTI_FROM_FILE=in-file\n',
    });

    // 预先把一个名字写进父 shell：daemon.sh 应该把它视作 baseline，不再 export。
    const result = spawnSync('bash', [
      '-c',
      `node --env-file="${ctiHome}/config.env" "${path.dirname(daemonScript)}/dump-env.mjs"`,
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CTI_HOME: ctiHome,
        CTI_PARENT_INHERITED: 'parent-value',
        CTI_DUMP_BASELINE_KEYS: Object.keys({
          ...process.env,
          CTI_PARENT_INHERITED: 'parent-value',
        }).join('\n'),
      },
    });

    fs.rmSync(tempRoot, { recursive: true, force: true });

    assert.equal(result.status, 0, result.stderr);
    // 来自 config.env 的新键被导出。
    assert.match(result.stdout, /^export CTI_FROM_FILE='in-file'$/m);
    // 父 shell 自带的同前缀变量绝对不能再次被 dump 出来。
    assert.doesNotMatch(result.stdout, /CTI_PARENT_INHERITED/);
  });
});
