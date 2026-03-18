# Feishu/Lark 单通道流式会话迁移方案 Review

## 总体评估

方案方向正确，核心设计决策合理。以下逐项给出 Review 意见，分为 ✅ 认同、⚠️ 需细化、🔴 需修改 三类。

---

## ✅ 认同的设计决策

### 1. `openclaw-lark` 作为参考实现而非运行时依赖
正确。`openclaw-lark` 依赖 `openclaw/plugin-sdk` 的整套运行时（`LarkClient.runtime`、`ClawdbotConfig`、`createReplyDispatcherWithTyping` 等），直接 import 会把整个 OpenClaw 拉进来。内聚复制所需逻辑是唯一可行路径。

### 2. 私聊作为纯控制面 + 群聊绑定会话
交互模型清晰。避免了"私聊里同时既是控制通道又是对话通道"的状态管理混乱。

### 3. CardKit 主路径 + `im.message.patch` 降级 + 普通文本兜底
三级降级链与 `openclaw-lark` 的 [StreamingCardController](file:///Users/shesong/codes/openclaw-lark/src/card/streaming-card-controller.d.ts#15-89) 一致，是经过验证的架构。

### 4. 预览消息与最终消息复用同一条
避免双消息问题，方案提到"send() 不再新发一条消息"，正确。

### 5. 保留现有 bridge-manager / conversation-engine / store
最小化改动面，风险可控。

---

## ⚠️ 需要细化的点

### 6. [LLMProvider](file:///Users/shesong/codes/agents-to-im/src/llm-provider.ts#422-598) 多路复用的 session 隔离

方案提出新增 [LLMProvider](file:///Users/shesong/codes/agents-to-im/src/llm-provider.ts#422-598) 包装层根据 `session.runtime` 选择底层 provider，但需注意：

- 当前 [resolveProvider()](file:///Users/shesong/codes/agents-to-im/src/main.ts#28-96) 在 [main.ts:34-95](file:///Users/shesong/codes/agents-to-im/src/main.ts#L34-L95) 中是启动时一次性决策的。改成按 session 选择意味着 [SDKLLMProvider](file:///Users/shesong/codes/agents-to-im/src/llm-provider.ts#422-598) 和 [CodexProvider](file:///Users/shesong/codes/agents-to-im/src/codex-provider.ts#71-369) 需要**同时实例化并保活**
- [SDKLLMProvider](file:///Users/shesong/codes/agents-to-im/src/llm-provider.ts#422-598) 构造时验证 CLI 路径（preflight check），如果 `claude` CLI 不存在但用户只用 `/new:codex`，启动时应**跳过 Claude preflight** 而不是 fatal exit
- [CodexProvider](file:///Users/shesong/codes/agents-to-im/src/codex-provider.ts#71-369) 侧同理：[ensureSDK()](file:///Users/shesong/codes/agents-to-im/src/codex-provider.ts#80-112) 是 lazy 的，这个可以保留

> **建议**：明确 [LLMProvider](file:///Users/shesong/codes/agents-to-im/src/llm-provider.ts#422-598) 多路复用层的 lazy 初始化策略——按需实例化底层 provider，首次调用时才做 preflight。

### 7. 建群 API 的权限范围

方案提到"用 `client.request` 调 `/open-apis/im/v1/chats`"，需要确认飞书 Bot 权限：

- 建群需要 `im:chat` scope
- 拉人需要 `im:chat.member:create` scope（或 `contact:user.id:readonly`）
- 改群名需要 `im:chat:update` scope

> **建议**：在 Public Interfaces 或 Assumptions 中明确列出所需飞书 Bot scope，并在启动时做 scope 检查（可参考 `openclaw-lark` 的 [app-scope-checker.js](file:///Users/shesong/codes/openclaw-lark/src/core/app-scope-checker.js)）。

### 8. 串行队列的迁移

`openclaw-lark` 的 [chat-queue.js](file:///Users/shesong/codes/openclaw-lark/src/channel/chat-queue.js) 实现了按 `accountId:chatId` 的串行任务队列，保证同一群内消息不会并发处理。方案提到"迁入每 chat 串行队列"，但没有具体说明如何与现有 bridge `conversation-engine` 的锁机制（[acquireSessionLock](file:///Users/shesong/codes/agents-to-im/src/store.ts#308-321) / [releaseSessionLock](file:///Users/shesong/codes/agents-to-im/src/store.ts#329-335) 在 [store.ts:308-334](file:///Users/shesong/codes/agents-to-im/src/store.ts#L308-L334)）协调。

> **建议**：明确两者的关系——chat-queue 用于飞书入站消息排队，session lock 用于防止同一 session 的并发 LLM 调用。两者互补，不冲突，但需要在方案中说明。

### 9. WS 事件处理的连接管理

方案说"迁入 WS 事件处理"。当前 `agents-to-im` **不直接管理飞书 WebSocket 连接**——它通过上游 `claude-to-im` 的 feishu adapter 来建连。迁移后需要自己管理：

- WebSocket 连接建立（`@larksuiteoapi/node-sdk` 的 `WSClient` 或类似）
- 重连逻辑
- 事件分发到 handler

> **建议**：明确 WS 连接管理的实现方式——是用 `@larksuiteoapi/node-sdk` 现成的 WSClient/EventDispatcher，还是自行实现。这是一个工作量较大的模块。

### 10. 标题生成的时机与 prompt

方案说"首轮对话完成后用同一 runtime 额外生成一个简短标题"。需要注意：

- 对 Claude runtime，这意味着额外发起一次 `query()` 调用，会消耗 token 和时间
- 对 Codex runtime，需要额外开一个轻量线程
- 标题 prompt 应该传入首轮对话上下文的摘要，而不是完整历史

> **建议**：考虑用更轻量的方式——例如让 LLM 在首轮回复的 system prompt 中约定输出一个 `<title>` 标签，或者直接用首条用户消息截断作为 MVP、日后再补 LLM 命名。

---

## 🔴 需要修改的点

### 11. 对 `claude-to-im` feishu adapter 的接管方式不明确

方案说"在 `agents-to-im` 内新增本地 Feishu 适配层，启动时覆盖上游 feishu adapter"。但从代码看：

- `agents-to-im` 的 [main.ts](file:///Users/shesong/codes/agents-to-im/src/main.ts) 通过 `import 'claude-to-im/src/lib/bridge/adapters/index.js'` 来注册所有 adapter（包括 feishu）
- 如果要"覆盖"，需要确认上游 adapter registry 是否支持注册同名 adapter 并覆盖。如果不支持，需要更激进地**不 import 上游 adapter index**，而是只 import 需要的部分

> **需明确**：是 fork 上游 bridge adapter registry 逻辑？还是修改 init 顺序让本地 feishu adapter 后注册来覆盖？还是完全不走上游 adapter，在本地直接管理 WS 连接和消息分发？

鉴于方案目标是"只保留 Feishu/Lark 配置"，**最干净的做法是不再 import 上游 adapters/index.js**，完全在本地实现 Feishu transport 层，只复用 `bridge-manager` 的 session/conversation 管理能力。

### 12. [configToSettings()](file:///Users/shesong/codes/agents-to-im/src/config.ts#174-254) 的过渡策略缺失

当前 [config.ts](file:///Users/shesong/codes/agents-to-im/src/config.ts) 的 [configToSettings()](file:///Users/shesong/codes/agents-to-im/src/config.ts#174-254) 将本地配置翻译成上游 bridge 期望的 key（如 `bridge_feishu_enabled`、`bridge_feishu_app_id`）。如果本地接管了 Feishu transport，这些 key 可能就不再被上游消费，但 bridge-manager 启动时可能还检查 `bridge_feishu_enabled`。

> **需明确**：哪些 settings key 是 bridge-manager / conversation-engine 仍然需要的？配置层的变更需要和 bridge 启动逻辑对齐，否则 bridge 可能认为 feishu channel 没有 enable。

### 13. session 自定义字段的持久化

方案提到"sessions.json 增加自定义字段：`runtime`, `title`, `title_status`"。从 [store.ts:264-280](file:///Users/shesong/codes/agents-to-im/src/store.ts#L264-L280) 来看，[createSession()](file:///Users/shesong/codes/agents-to-im/src/store.ts#264-281) 返回的是 `BridgeSession` 类型，增加字段需要：

- 扩展 `BridgeSession` 类型（或者用 `Record<string, unknown>` 存自定义字段）
- 确保 bridge-manager 在路由消息时不会因为不认识这些字段而出问题

> **建议**：用 `session.metadata` 或类似存储约定来隔离自定义字段，而不是直接在 session 上加属性。当前 [updateSdkSessionId()](file:///Users/shesong/codes/agents-to-im/src/store.ts#342-357) 已经用了 [(s as unknown as Record<string, unknown>)](file:///Users/shesong/codes/openclaw-lark/src/card/reply-dispatcher.js#138-139) 的写法 ([store.ts:346](file:///Users/shesong/codes/agents-to-im/src/store.ts#L346))，说明上游类型不支持扩展。

---

## 补充建议

### A. 迁移分阶段落地

方案虽然完整但改动面太大（多路 runtime、建群、流式卡片、标题生成、配置收敛同时进行）。参考 feishu-streaming-capability.md 中的推荐顺序，建议拆成：

| 阶段 | 内容 | 可独立验证 |
|------|------|-----------|
| P0 | 本地 Feishu transport 层替换上游 adapter（WS 连接 + 消息收发） | ✅ 私聊/群聊收发消息可验证 |
| P1 | DM 控制面 + 建群 + binding | ✅ `/new:claude` 建群可验证 |
| P2 | 流式卡片（先 `im.message.patch` 降级路径） | ✅ 群内流式输出可验证 |
| P3 | CardKit 主路径升级 | ✅ 替换 P2 的降级路径 |
| P4 | 多路 runtime（`/new:codex`） | ✅ 两种 runtime 可分别验证 |
| P5 | 标题生成 + 配置收敛 + 文档清理 | ✅ 非功能性 |

### B. 错误恢复

方案没有提到群创建成功但 session 创建失败的回滚路径。如果建群成功但后续步骤（创建 session / binding）失败：
- 是保留空群并提示用户重试？
- 还是自动解散群？
- 群内首条消息发送前是否有"初始化中"的过渡状态？

### C. Lark SDK 依赖

方案没有明确引入哪个版本的 `@larksuiteoapi/node-sdk`。当前 [package.json](file:///Users/shesong/codes/openclaw-lark/package.json) 没有这个依赖。需要确认：
- 使用 `@larksuiteoapi/node-sdk` v2 还是 v3
- WSClient 在该版本中是否稳定
- 是否需要单独的 `@larksuite/openclaw-lark-tools` 来做初始化配置

---

## 总结

方案的**产品设计**（DM 控制面 + 群会话 + 流式卡片）和**技术方向**（内聚复制 openclaw-lark 能力 + 复用 bridge contract）是正确的。主要问题在：

1. **对上游 bridge adapter 的接管方式**需要更精确的说明（不是"覆盖"，而是"替换"）
2. **多路 runtime 的 lazy 初始化**需要设计
3. **改动面过大**，建议明确分阶段交付
4. **飞书 Bot scope、Lark SDK 版本、错误恢复**需要补充
