# Agents to IM

Feishu/Lark-only bridge for Claude Code and Codex.

[中文文档](README_CN.md)

## What Changed

- Private chat with the bot is now a control plane only.
- The bot accepts only `/new:claude` and `/new:codex` in DM.
- Each `/new:*` creates a new Feishu group, and that group is bound to exactly one session.
- Group chats are the only place where model interaction happens.
- Streaming card output is enabled by default for bound groups.
- After the first successful turn, the bot generates a short title and renames the group.

## Runtime Model

- `/new:claude` creates a Claude-backed session.
- `/new:codex` creates a Codex-backed session.
- Runtime is stored per session, not globally.
- `/reset` in a bound group creates a fresh session in the same group and keeps the existing runtime.

## Feishu Bot Behaviour

- DM:
  - `/new:claude`
  - `/new:codex`
  - Anything else returns a short help message.
- Group:
  - Normal conversation
  - `/reset`
  - `/perm allow|allow_session|deny <id>`
  - Other slash commands are rejected.

## Required Setup

- Node.js >= 20
- Claude Code CLI installed and authenticated for Claude sessions
- `@openai/codex-sdk` installed for Codex sessions
- Feishu/Lark custom app with bot capability enabled
- Event dispatch mode set to long connection
- Events:
  - `im.message.receive_v1`
  - `card.action.trigger`

Recommended app scopes depend on your tenant policy, but the bridge expects enough permission for:

- reading and receiving IM messages
- sending and updating IM messages
- creating and updating chats
- adding chat members
- CardKit read/write

The bridge performs a best-effort startup diagnostic and logs missing or unverified capabilities without hard-failing startup.

## Configuration

Copy [config.env.example](config.env.example) to `~/.agents-to-im/config.env`.

Main variables:

- `CTI_FEISHU_APP_ID`
- `CTI_FEISHU_APP_SECRET`
- `CTI_FEISHU_DOMAIN`
- `CTI_FEISHU_ALLOWED_USERS`
- `CTI_DEFAULT_WORKDIR`
- `CTI_DEFAULT_MODE`
- `CTI_CLAUDE_DEFAULT_MODEL`
- `CTI_CODEX_DEFAULT_MODEL`
- `CTI_CLAUDE_CODE_EXECUTABLE`
- `CTI_CODEX_API_KEY`
- `CTI_CODEX_BASE_URL`
- `CTI_AUTO_APPROVE`

## Quick Start

1. Configure the Feishu app and publish it.
2. Fill `~/.agents-to-im/config.env`.
3. Install dependencies:

```bash
npm install
```

4. Start the bridge:

```bash
/agents-to-im start
```

5. In Feishu DM, send `/new:claude` or `/new:codex`.
6. Continue the conversation in the newly created group.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
