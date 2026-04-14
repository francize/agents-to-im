# Troubleshooting

## Bridge 无法启动

症状：
- `agents-to-im start` 失败
- daemon 启动后立即退出

排查顺序：
1. 运行 `agents-to-im doctor`
2. 确认 Node.js >= 20：`node --version`
3. 确认 `~/.agents-to-im/config.env` 存在且包含 `CTI_FEISHU_APP_ID`、`CTI_FEISHU_APP_SECRET`
4. 确认至少一个 runtime 可用：
   - Claude：`claude --version`
   - Codex：检查 `codex --version`、`codex app-server --help` 与 `~/.codex/config.toml`
5. 查看日志：`agents-to-im logs 200`
6. Windows 上如果 `claude --version` 只命中 npm shim，给 `~/.agents-to-im/config.env` 增加 `CTI_CLAUDE_CODE_EXECUTABLE=...\\claude.cmd`，然后执行 `agents-to-im restart`

常见原因：
- Feishu 凭据缺失或填错
- Claude CLI 不存在，但你尝试创建 Claude 会话
- Claude Code 是在 bridge 启动后才安装或更新的，daemon 还在使用旧环境
- Codex 鉴权缺失，但你尝试创建 Codex 会话

## Feishu 私聊没有响应

症状：
- 私聊 bot 后没有任何回复

排查顺序：
1. 确认应用已发布并已启用 Bot 能力
2. 确认事件订阅方式为长连接
3. 确认已订阅 `im.message.receive_v1`
4. 确认 `CTI_FEISHU_ALLOWED_USERS` 没有把自己挡掉
5. 查看 bridge 日志里是否有入站事件

注意：
- 私聊不是正式会话面，只接受 `/new:claude` 和 `/new:codex`
- 其他私聊输入只会收到帮助提示，不会直接创建 session

## `/new:claude` 或 `/new:codex` 建群失败

症状：
- 私聊命令后返回“创建会话失败”
- 新群已创建，但没有绑定成功

排查顺序：
1. 查看错误信息中是否包含权限缺失
2. 确认应用已开通：
   - 消息收发
   - 群聊读取/更新
   - CardKit
   - message update / reactions
3. 确认对应 runtime 可用
4. 若 bridge 启动日志提示缺少 app scopes，先补权限再重新发布应用版本

说明：
- 创建群成功但初始化失败时，bridge 不会自动解散该群
- 该群会保持未绑定状态，后续消息会提示你重新私聊 Bot 建会话

## 群里能回复，但不是流式卡片

症状：
- 回复退化成普通卡片或普通文本

排查顺序：
1. 确认应用已开通 `cardkit:card:write`、`cardkit:card:read`
2. 确认已开通 `im:message:update`
3. 查看日志中是否出现 CardKit create/update 失败

说明：
- bridge 会按 `CardKit -> im.message.patch -> 普通卡片/文本` 逐级降级
- 只要最终消息能发出去，就不会再额外补发一条“完成消息”

## 群里输出停不下来，想直接打断

症状：
- Claude 或 Codex 仍在持续输出
- 你想立刻停止这一轮，再重新发下一条消息

处理方式：
1. 直接在当前群发送 `/stop`
2. 等待 Bot 返回已停止或停止中的提示
3. 再发送下一条需求

说明：
- `/stop` 的语义等价于本地 CLI 里的 `Esc` / `Command+C`
- 它只中断当前正在进行的这一轮，不会删除当前群绑定
- 如果你需要的是彻底换一个新会话，请使用 `/reset`

## 权限按钮点了没反应

症状：
- 卡片里的 allow/deny 按钮没有生效

排查顺序：
1. 确认事件回调里已经添加 `card.action.trigger`
2. 确认该事件所在版本已经发布并通过审批
3. 查看日志里是否收到 card action 事件
4. 修复后重新触发一次权限请求，确认新的审批卡片可以正常点击

## PID 状态异常

症状：
- `agents-to-im status` 显示运行中，但进程实际不存在
- `start` 认为已经启动

排查顺序：
1. 先执行 `agents-to-im stop`
2. 仍异常时，删除 `~/.agents-to-im/runtime/bridge.pid`
3. 重新执行 `agents-to-im restart`
