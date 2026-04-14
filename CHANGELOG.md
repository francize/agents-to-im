# Changelog

All notable changes to this project will be documented in this file.

## [0.0.4-beta.1] - 2026-04-14

### Fixed
- Apply `CTI_FEISHU_SHOW_TOOL_CALL_CARDS=false` to Codex command-execution and file-change cards as well, not just generic MCP/tool activity cards.

### Changed
- Clarify in docs that the tool-card toggle covers MCP/tool, command execution, and file-change activity cards.
- Extend regression coverage for suppressed Codex command activity projections.

## [0.0.4-beta.0] - 2026-04-14

### Fixed
- Add `CTI_FEISHU_SHOW_TOOL_CALL_CARDS` so Feishu/Lark sessions can hide tool-call activity cards while keeping normal assistant cards.
- Default tool-call activity cards to off to reduce group-session noise.
- Make `onboard` step skips advance directly to the next step instead of asking follow-up prompts and extra Enter confirmations.

### Changed
- Guide the tool-card toggle during `agents-to-im onboard` and persist the chosen value into `config.env`.
- Extend regression coverage for config parsing, onboarding flow, Feishu activity-card projection, and bridge-side suppression handling.

### References
- Issue: #7

## [0.0.3] - 2026-04-14

### Fixed
- Ignore stale `CTI_CLAUDE_CODE_EXECUTABLE` values that do not match the current host platform.
- Fall back to local Claude CLI discovery when an explicit Claude CLI override is cross-platform and unusable.
- Stop `onboard` from pre-filling Windows Claude paths on macOS/Linux hosts, or POSIX paths on Windows hosts.

### Changed
- Extend regression coverage for cross-platform Claude CLI override normalization and fallback discovery.

### References
- Issue: #5

## [0.0.2] - 2026-04-14

### Fixed
- Accept `CTI_CLAUDE_CODE_EXECUTABLE` as an explicit Claude CLI override for local daemon startup.
- Resolve Windows npm-installed `claude.cmd` shims to the real Claude Code `cli.js` entrypoint.
- Run JS-based Claude CLI entrypoints through Node during preflight instead of treating them as native binaries.
- Rebuild release artifacts so `dist/daemon.mjs`, `dist/cli.js`, `dist/cli-bin.mjs`, and `dist/cli.mjs` match current source behavior.

### Changed
- Document the Windows/npm Claude CLI path workaround and the need to restart the bridge after installing or updating Claude Code.
- Extend regression coverage for config persistence, CLI preflight, Windows path discovery, provider wiring, and CLI wrapper compatibility.

### References
- Issue: #3
