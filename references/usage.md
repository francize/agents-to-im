# Usage Guide

先执行 `npm install -g agents-to-im@beta`，然后通过 `agents-to-im ...` 管理 daemon；真正的模型对话发生在 Bot 自动创建的群里。

## onboard

显式运行引导：

```bash
agents-to-im onboard
```

它会先让你选择中文或英文，再写本地 `config.env`，然后按步骤引导飞书/Lark 平台侧配置：
- 导入 scopes JSON
- 先发布一次版本
- 启动/重启本地 bridge
- 配置 `Long Connection`
- 添加 `im.message.receive_v1`
- 添加 `im.message.message_read_v1`
- 添加 `im.chat.member.bot.added_v1`
- 添加 `card.action.trigger`
- 再发布一次让事件和卡片回调生效
- 可选配置 Bot 悬浮菜单 `/new:claude` 和 `/new:codex`

交互细节：
- 所有选择题都支持 `↑/↓` 和 `Enter`
- 复制 scopes JSON、打开 auth / event / callback / bot 页面前都会先确认
- 每一步都等你实际操作完再按回车继续
- 每个辅助动作都有 `Skip Now`

日常维护统一使用：

```bash
agents-to-im onboard
agents-to-im start
agents-to-im restart
agents-to-im status
agents-to-im doctor
agents-to-im upgrade
agents-to-im logs 200
agents-to-im stop
```

## setup

`setup` 现在就是飞书/Lark 配置说明：

```bash
agents-to-im onboard
```

你需要准备：
- `CTI_FEISHU_APP_ID`
- `CTI_FEISHU_APP_SECRET`
- `CTI_DEFAULT_WORKDIR`

可选项：
- `CTI_FEISHU_DOMAIN`
- `CTI_FEISHU_ALLOWED_USERS`

Claude 和 Codex 都直接复用本机 CLI 默认行为。Codex 直接复用本地 `codex` CLI 和 `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）。

还需要在飞书开放平台开启：
- 长连接事件 `im.message.receive_v1`
- 卡片回调 `card.action.trigger`

权限建议直接使用 [references/setup-guides.md](setup-guides.md) 中的完整 scopes JSON 进行一次性导入，而不是手工逐项勾选。

## start

启动 bridge daemon：

```bash
agents-to-im start
```

如果启动失败，优先执行 `agents-to-im doctor`。

## restart

配置或代码变化后的推荐恢复方式：

```bash
agents-to-im restart
bash scripts/daemon.sh restart
```

修改 `config.env`、更新代码、或重新发布飞书事件 / 权限后，优先执行 `restart`。

## stop

停止 daemon：

```bash
agents-to-im stop
```

## status

查看 daemon 运行状态：

```bash
agents-to-im status
```

输出会包含：
- 运行/停止状态
- PID
- 运行时长
- 已启用渠道（现在固定为 `feishu`）

## logs

查看最近日志：

```bash
agents-to-im logs
agents-to-im logs 200
```

日志文件默认位于 `~/.agents-to-im/logs/`，会自动脱敏。

## doctor

执行本地诊断：

```bash
agents-to-im doctor
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
- 群内 `/stop` 可以中断当前大模型输出，等价于本地 CLI 里的 `Esc` / `Command+C`
- 群内 `/reset` 会创建新 session，但保持当前群的 runtime
- 权限交互优先走卡片按钮；当群里恰好只有一个待处理请求时，也可以直接回复 `1` / `2` / `3`
