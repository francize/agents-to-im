# Contributing to agents-to-im

Thanks for your interest in contributing! This guide covers the development setup, code conventions, and pull request process.

## Quick Start

```bash
git clone https://github.com/francize/agents-to-im.git
cd agents-to-im
npm install
npm run build:all
npm run typecheck
npm test
```

## Development Setup

### Prerequisites

- Node.js 20+
- A Feishu/Lark custom app ([setup guide](references/setup-guides.md))
- Claude Code CLI and/or Codex CLI installed locally

### Running locally

```bash
npm run dev              # start with tsx (no build needed)
npm run build:all        # production build (daemon + CLI)
npm run typecheck        # type check without emitting
npm test                 # run all tests
```

### Project structure

```
src/
├── main.ts                  # daemon entry point
├── cli.ts                   # CLI entry point
├── config/                  # configuration loading and validation
├── bridge/                  # core bridge logic
│   ├── bridge-manager.ts    # session lifecycle
│   ├── conversation-engine.ts
│   ├── delivery-layer.ts    # message delivery abstraction
│   ├── channel-adapter.ts   # bridge/adapter interface
│   ├── markdown/            # Feishu markdown rendering helpers
│   └── security/            # rate limiting, input validation
├── feishu/                  # Feishu/Lark adapter
│   ├── adapter.ts           # channel adapter implementation
│   ├── lark-client.ts       # Lark SDK wrapper
│   ├── cards/               # CardKit card builders
│   ├── handlers/            # inbound event handlers
│   └── services/            # preview, activity, image services
├── providers/               # AI runtime providers
│   ├── claude/              # Claude Code SDK integration
│   ├── codex/               # Codex app-server integration
│   └── multiplex.ts         # runtime multiplexer
├── runtime/                 # runtime lifecycle (mode, plan, capabilities)
├── infra/                   # dashboard, store, SSE utilities
└── __tests__/               # test files
```

## Code Conventions

### TypeScript

- Strict mode enabled. No `any` unless absolutely necessary.
- Prefer `interface` over `type` for object shapes.
- Use named exports. Default exports only for entry points.

### Naming

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Private properties: prefix with `_`

### Error handling

- Never swallow errors silently. Log with context at minimum.
- Use early returns to reduce nesting.
- Throw typed errors when the caller can handle them; log and continue when they can't.

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Codex plan mode support
fix: prevent duplicate group creation on retry
docs: update setup guide for Lark international
refactor: extract card builder from adapter
test: add streaming card timeout tests
```

## Pull Request Process

1. **Fork** the repo and create a branch from `main`
2. **Make changes** with clear, focused commits
3. **Add tests** for new functionality
4. **Run checks** before pushing:

```bash
npm run typecheck
npm test
npm run build:all
```

5. **Open a PR** with:
   - A clear title following commit conventions
   - Description of what changed and why
   - Link to related issue if applicable

6. **Address review feedback** promptly

### What makes a good PR

- Solves one problem per PR
- Includes tests for new behavior
- Passes all existing tests
- Doesn't introduce unnecessary dependencies
- Updates documentation if behavior changes

## Reporting Issues

### Bug reports

Include:
- Steps to reproduce
- Expected vs actual behavior
- Output of `agents-to-im doctor`
- Relevant log lines (`agents-to-im logs 50`)
- Node.js version, OS

### Feature requests

Describe:
- The problem you're trying to solve
- Your proposed solution
- Alternative approaches you've considered

## Security

If you discover a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
