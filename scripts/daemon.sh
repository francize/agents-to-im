#!/usr/bin/env bash
set -euo pipefail
CTI_HOME="${CTI_HOME:-$HOME/.agents-to-im}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"
RESTART_SETTLE_SECONDS="${CTI_RESTART_SETTLE_SECONDS:-12}"

# ── Common helpers ──

ensure_dirs() { mkdir -p "$CTI_HOME"/{data,logs,runtime,data/messages}; }

is_source_checkout() {
  [ -d "$SKILL_DIR/.git" ]
}

load_config_env() {
  # 之所以不再用 `set -a; source config.env`：source 会把配置文件当 shell
  # 脚本执行，被注入命令替换/反引号就会本地代码执行。
  #
  # 改用 Node 解析隔离：
  #   1. `node --env-file="$cfg"` 用纯 KEY=VAL 解析器加载，不执行任何 shell；
  #   2. dump-env.mjs 仅输出 --env-file 真正引入的新键（用 baseline diff
  #      过滤父 shell 自带变量），按 POSIX 单引号严格转义为 export 行；
  #   3. eval 的对象是 dump-env.mjs 生成的字符串，不是 config.env 原文。
  local cfg="$CTI_HOME/config.env"
  [ -f "$cfg" ] || return 0
  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: node is required to load $cfg safely (Node >= 20.6 with --env-file=)" >&2
    exit 1
  fi
  local baseline
  baseline=$(printenv | awk -F= '{print $1}')
  local exports
  if ! exports=$(CTI_DUMP_BASELINE_KEYS="$baseline" node --env-file="$cfg" "$SKILL_DIR/scripts/dump-env.mjs" 2>&1); then
    echo "ERROR: failed to parse $cfg via node --env-file=:" >&2
    echo "$exports" >&2
    exit 1
  fi
  eval "$exports"
}

ensure_built() {
  if [ ! -f "$SKILL_DIR/dist/daemon.mjs" ]; then
    if ! is_source_checkout; then
      echo "Missing prebuilt daemon bundle: $SKILL_DIR/dist/daemon.mjs"
      echo "This installation looks like a packaged npm install, so runtime rebuild is not supported here."
      echo "Refresh the package with: npm install -g agents-to-im@beta"
      exit 1
    fi
    echo "Building daemon bundle..."
    (cd "$SKILL_DIR" && npm run build)
    return
  fi

  if ! is_source_checkout; then
    return
  fi

  # Only a live source checkout should trigger rebuild-on-change.
  local newest_src
  newest_src=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
  if [ -n "$newest_src" ]; then
    echo "Rebuilding daemon bundle (source changed)..."
    (cd "$SKILL_DIR" && npm run build)
  fi
}

# Clean environment for subprocess isolation.
clean_env() {
  unset CLAUDECODE 2>/dev/null || true

  local mode="${CTI_ENV_ISOLATION:-inherit}"
  if [ "$mode" = "strict" ]; then
    # Keep Claude and Codex auth variables available together. Runtime is
    # selected per session inside the bridge, so there is no global backend
    # mode to filter against here.
    :
  fi
}

read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || echo ""
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null
}

show_last_exit_reason() {
  if [ -f "$STATUS_FILE" ]; then
    local reason
    reason=$(grep -o '"lastExitReason"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//')
    [ -n "$reason" ] && echo "Last exit reason: $reason"
  fi
}

show_failure_help() {
  echo ""
  echo "Recent logs:"
  tail -20 "$LOG_FILE" 2>/dev/null || echo "  (no log file)"
  echo ""
  echo "Next steps:"
  echo "  1. Run diagnostics:  bash \"$SKILL_DIR/scripts/doctor.sh\""
  echo "  2. Check full logs:  bash \"$SKILL_DIR/scripts/daemon.sh\" logs 100"
  if is_source_checkout; then
    echo "  3. Rebuild bundle:   cd \"$SKILL_DIR\" && npm run build"
  else
    echo "  3. Refresh install:  npm install -g agents-to-im@beta"
  fi
}

feishu_ws_endpoint_code() {
  if [ -z "${CTI_FEISHU_APP_ID:-}" ] || [ -z "${CTI_FEISHU_APP_SECRET:-}" ]; then
    echo "skip"
    return 0
  fi

  node - <<'NODE'
const https = require('https');

const base = process.env.CTI_FEISHU_DOMAIN || 'https://open.feishu.cn';
const url = new URL('/callback/ws/endpoint', base);
const body = JSON.stringify({
  AppID: process.env.CTI_FEISHU_APP_ID,
  AppSecret: process.env.CTI_FEISHU_APP_SECRET,
});

const req = https.request(
  url,
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      locale: 'zh',
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        process.stdout.write(String(parsed.code ?? 'unknown'));
      } catch {
        process.stdout.write('parse_error');
      }
    });
  },
);

req.on('error', () => {
  process.stdout.write('request_error');
});

req.write(body);
req.end();
NODE
}

wait_for_feishu_ws_slot() {
  local timeout="${CTI_FEISHU_WS_SLOT_TIMEOUT_SECONDS:-90}"
  local interval="${CTI_FEISHU_WS_SLOT_POLL_SECONDS:-3}"
  local start_ts
  local code
  start_ts=$(date +%s)

  while true; do
    code=$(feishu_ws_endpoint_code)
    case "$code" in
      0|skip)
        return 0
        ;;
      1000040350)
        if [ $(( $(date +%s) - start_ts )) -ge "$timeout" ]; then
          echo "Feishu WS slot is still occupied after ${timeout}s (code: ${code})."
          echo "Another bridge instance or a stale long connection is still using this Feishu app."
          echo "Wait a bit longer, or stop the other instance before retrying."
          return 1
        fi
        echo "Feishu WS slot is still occupied (code: ${code}). Waiting ${interval}s..."
        sleep "$interval"
        ;;
      *)
        echo "Warning: unable to verify Feishu WS slot (code: ${code}). Continuing start."
        return 0
        ;;
    esac
  done
}

current_run_id() {
  [ -f "$STATUS_FILE" ] && grep -o '"runId"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//'
}

current_run_log_slice() {
  local run_id="$1"
  [ -n "$run_id" ] || return 1
  [ -f "$LOG_FILE" ] || return 1
  awk "/Starting bridge \\(run_id: ${run_id//\//\\/}\\)/,0" "$LOG_FILE"
}

current_run_ws_health() {
  local run_id="$1"
  local slice
  slice=$(current_run_log_slice "$run_id" 2>/dev/null || true)
  [ -n "$slice" ] || { echo "unknown"; return 0; }

  if printf '%s\n' "$slice" | rg -q '1000040350|connect failed|unable to connect to the server after trying|PingInterval'; then
    echo "error"
  elif printf '%s\n' "$slice" | rg -q '\[ws\].*ws client ready'; then
    echo "ready"
  else
    echo "starting"
  fi
}

wait_until_stopped() {
  for _ in $(seq 1 10); do
    if ! supervisor_is_running && ! supervisor_is_managed; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ── Load platform-specific supervisor ──

case "$(uname -s)" in
  Darwin)
    # shellcheck source=supervisor-macos.sh
    source "$SKILL_DIR/scripts/supervisor-macos.sh"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows detected via Git Bash / MSYS2 / Cygwin — delegate to PowerShell
    echo "Windows detected. Delegating to supervisor-windows.ps1..."
    powershell.exe -ExecutionPolicy Bypass -File "$SKILL_DIR/scripts/supervisor-windows.ps1" "$@"
    exit $?
    ;;
  *)
    # shellcheck source=supervisor-linux.sh
    source "$SKILL_DIR/scripts/supervisor-linux.sh"
    ;;
esac

# ── Commands ──

case "${1:-help}" in
  start)
    ensure_dirs
    ensure_built

    # Check if already running (supervisor-aware: launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      EXISTING_PID=$(read_pid)
      echo "Bridge already running${EXISTING_PID:+ (PID: $EXISTING_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
      if ! status_running; then
        echo "Warning: supervisor reports a running bridge, but status.json is stale."
        echo "Use 'agents-to-im restart' if you want to refresh the runtime state."
      fi
      exit 0
    fi

    # Source config.env BEFORE clean_env so that CTI_ANTHROPIC_PASSTHROUGH
    # and other CTI_* flags are available when clean_env checks them.
    load_config_env
    if ! wait_for_feishu_ws_slot; then
      exit 1
    fi

    clean_env
    echo "Starting bridge..."
    supervisor_start

    # Poll for up to 10 seconds waiting for status.json to report running
    STARTED=false
    for _ in $(seq 1 10); do
      sleep 1
      if status_running; then
        STARTED=true
        break
      fi
      # If supervisor process already died, stop waiting
      if ! supervisor_is_running; then
        break
      fi
    done

    if [ "$STARTED" = "true" ]; then
      NEW_PID=$(read_pid)
      echo "Bridge started${NEW_PID:+ (PID: $NEW_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Failed to start bridge."
      supervisor_is_running || echo "  Process not running."
      status_running || echo "  status.json not reporting running=true."
      show_last_exit_reason
      show_failure_help
      exit 1
    fi
    ;;

  stop)
    if supervisor_is_managed; then
      echo "Stopping bridge..."
      supervisor_stop
      echo "Bridge stopped"
    else
      PID=$(read_pid)
      if [ -z "$PID" ]; then echo "No bridge running"; exit 0; fi
      if pid_alive "$PID"; then
        kill "$PID"
        for _ in $(seq 1 10); do
          pid_alive "$PID" || break
          sleep 1
        done
        pid_alive "$PID" && kill -9 "$PID"
        echo "Bridge stopped"
      else
        echo "Bridge was not running (stale PID file)"
      fi
      rm -f "$PID_FILE"
    fi
    ;;

  restart)
    echo "Restarting bridge..."
    if supervisor_is_managed || supervisor_is_running; then
      supervisor_stop
      if ! wait_until_stopped; then
        echo "Failed to stop bridge cleanly before restart."
        show_last_exit_reason
        exit 1
      fi
    fi
    rm -f "$PID_FILE"
    if [ "${RESTART_SETTLE_SECONDS}" -gt 0 ] 2>/dev/null; then
      echo "Waiting ${RESTART_SETTLE_SECONDS}s for external connections to settle..."
      sleep "${RESTART_SETTLE_SECONDS}"
    fi
    bash "$0" start
    ;;

  status)
    # Platform-specific status info (prints launchd/service state)
    supervisor_status_extra

    # Process status: supervisor-aware (launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      PID=$(read_pid)
      echo "Bridge process is running${PID:+ (PID: $PID)}"
      # Business status from status.json
      if status_running; then
        echo "Bridge status: running"
      else
        echo "Bridge status: process alive but status.json not reporting running"
      fi
      cat "$STATUS_FILE" 2>/dev/null
      echo
      RUN_ID=$(current_run_id)
      case "$(current_run_ws_health "$RUN_ID")" in
        ready)
          echo "Feishu WS health: ready"
          ;;
        error)
          echo "Feishu WS health: error detected in current run logs"
          ;;
        starting)
          echo "Feishu WS health: waiting for readiness signal"
          ;;
        *)
          echo "Feishu WS health: unknown"
          ;;
      esac
    else
      echo "Bridge is not running"
      [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
      show_last_exit_reason
    fi
    ;;

  logs)
    N="${2:-50}"
    tail -n "$N" "$LOG_FILE" 2>/dev/null | sed -E 's/(token|secret|password)(["\\x27]?\s*[:=]\s*["\\x27]?)[^ "]+/\1\2*****/gi'
    ;;

  *)
    echo "Usage: daemon.sh {start|stop|restart|status|logs [N]}"
    ;;
esac
