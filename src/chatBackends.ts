import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/** Provider-neutral tool definition derived from an MCP tool. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface PendingToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  id: string;
  content: string;
  isError?: boolean;
}

export interface TurnInput {
  userText?: string;
  toolOutcomes?: ToolOutcome[];
}

/** A chat model that can call tools, owning its own message history. */
export interface ChatBackend {
  readonly label: string;
  reset(): void;
  turn(input: TurnInput, onText: (delta: string) => void): Promise<{ toolCalls: PendingToolCall[] }>;
}

// ─────────────────────────── provider resolution ───────────────────────────

type PresetKind = 'anthropic' | 'openai';

interface Preset {
  kind: PresetKind;
  baseURL?: string;
  envKey?: string;
  defaultModel?: string;
}

const PRESETS: Record<string, Preset> = {
  anthropic: { kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5' },
  openai: { kind: 'openai', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-4.1' },
  deepseek: { kind: 'openai', baseURL: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
  kimi: { kind: 'openai', baseURL: 'https://api.moonshot.ai/v1', envKey: 'MOONSHOT_API_KEY', defaultModel: 'kimi-k2-0711-preview' },
  moonshot: { kind: 'openai', baseURL: 'https://api.moonshot.ai/v1', envKey: 'MOONSHOT_API_KEY', defaultModel: 'kimi-k2-0711-preview' },
  qwen: {
    kind: 'openai',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-plus',
  },
  openrouter: { kind: 'openai', baseURL: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY' },
  custom: { kind: 'openai' },
};

export interface ResolvedProvider {
  provider: string;
  kind: PresetKind;
  model: string;
  baseURL?: string;
  apiKey: string;
}

export interface ChatCliOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

/**
 * Resolve which LLM to use, from flags → SFCHAT_* env → provider preset.
 * `SFCHAT_API_KEY` overrides the provider-specific key env for any provider.
 */
export function resolveProvider(opts: ChatCliOptions): ResolvedProvider {
  const name = (opts.provider || process.env.SFCHAT_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : ''))
    .trim()
    .toLowerCase();
  if (!name) {
    throw new Error(
      'No chat provider set. Pass --provider <anthropic|openai|deepseek|kimi|qwen|openrouter|custom> ' +
        'or set SFCHAT_PROVIDER (and the matching API key).',
    );
  }
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unknown provider "${name}". Known: ${Object.keys(PRESETS).join(', ')}.`);

  const baseURL = opts.baseUrl || process.env.SFCHAT_BASE_URL || preset.baseURL;
  const model =
    opts.model ||
    process.env.SFCHAT_MODEL ||
    (preset.kind === 'anthropic' ? process.env.ANTHROPIC_MODEL?.trim() : undefined) ||
    preset.defaultModel;
  const apiKey =
    process.env.SFCHAT_API_KEY?.trim() || (preset.envKey ? process.env[preset.envKey]?.trim() : undefined) || '';

  if (preset.kind === 'anthropic') {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY (or SFCHAT_API_KEY) is not set.');
  } else {
    if (!baseURL) throw new Error(`Provider "${name}" needs a base URL — pass --base-url or set SFCHAT_BASE_URL.`);
    if (!apiKey) {
      throw new Error(
        `No API key for "${name}". Set ${preset.envKey ?? 'SFCHAT_API_KEY'}${
          preset.envKey ? ' or SFCHAT_API_KEY' : ''
        }.`,
      );
    }
  }
  if (!model) throw new Error(`No model for "${name}". Pass --model or set SFCHAT_MODEL.`);

  return { provider: name, kind: preset.kind, model, baseURL, apiKey };
}

export function createBackend(rp: ResolvedProvider, system: string, tools: ToolSpec[]): ChatBackend {
  return rp.kind === 'anthropic'
    ? new AnthropicBackend(rp, system, tools)
    : new OpenAICompatBackend(rp, system, tools);
}

// ─────────────────────────────── Anthropic ────────────────────────────────

const MAX_TOKENS = 16000;

class AnthropicBackend implements ChatBackend {
  readonly label: string;
  private readonly client: Anthropic;
  private readonly tools: Anthropic.Tool[];
  private messages: Anthropic.MessageParam[] = [];

  constructor(
    private readonly rp: ResolvedProvider,
    private readonly system: string,
    tools: ToolSpec[],
  ) {
    this.label = `anthropic · ${rp.model}`;
    this.client = new Anthropic({ apiKey: rp.apiKey, ...(rp.baseURL ? { baseURL: rp.baseURL } : {}) });
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  reset(): void {
    this.messages = [];
  }

  async turn(input: TurnInput, onText: (d: string) => void): Promise<{ toolCalls: PendingToolCall[] }> {
    if (input.userText != null) {
      this.messages.push({ role: 'user', content: input.userText });
    } else if (input.toolOutcomes) {
      this.messages.push({
        role: 'user',
        content: input.toolOutcomes.map((o) => ({
          type: 'tool_result' as const,
          tool_use_id: o.id,
          content: o.content,
          is_error: o.isError,
        })),
      });
    }

    const stream = this.client.messages.stream({
      model: this.rp.model,
      max_tokens: MAX_TOKENS,
      system: this.system,
      tools: this.tools,
      messages: this.messages,
    });
    stream.on('text', onText);
    const message = await stream.finalMessage();
    this.messages.push({ role: 'assistant', content: message.content });

    const toolCalls = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    return { toolCalls };
  }
}

// ──────────────────────── OpenAI-compatible (DeepSeek / Kimi / Qwen / …) ────────────────────────

class OpenAICompatBackend implements ChatBackend {
  readonly label: string;
  private readonly client: OpenAI;
  private readonly tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  private readonly systemMessage: OpenAI.Chat.Completions.ChatCompletionMessageParam;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];

  constructor(
    private readonly rp: ResolvedProvider,
    system: string,
    tools: ToolSpec[],
  ) {
    this.label = `${rp.provider} · ${rp.model}`;
    this.client = new OpenAI({ apiKey: rp.apiKey, baseURL: rp.baseURL });
    this.systemMessage = { role: 'system', content: system };
    this.messages = [this.systemMessage];
    this.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  reset(): void {
    this.messages = [this.systemMessage];
  }

  async turn(input: TurnInput, onText: (d: string) => void): Promise<{ toolCalls: PendingToolCall[] }> {
    if (input.userText != null) {
      this.messages.push({ role: 'user', content: input.userText });
    } else if (input.toolOutcomes) {
      for (const o of input.toolOutcomes) {
        this.messages.push({ role: 'tool', tool_call_id: o.id, content: o.content });
      }
    }

    const stream = await this.client.chat.completions.create({
      model: this.rp.model,
      messages: this.messages,
      tools: this.tools.length ? this.tools : undefined,
      stream: true,
    });

    let content = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        calls.set(tc.index, slot);
      }
    }

    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    this.messages.push({
      role: 'assistant',
      content: content || null,
      ...(ordered.length
        ? {
            tool_calls: ordered.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.args || '{}' },
            })),
          }
        : {}),
    });

    const toolCalls: PendingToolCall[] = ordered.map((c) => {
      let parsed: unknown = {};
      try {
        parsed = c.args ? JSON.parse(c.args) : {};
      } catch {
        parsed = {};
      }
      return { id: c.id, name: c.name, input: parsed };
    });
    return { toolCalls };
  }
}
