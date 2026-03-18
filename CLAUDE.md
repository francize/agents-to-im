# CLAUDE.md — Project Guidelines for agents-to-im

## Replying to GitHub Issues

When replying to user-reported issues, always include a **self-help prompt** at the end of the reply. Guide users to use their AI coding assistant (Claude Code / Codex) to diagnose and fix the problem themselves. Example:

> **自助排查提示：** 你可以直接在 Claude Code（或 Codex）中发送以下提示，让 AI 帮你诊断问题：
>
> ```
> 请帮我排查 agents-to-im 桥接服务的问题。
> 1. 读取 ~/.agents-to-im/logs/bridge.log 最近 50 行日志
> 2. 读取 ~/.agents-to-im/config.env 检查配置是否正确
> 3. 运行 bash ~/.claude/skills/agents-to-im/scripts/doctor.sh 并分析输出
> 4. 根据日志和配置给出具体的修复建议
> ```

This approach:
- Reduces maintainer burden by enabling users to self-diagnose
- Leverages the fact that users already have an AI coding assistant installed
- Provides actionable next steps rather than just error explanations
