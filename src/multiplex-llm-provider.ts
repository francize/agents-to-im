import crypto from 'node:crypto';

import type { LLMProvider, StreamChatParams } from './bridge/host.js';

import type { Config } from './config.js';
import { CodexProvider } from './codex-provider.js';
import { SDKLLMProvider, preflightCheck, resolveClaudeCliPath } from './llm-provider.js';
import { PendingApprovals, type PendingPermissions, PendingStructuredInputs } from './permission-gateway.js';
import type { RuntimeName } from './runtime-types.js';
import { JsonFileStore } from './store.js';

function parseSSELine(line: string): { type: string; data: string } | null {
  if (!line.startsWith('data: ')) return null;
  try {
    return JSON.parse(line.slice(6)) as { type: string; data: string };
  } catch {
    return null;
  }
}

function normalizeGeneratedTitle(text: string): string {
  return text
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export class MultiplexLLMProvider implements LLMProvider {
  private claudeProvider: SDKLLMProvider | null = null;
  private codexProvider: CodexProvider | null = null;
  private claudeCliPath: string | null = null;
  private readonly pendingApprovals: PendingApprovals;
  private readonly pendingStructuredInputs: PendingStructuredInputs;
  private readonly config: Config;

  constructor(
    private readonly store: JsonFileStore,
    private readonly pendingPerms: PendingPermissions,
    pendingApprovals: PendingApprovals | Config,
    pendingStructuredInputs?: PendingStructuredInputs,
    config?: Config,
  ) {
    if (config) {
      this.pendingApprovals = pendingApprovals as PendingApprovals;
      this.pendingStructuredInputs = pendingStructuredInputs || new PendingStructuredInputs();
      this.config = config;
      return;
    }
    this.pendingApprovals = new PendingApprovals();
    this.pendingStructuredInputs = new PendingStructuredInputs();
    this.config = pendingApprovals as Config;
  }

  private getSessionRuntime(sessionId: string): RuntimeName {
    return this.store.getSessionExt(sessionId)?.runtime || this.config.legacyRuntime || 'claude';
  }

  private async getClaudeProvider(): Promise<SDKLLMProvider> {
    if (this.claudeProvider) return this.claudeProvider;
    const cliPath = this.config.claudeCliExecutable || resolveClaudeCliPath();
    if (!cliPath) {
      throw new Error(
        'Cannot find the `claude` CLI executable. Install Claude Code CLI or set CTI_CLAUDE_CODE_EXECUTABLE.',
      );
    }
    const check = preflightCheck(cliPath);
    if (!check.ok) {
      throw new Error(`Claude CLI preflight check failed: ${check.error}`);
    }
    this.claudeCliPath = cliPath;
    this.claudeProvider = new SDKLLMProvider(this.pendingPerms, cliPath, this.config.autoApprove);
    return this.claudeProvider;
  }

  private async getCodexProvider(): Promise<CodexProvider> {
    if (this.codexProvider) return this.codexProvider;
    const provider = new CodexProvider(this.pendingApprovals, this.pendingStructuredInputs);
    await provider.prepare();
    this.codexProvider = provider;
    return provider;
  }

  private async getProvider(runtime: RuntimeName): Promise<LLMProvider> {
    if (runtime === 'codex') return this.getCodexProvider();
    return this.getClaudeProvider();
  }

  async ensureRuntimeAvailable(runtime: RuntimeName): Promise<void> {
    await this.getProvider(runtime);
  }

  async ensureCodexNativePlanAvailable(): Promise<void> {
    const provider = await this.getCodexProvider();
    if (!(await provider.supportsNativePlan())) {
      throw new Error('本地 Codex 版本不支持原生 plan 模式');
    }
  }

  private streamWithRuntime(runtime: RuntimeName, params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          try {
            const provider = await self.getProvider(runtime);
            const reader = provider.streamChat(params).getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: message })}\n`);
            controller.close();
          }
        })().catch((error) => {
          controller.error(error);
        });
      },
    });
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return this.streamWithRuntime(this.getSessionRuntime(params.sessionId), params);
  }

  async generateTitle(sessionId: string, userText: string, assistantText: string): Promise<string | null> {
    const runtime = this.getSessionRuntime(sessionId);
    const session = this.store.getSession(sessionId);
    const stream = this.streamWithRuntime(runtime, {
      prompt: [
        'Generate a concise conversation title.',
        'Requirements:',
        '- Reply with title text only.',
        '- No quotes, no markdown, no punctuation decoration.',
        '- Prefer 4-10 Chinese characters or at most 4 English words.',
        '- Do not use tools.',
        '',
        `User: ${userText.slice(0, 240)}`,
        `Assistant: ${assistantText.slice(0, 320)}`,
      ].join('\n'),
      sessionId: `title-${crypto.randomUUID()}`,
      workingDirectory: session?.working_directory,
      model: session?.model,
    });
    const reader = stream.getReader();
    let text = '';
    let errorMessage = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of value.split('\n')) {
        const event = parseSSELine(line);
        if (!event) continue;
        if (event.type === 'text') {
          text += event.data;
        } else if (event.type === 'error') {
          errorMessage = event.data;
        }
      }
    }
    if (errorMessage) {
      console.warn(`[multiplex-llm] Title generation failed for ${sessionId}: ${errorMessage}`);
      return null;
    }
    const normalized = normalizeGeneratedTitle(text);
    return normalized || null;
  }

  async dispose(): Promise<void> {
    await this.codexProvider?.close();
  }
}
