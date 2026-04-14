import type { LLMProvider, StreamChatParams } from '../bridge/host.js';

import type { Config } from '../config/config.js';
import { CodexProvider } from './codex/codex-provider.js';
import { SDKLLMProvider } from './claude/sdk-provider.js';
import { preflightCheck, resolveClaudeCliPath } from './claude/cli-support.js';
import { PendingApprovals, type PendingPermissions, PendingStructuredInputs } from './claude/permission-gateway.js';
import {
  ClaudeRuntimeDriver,
  CodexRuntimeDriver,
  type RuntimeDriver,
} from '../runtime/driver.js';
import {
  RUNTIME_CAPABILITIES,
  type ProviderCapabilities,
} from '../runtime/capabilities.js';
import type { RuntimeName } from '../runtime/types.js';
import { JsonFileStore } from '../infra/store.js';

export type { ProviderCapabilities } from '../runtime/capabilities.js';

export class MultiplexLLMProvider implements LLMProvider {
  private claudeProvider: SDKLLMProvider | null = null;
  private codexProvider: CodexProvider | null = null;
  private claudeDriver: ClaudeRuntimeDriver | null = null;
  private codexDriver: CodexRuntimeDriver | null = null;
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
    return this.store.getSessionExt(sessionId)?.runtime || 'claude';
  }

  getRuntimeCapabilities(runtime: RuntimeName): ProviderCapabilities {
    return { ...RUNTIME_CAPABILITIES[runtime] };
  }

  getSessionCapabilities(sessionId: string): ProviderCapabilities {
    return this.getRuntimeCapabilities(this.getSessionRuntime(sessionId));
  }

  private async getClaudeProvider(): Promise<SDKLLMProvider> {
    if (this.claudeProvider) return this.claudeProvider;
    const cliPath = resolveClaudeCliPath(this.config);
    if (!cliPath) {
      throw new Error(
        'Cannot find the `claude` CLI executable. Install Claude Code CLI and ensure it is available in PATH.',
      );
    }
    const check = preflightCheck(cliPath);
    if (!check.ok) {
      throw new Error(`Claude CLI preflight check failed: ${check.error}`);
    }
    this.claudeCliPath = cliPath;
    this.claudeProvider = new SDKLLMProvider(
      this.pendingPerms,
      this.pendingStructuredInputs,
      cliPath,
    );
    return this.claudeProvider;
  }

  private async getCodexProvider(): Promise<CodexProvider> {
    if (this.codexProvider) return this.codexProvider;
    const provider = new CodexProvider(this.pendingApprovals, this.pendingStructuredInputs);
    await provider.prepare();
    this.codexProvider = provider;
    return provider;
  }

  protected async getProvider(runtime: RuntimeName): Promise<LLMProvider> {
    if (runtime === 'codex') return this.getCodexProvider();
    return this.getClaudeProvider();
  }

  private getDriver(runtime: RuntimeName): RuntimeDriver {
    if (runtime === 'codex') {
      if (!this.codexDriver) {
        this.codexDriver = new CodexRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('codex') as Promise<CodexProvider>,
        );
      }
      return this.codexDriver;
    }
    if (!this.claudeDriver) {
      this.claudeDriver = new ClaudeRuntimeDriver(
        this.store,
        this.config,
        () => this.getProvider('claude') as Promise<SDKLLMProvider>,
      );
    }
    return this.claudeDriver;
  }

  async ensureRuntimeAvailable(runtime: RuntimeName): Promise<void> {
    await this.getDriver(runtime).prepare();
  }

  async ensureCodexNativePlanAvailable(): Promise<void> {
    const driver = this.getDriver('codex');
    await driver.prepare();
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
            const driver = self.getDriver(runtime);
            await driver.prepare();
            const reader = (await driver.streamTurn(params)).getReader();
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

  async readSessionTitle(sessionId: string): Promise<string | null> {
    const runtime = this.getSessionRuntime(sessionId);
    return this.getDriver(runtime).readSessionTitle(sessionId);
  }

  async writeSessionTitle(sessionId: string, title: string): Promise<void> {
    const runtime = this.getSessionRuntime(sessionId);
    await this.getDriver(runtime).writeSessionTitle(sessionId, title);
  }

  async dispose(): Promise<void> {
    await this.codexDriver?.dispose?.();
  }
}
