# Usage Guide

当前通过 `npx github:francize/agents-to-im ...` 管理 daemon，但真正的模型对话发生在 Bot 自动创建的群里。

## setup

`setup` 不再是多平台向导，而是 Feishu-only 配置说明：

```bash
npx github:francize/agents-to-im
```

你需要准备：
- `CTI_FEISHU_PROFILE_IDS`
- `CTI_FEISHU_PROFILE_<ID>_APP_ID`
- `CTI_FEISHU_PROFILE_<ID>_APP_SECRET`
- `CTI_RUNTIME_CLAUDE_FEISHU_PROFILE`
- `CTI_RUNTIME_CODEX_FEISHU_PROFILE`
- `CTI_DEFAULT_WORKDIR`

可选项：
- `CTI_FEISHU_PROFILE_<ID>_DOMAIN`
- `CTI_FEISHU_PROFILE_<ID>_ALLOWED_USERS`
- `CTI_FEISHU_PROFILE_<ID>_TOOL_OUTPUT_CARDS`
- `CTI_FEISHU_PROFILE_<ID>_AUTO_IMAGE_SEND`
- `CTI_FEISHU_PROFILE_<ID>_LABEL`
- `CTI_CLAUDE_DEFAULT_MODEL`
- `CTI_CODEX_DEFAULT_MODEL`
- `CTI_CLAUDE_CODE_EXECUTABLE`
- `CTI_AUTO_APPROVE`

Codex 直接复用本地 `codex` CLI 和 `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）。

还需要在飞书开放平台开启：
- 长连接事件 `im.message.receive_v1`
- 卡片回调 `card.action.trigger`

## start

启动 bridge daemon：

```bash
npx github:francize/agents-to-im start
```

如果启动失败，优先执行 `npx github:francize/agents-to-im doctor`。

## restart

配置或代码变化后的推荐恢复方式：

```bash
npx github:francize/agents-to-im restart
bash scripts/daemon.sh restart
```

修改 `config.env`、更新代码、或重新发布飞书事件 / 权限后，优先执行 `restart`。

## stop

停止 daemon：

```bash
npx github:francize/agents-to-im stop
```

## status

查看 daemon 运行状态：

```bash
npx github:francize/agents-to-im status
```

输出会包含：
- 运行/停止状态
- PID
- 运行时长
- 已启用渠道（现在固定为 `feishu`）

## logs

查看最近日志：

```bash
npx github:francize/agents-to-im logs
npx github:francize/agents-to-im logs 200
```

日志文件默认位于 `~/.agents-to-im/logs/`，会自动脱敏。

## doctor

执行本地诊断：

```bash
npx github:francize/agents-to-im doctor
```

当前检查项包括：
- Node.js 版本
- 配置文件存在性
- Feishu 必填环境变量
- Claude CLI 可用性
- Codex CLI、`codex app-server` 与本地 config.toml 是否可用
- daemon 进程状态
- 飞书长连接事件配置提醒

## Runtime 行为

运行时选择改成按会话决定：
- 私聊 Bot 只接受 `/new:claude` 和 `/new:codex`
- 每次 `/new:*` 都会创建一个新群，并把群和 session 一一绑定
- 群内默认启用流式卡片输出
- 群内 `/reset` 会创建新 session，但保持当前群的 runtime
- 权限交互优先走卡片按钮，必要时可在群内使用 `/perm allow|allow_session|deny <id>`
