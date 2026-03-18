# Agents to IM

面向 Feishu/Lark 的单通道桥接，支持 Claude Code 和 Codex。

[English](README.md)

## 当前交互模型

- 私聊 Bot 只作为控制面。
- 私聊只接受 `/new:claude` 和 `/new:codex`。
- 每次 `/new:*` 都会新建一个群，群和会话一一绑定。
- 正式对话只发生在绑定群里。
- 绑定群默认开启流式卡片输出。
- 首轮成功后，Bot 会异步生成短标题并修改群名。

## 会话与 runtime

- `/new:claude` 创建 Claude runtime 会话。
- `/new:codex` 创建 Codex runtime 会话。
- runtime 是按 session 持久化的，不再是全局配置。
- 群内 `/reset` 会在当前群创建一个全新的 session，但保留原 runtime。

## 飞书 Bot 行为

- 私聊：
  - `/new:claude`
  - `/new:codex`
  - 其他输入只返回帮助文案
- 群聊：
  - 普通对话
  - `/reset`
  - `/perm allow|allow_session|deny <id>`
  - 其他斜杠命令统一拒绝

## 接入要求

- Node.js >= 20
- Claude 会话需要已安装并认证 Claude Code CLI
- Codex 会话需要安装 `@openai/codex-sdk`
- 飞书/Lark 自建应用已开启机器人能力
- 事件订阅方式使用长连接
- 事件至少包含：
  - `im.message.receive_v1`
  - `card.action.trigger`

权限范围会因租户策略而不同，但桥接默认依赖以下能力：

- 接收和读取 IM 消息
- 发送与更新 IM 消息
- 创建和更新群聊
- 拉人入群
- CardKit 读写

启动时会做 best-effort 的权限诊断，只记录日志，不因 scope introspection 失败而阻断启动。

## 配置

将 [config.env.example](config.env.example) 复制到 `~/.agents-to-im/config.env`。

主要环境变量：

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

## 快速开始

1. 在飞书开放平台完成应用配置并发布版本。
2. 填写 `~/.agents-to-im/config.env`。
3. 安装依赖：

```bash
npm install
```

4. 启动桥接：

```bash
/agents-to-im start
```

5. 在飞书私聊中发送 `/new:claude` 或 `/new:codex`。
6. 进入 Bot 新建的群里继续对话。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
```
