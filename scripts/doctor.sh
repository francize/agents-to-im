#!/usr/bin/env bash
set -euo pipefail

CTI_HOME="${CTI_HOME:-$HOME/.agents-to-im}"
CONFIG_FILE="$CTI_HOME/config.env"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "[OK]   $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label"
    FAIL=$((FAIL + 1))
  fi
}

get_config() {
  grep "^$1=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//'
}

echo "agents-to-im doctor"
echo "CTI_HOME: $CTI_HOME"
echo

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    check "Node.js >= 20 ($(node -v))" 0
  else
    check "Node.js >= 20 ($(node -v))" 1
  fi
else
  check "Node.js installed" 1
fi

if [ -f "$CONFIG_FILE" ]; then
  check "config.env exists" 0
else
  check "config.env exists" 1
fi

APP_ID=$(get_config CTI_FEISHU_APP_ID || true)
APP_SECRET=$(get_config CTI_FEISHU_APP_SECRET || true)
WORKDIR=$(get_config CTI_DEFAULT_WORKDIR || true)

[ -n "$APP_ID" ] && check "CTI_FEISHU_APP_ID configured" 0 || check "CTI_FEISHU_APP_ID configured" 1
[ -n "$APP_SECRET" ] && check "CTI_FEISHU_APP_SECRET configured" 0 || check "CTI_FEISHU_APP_SECRET configured" 1
[ -n "$WORKDIR" ] && check "CTI_DEFAULT_WORKDIR configured" 0 || check "CTI_DEFAULT_WORKDIR configured" 1

CLAUDE_EXE=$(get_config CTI_CLAUDE_CODE_EXECUTABLE || true)
if [ -n "$CLAUDE_EXE" ]; then
  [ -x "$CLAUDE_EXE" ] && check "Claude CLI executable is valid ($CLAUDE_EXE)" 0 || check "Claude CLI executable is valid ($CLAUDE_EXE)" 1
elif command -v claude >/dev/null 2>&1; then
  check "Claude CLI available in PATH ($(claude --version 2>/dev/null || echo unknown))" 0
else
  check "Claude CLI available in PATH" 1
fi

if [ -d "$SKILL_DIR/node_modules/@openai/codex-sdk" ]; then
  check "@openai/codex-sdk installed" 0
else
  check "@openai/codex-sdk installed" 1
fi

if [ -n "${CTI_CODEX_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ] || [ -n "$(get_config CTI_CODEX_API_KEY || true)" ]; then
  check "Codex auth configured (API key present)" 0
elif command -v codex >/dev/null 2>&1; then
  check "Codex CLI available for interactive auth ($(codex --version 2>/dev/null || echo unknown))" 0
else
  check "Codex auth path available (API key or codex CLI)" 1
fi

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    check "Bridge process is running (PID $PID)" 0
  else
    check "Bridge process is running (stale PID file)" 1
  fi
else
  check "Bridge process is running" 1
fi

echo
echo "Feishu event subscription reminder:"
echo "  - im.message.receive_v1"
echo "  - card.action.trigger"
echo "  - Dispatch mode: long connection"
echo
echo "Summary: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
