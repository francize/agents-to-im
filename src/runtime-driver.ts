import crypto from 'node:crypto';

import type { LLMProvider, StreamChatParams } from './bridge/host.js';
import type { Config } from './config.js';
import { CodexProvider } from './codex-provider.js';
import { SDKLLMProvider } from './llm-provider.js';
import type { RuntimeName } from './runtime-types.js';
import { RUNTIME_CAPABILITIES, type ProviderCapabilities } from './runtime-capabilities.js';
import { JsonFileStore } from './store.js';

interface ParsedEvent {
  type: string;
  data: string;
}

function parseSSELine(line: string): ParsedEvent | null {
  if (!line.startsWith('data: ')) return null;
  try {
    return JSON.parse(line.slice(6)) as ParsedEvent;
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

async function readGeneratedTitle(stream: ReadableStream<string>): Promise<string | null> {
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
    throw new Error(errorMessage);
  }
  const normalized = normalizeGeneratedTitle(text);
  return normalized || null;
}

export interface RuntimeDriver {
  readonly runtime: RuntimeName;
  readonly capabilities: ProviderCapabilities;
  prepare(): Promise<void>;
  streamTurn(params: StreamChatParams): Promise<ReadableStream<string>>;
  generateTitle(sessionId: string, userText: string, assistantText: string): Promise<string | null>;
  dispose?(): Promise<void>;
}

abstract class BaseRuntimeDriver implements RuntimeDriver {
  abstract readonly runtime: RuntimeName;
  readonly capabilities: ProviderCapabilities;

  constructor(
    protected readonly store: JsonFileStore,
    protected readonly config: Config,
    runtime: RuntimeName,
  ) {
    this.capabilities = { ...RUNTIME_CAPABILITIES[runtime] };
  }

  abstract prepare(): Promise<void>;
  abstract streamTurn(params: StreamChatParams): Promise<ReadableStream<string>>;

  async generateTitle(sessionId: string, userText: string, assistantText: string): Promise<string | null> {
    const session = this.store.getSession(sessionId);
    const stream = await this.streamTurn({
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
    try {
      return await readGeneratedTitle(stream);
    } catch (error) {
      console.warn(
        `[runtime-driver:${this.runtime}] Title generation failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}

export class ClaudeRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'claude' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<SDKLLMProvider>,
  ) {
    super(store, config, 'claude');
  }

  async prepare(): Promise<void> {
    await this.providerLoader();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }
}

export class CodexRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'codex' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<CodexProvider>,
  ) {
    super(store, config, 'codex');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    if (typeof (provider as CodexProvider).prepare === 'function') {
      await provider.prepare();
    }
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async dispose(): Promise<void> {
    const provider = await this.providerLoader();
    if (typeof (provider as CodexProvider).close === 'function') {
      await provider.close();
    }
  }
}
