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

推荐直接在飞书开放平台的“导入权限”里一次性导入下面这份 JSON。它覆盖了当前 bridge 的 Feishu/Lark 控制面、CardKit 流式，以及常见的文档 / 表格 / 任务 / 搜索等工具场景，后续比临时补权限稳定得多。

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "bitable:app",
      "bitable:app:readonly",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "contact:user.basic_profile:readonly",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "docs:doc",
      "docs:doc:readonly",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.comment:write_only",
      "docs:document.content:read",
      "docs:document.media:download",
      "docs:document.media:upload",
      "docs:document.subscription",
      "docs:document.subscription:read",
      "docs:document:copy",
      "docs:document:export",
      "docs:document:import",
      "docs:event.document_deleted:read",
      "docs:event.document_edited:read",
      "docs:event.document_opened:read",
      "docs:event:subscribe",
      "docx:document",
      "docx:document.block:convert",
      "docx:document:create",
      "docx:document:readonly",
      "drive:drive",
      "drive:drive:readonly",
      "event:ip_list",
      "im:app_feed_card:write",
      "im:chat",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:chat:read",
      "im:chat:update",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message.urgent:phone",
      "im:message.urgent:sms",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource",
      "sheets:spreadsheet",
      "wiki:wiki",
      "wiki:wiki:readonly"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "base:app:copy",
      "base:app:create",
      "base:app:read",
      "base:app:update",
      "base:field:create",
      "base:field:delete",
      "base:field:read",
      "base:field:update",
      "base:record:create",
      "base:record:delete",
      "base:record:retrieve",
      "base:record:update",
      "base:table:create",
      "base:table:delete",
      "base:table:read",
      "base:table:update",
      "base:view:read",
      "base:view:write_only",
      "board:whiteboard:node:create",
      "board:whiteboard:node:read",
      "calendar:calendar.event:create",
      "calendar:calendar.event:delete",
      "calendar:calendar.event:read",
      "calendar:calendar.event:reply",
      "calendar:calendar.event:update",
      "calendar:calendar.free_busy:read",
      "calendar:calendar:read",
      "contact:contact.base:readonly",
      "contact:user.base:readonly",
      "contact:user.basic_profile:readonly",
      "contact:user.employee_id:readonly",
      "contact:user:search",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.media:download",
      "docs:document.media:upload",
      "docs:document:copy",
      "docs:document:export",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive.metadata:readonly",
      "drive:file:download",
      "drive:file:upload",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:read",
      "im:chat:read",
      "im:message",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "im:message:readonly",
      "offline_access",
      "search:docs:read",
      "search:message",
      "sheets:spreadsheet.meta:read",
      "sheets:spreadsheet:create",
      "sheets:spreadsheet:read",
      "sheets:spreadsheet:write_only",
      "space:document:delete",
      "space:document:move",
      "space:document:retrieve",
      "task:comment:read",
      "task:comment:write",
      "task:task:read",
      "task:task:write",
      "task:task:writeonly",
      "task:tasklist:read",
      "task:tasklist:write",
      "wiki:node:copy",
      "wiki:node:create",
      "wiki:node:move",
      "wiki:node:read",
      "wiki:node:retrieve",
      "wiki:space:read",
      "wiki:space:retrieve",
      "wiki:space:write_only"
    ]
  }
}
```

说明：
- 如果你只想跑最小 IM bridge，至少也要保留 `im:message`、`im:chat:update`、`im:resource`、`cardkit:card:{read,write}` 和 `card.action.trigger` 对应能力。
- `application:application:self_manage` 只用于启动期的 best-effort scope 诊断；如果组织策略不允许，不会阻断 bridge 启动，但缺权限时只能在动作执行时暴露 API 错误。
- 这份导入 JSON 明显大于 bridge 的最小运行集合，但它更适合 Claude/Codex 在真实工作流里调用文档、表格、任务、搜索等飞书工具，能减少后续反复补权限。

## 4. 第一次发布

1. 进入 `Version Management & Release`
2. 创建一个新版本
3. 提交审核并等待管理员审批

没有完成发布前，Bot 和新权限都不会真正生效。

## 5. 启动 bridge

在本地配置好 `config.env` 后，启动：

```bash
agents-to-im start
```

飞书在保存长连接事件时会校验应用连接状态，所以 bridge 必须先起来。

## 6. 配置长连接事件

1. 打开 `https://open.feishu.cn/app/{app_id}/event?tab=event`
2. 把事件分发方式切到 `Long Connection`
3. 添加事件：
   - `im.message.receive_v1`
   - `im.message.message_read_v1`
   - `im.chat.updated_v1`
   - `im.chat.member.bot.added_v1`
   其中 `im.chat.updated_v1` 用于把用户手动修改的群名同步回 Codex/Claude 原生会话标题。
4. 打开 `https://open.feishu.cn/app/{app_id}/event?tab=callback`
5. 添加回调：
   - `card.action.trigger`
6. 保存

## 7. 第二次发布

事件和回调变更也需要重新发布：

1. 再创建一个新版本
2. 提交审核
3. 审批通过后，Bot 才能稳定收消息和接收卡片按钮回调

## 8. 可选：配置 Bot 悬浮菜单

建议再打开 `https://open.feishu.cn/app/{app_id}/bot`：

1. 进入机器人菜单配置
2. 至少添加两个悬浮菜单命令：
   (响应动作 选 发送文字消息)
   - `/new:claude`
   - `/new:codex`
3. 如果你修改了 Bot 菜单，记得再发布一次版本

## 9. 配置 bridge 环境变量

至少需要：
- `CTI_FEISHU_APP_ID`
- `CTI_FEISHU_APP_SECRET`
- `CTI_DEFAULT_WORKDIR`

常见可选项：
- `CTI_FEISHU_DOMAIN`
- `CTI_FEISHU_ALLOWED_USERS`

Claude 和 Codex 都直接使用本机 CLI 自己的默认模型、审批和安装路径。Codex runtime 会直接复用本地 `codex` CLI 及其 `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）。

单 Bot 配置示例：

```env
CTI_FEISHU_APP_ID=cli_xxx
CTI_FEISHU_APP_SECRET=xxx
CTI_DEFAULT_WORKDIR=/path/to/workdir
```

## 10. 使用方式

1. 私聊 Bot，发送 `/new:claude` 或 `/new:codex`
2. Bot 自动创建一个新群
3. 后续所有正式对话都在该群进行
4. 需要中断当前输出时，在群内发送 `/stop`
5. 需要清空会话但保留 runtime 时，在群内发送 `/reset`

如果你升级的是旧版 Feishu 接入，任何权限、事件或回调修改都需要重新发布版本并执行 `agents-to-im restart`。
