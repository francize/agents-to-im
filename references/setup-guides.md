# Feishu / Lark Setup Guide

本项目现在只支持 Feishu / Lark。

目标交互固定为：
- 私聊 Bot 只接受 `/new:claude` 和 `/new:codex`
- 每次 `/new:*` 新建一个群聊
- 群聊与 session 一一绑定
- 群内默认流式卡片回复

## 1. 创建自建应用

1. 访问飞书：[https://open.feishu.cn/app](https://open.feishu.cn/app)
2. 或访问 Lark：[https://open.larksuite.com/app](https://open.larksuite.com/app)
3. 创建 Custom App
4. 在 `Credentials & Basic Info` 里记录：
   - `App ID`
   - `App Secret`

## 2. 开启 Bot 能力

1. 进入 `Add Features`
2. 启用 `Bot`
3. 设置 Bot 名称和描述

## 3. 配置 app scopes

先完成权限配置并发布一次版本，再继续事件订阅。

推荐最小权限集合：

```json
{
  "scopes": {
    "tenant": [
      "im:message:send_as_bot",
      "im:message:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:update",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:chat:read",
      "im:chat:update",
      "im:resource",
      "cardkit:card:write",
      "cardkit:card:read",
      "application:application:self_manage"
    ],
    "user": []
  }
}
```

说明：
- 前 12 项用于消息收发、群绑定、群改名、typing 和流式卡片
- `application:application:self_manage` 只用于启动期的 best-effort scope 诊断；如果组织策略不允许，不会阻断 bridge 启动，但缺权限时只能在动作执行时暴露 API 错误

## 4. 第一次发布

1. 进入 `Version Management & Release`
2. 创建一个新版本
3. 提交审核并等待管理员审批

没有完成发布前，Bot 和新权限都不会真正生效。

## 5. 启动 bridge

在本地配置好 `config.env` 后，启动：

```bash
/agents-to-im start
```

飞书在保存长连接事件时会校验应用连接状态，所以 bridge 必须先起来。

## 6. 配置长连接事件

1. 进入 `Events & Callbacks`
2. 把事件分发方式切到 `Long Connection`
3. 添加事件：
   - `im.message.receive_v1`
4. 添加回调：
   - `card.action.trigger`
5. 保存

## 7. 第二次发布

事件和回调变更也需要重新发布：

1. 再创建一个新版本
2. 提交审核
3. 审批通过后，Bot 才能稳定收消息和接收卡片按钮回调

## 8. 配置 bridge 环境变量

至少需要：
- `CTI_FEISHU_APP_ID`
- `CTI_FEISHU_APP_SECRET`
- `CTI_DEFAULT_WORKDIR`

常见可选项：
- `CTI_FEISHU_DOMAIN`
- `CTI_FEISHU_ALLOWED_USERS`
- `CTI_CLAUDE_DEFAULT_MODEL`
- `CTI_CODEX_DEFAULT_MODEL`
- `CTI_CLAUDE_CODE_EXECUTABLE`
- `CTI_AUTO_APPROVE`

Codex runtime 会直接复用本地 `codex` CLI 及其 `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）。

## 9. 使用方式

1. 私聊 Bot，发送 `/new:claude` 或 `/new:codex`
2. Bot 自动创建一个新群
3. 后续所有正式对话都在该群进行
4. 需要清空会话但保留 runtime 时，在群内发送 `/reset`

如果你升级的是旧版 Feishu 接入，任何权限、事件或回调修改都需要重新发布版本并重启 bridge。
