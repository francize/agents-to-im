---
name: agents-to-im
description: |
  Manage the Feishu/Lark bridge daemon for Claude Code and Codex.
  Use for: CLI install guidance, setup guidance, start/stop/status/logs/doctor,
  checking bridge health, or explaining how to configure the Feishu bot.
  This skill is Feishu/Lark-only.
argument-hint: "onboard | setup | start | stop | status | logs [N] | doctor | upgrade"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
---

# Agents to IM Skill

You are managing the Feishu/Lark bridge daemon.
User data is stored at `~/.agents-to-im/`.

The skill directory is `~/.claude/skills/agents-to-im`.
If that path does not exist, find `SKILL.md` via glob and derive the root directory from it.

## Commands

Map `$ARGUMENTS` to one of:

- `onboard`
- `setup`
- `start`
- `stop`
- `status`
- `logs`
- `doctor`
- `upgrade`

If no configuration exists at `~/.agents-to-im/config.env`, show `config.env.example` and explain the required Feishu fields. Do not try to start the daemon without config.

## CLI usage

Prefer the globally installed npm CLI:

- install once: `npm install -g agents-to-im@beta`
- `agents-to-im onboard`
- `agents-to-im start`
- `agents-to-im restart`
- `agents-to-im status`
- `agents-to-im doctor`
- `agents-to-im upgrade`
- `agents-to-im logs 100`

Use source checkout commands only for development/debugging.

## Setup

This project no longer has a multi-platform setup wizard. Setup means:

1. Show `config.env.example`.
2. Explain the required fields:
   - `CTI_FEISHU_APP_ID`
   - `CTI_FEISHU_APP_SECRET`
   - `CTI_DEFAULT_WORKDIR`
3. Explain optional fields:
   - `CTI_FEISHU_DOMAIN`
   - `CTI_FEISHU_ALLOWED_USERS`
   - external `CODEX_HOME` override if the user stores Codex config outside `~/.codex`
4. Point the user to `references/setup-guides.md` for the one-shot Feishu scopes import JSON.
5. Remind the user to enable Feishu long connection events:
   - `im.message.receive_v1`
   - `card.action.trigger`
6. Remind the user that private chat only accepts `/new:claude` and `/new:codex`, and real conversation happens in the auto-created group.

## Runtime behavior

- Runtime is selected per session.
- `/new:claude` creates a Claude session.
- `/new:codex` creates a Codex session.
- `/reset` keeps the current group's runtime.

## Execution

Use:

- `agents-to-im onboard`
- `bash "SKILL_DIR/scripts/daemon.sh" start`
- `bash "SKILL_DIR/scripts/daemon.sh" stop`
- `bash "SKILL_DIR/scripts/daemon.sh" status`
- `bash "SKILL_DIR/scripts/daemon.sh" logs 50`
- `bash "SKILL_DIR/scripts/doctor.sh"`

When showing logs or doctor output, summarize the important lines instead of dumping excessive raw output.
