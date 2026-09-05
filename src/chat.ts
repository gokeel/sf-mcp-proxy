import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { ConnectResult } from './mcpClient.js';
import { UnauthorizedError, summarizeToolResult } from './mcpClient.js';
import {
  createBackend,
  resolveProvider,
  type ChatBackend,
  type ChatCliOptions,
  type PendingToolCall,
  type ToolOutcome,
  type ToolSpec,
} from './chatBackends.js';

const MAX_TOOL_ITERATIONS = 25;
const WRITE_HINT =
  /(create|update|delete|insert|upsert|write|run|execute|mutat|convert|merge|assign|send|remove|patch|activate|deactivate)/i;

export interface ChatOptions extends ChatCliOptions {
  /** Auto-approve every tool call (no prompts). */
  autoApprove?: boolean;
  /** Prompt before every tool call, not just likely writes. */
  confirmAll?: boolean;
}

interface ToolMap {
  specs: ToolSpec[];
  toMcpName: Map<string, string>;
}

/** MCP tool defs → provider-neutral specs, sanitizing names to ^[a-zA-Z0-9_-]{1,64}$. */
export function buildToolMap(
  mcpTools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): ToolMap {
  const toMcpName = new Map<string, string>();
  const used = new Set<string>();
  const specs: ToolSpec[] = [];

  for (const t of mcpTools) {
    let safe = t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool';
    while (used.has(safe)) safe = safe.slice(0, 60) + '_' + (used.size % 1000);
    used.add(safe);
    toMcpName.set(safe, t.name);
    const schema = (t.inputSchema as Record<string, unknown>) ?? { type: 'object' };
    specs.push({ name: safe, description: t.description ?? '', parameters: schema });
  }
  return { specs, toMcpName };
}

function systemPrompt(serverLabel: string, toolNames: string[]): string {
  return [
    `You are an assistant connected to a Salesforce Hosted MCP server ("${serverLabel}") on behalf of the current user.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    ``,
    `You can call these Salesforce tools: ${toolNames.join(', ')}.`,
    ``,
    `Guidelines:`,
    `- Prefer read tools and precise SOQL (select only needed fields, always use LIMIT).`,
    `- For any write/delete, briefly state what you're about to change and why before calling the tool.`,
    `- If a tool errors, read the message and adjust rather than blindly retrying.`,
    `- Report record IDs and links plainly. Don't invent fields, objects, or data.`,
  ].join('\n');
}

async function confirm(rl: ReturnType<typeof createInterface>, question: string): Promise<boolean> {
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

export async function runChat(
  initialSession: ConnectResult,
  serverLabel: string,
  opts: ChatOptions = {},
): Promise<void> {
  const rp = resolveProvider(opts);
  let session = initialSession;

  const { tools } = await session.client.listTools();
  const { specs, toMcpName } = buildToolMap(tools);
  const system = systemPrompt(serverLabel, specs.map((s) => s.name));
  const backend: ChatBackend = createBackend(rp, system, specs);

  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`\nChat — ${serverLabel} · ${backend.label} · ${specs.length} tools`);
  console.log('Type your question. Commands: /reset, /tools, /quit\n');

  // Call an MCP tool, transparently re-authorizing once if the session expired.
  const callTool = async (mcpName: string, input: unknown): Promise<string> => {
    const doCall = () =>
      session.client.callTool({ name: mcpName, arguments: (input ?? {}) as Record<string, unknown> });
    try {
      return summarizeToolResult(await doCall());
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      console.error('\nSession expired — re-authorizing…');
      session = await session.reconnect();
      return summarizeToolResult(await doCall());
    }
  };

  const runToolCalls = async (calls: PendingToolCall[]): Promise<ToolOutcome[]> => {
    const outcomes: ToolOutcome[] = [];
    for (const call of calls) {
      const mcpName = toMcpName.get(call.name) ?? call.name;
      const argStr = JSON.stringify(call.input ?? {});
      console.log(`\n⚙  ${mcpName}(${argStr.length > 200 ? argStr.slice(0, 200) + '…' : argStr})`);

      const needsConfirm = !opts.autoApprove && (opts.confirmAll || WRITE_HINT.test(mcpName));
      if (needsConfirm && !(await confirm(rl, `   run ${mcpName}?`))) {
        outcomes.push({ id: call.id, content: 'User declined to run this tool.', isError: true });
        continue;
      }
      try {
        const out = await callTool(mcpName, call.input);
        console.log(`   ↳ ${out.split('\n')[0].slice(0, 160)}${out.length > 160 ? '…' : ''}`);
        outcomes.push({ id: call.id, content: out });
      } catch (err) {
        const msg = (err as Error).message;
        console.log(`   ↳ error: ${msg}`);
        outcomes.push({ id: call.id, content: `Error: ${msg}`, isError: true });
      }
    }
    return outcomes;
  };

  try {
    for (;;) {
      const line = (await rl.question('you> ')).trim();
      if (!line) continue;
      if (line === '/quit' || line === '/exit') break;
      if (line === '/reset') {
        backend.reset();
        console.log('(context cleared)\n');
        continue;
      }
      if (line === '/tools') {
        for (const s of specs) console.log(`  ${s.name}${s.description ? ` — ${s.description}` : ''}`);
        console.log();
        continue;
      }

      let pending = await backend.turn({ userText: line }, (d) => process.stdout.write(d));
      process.stdout.write('\n');

      let iterations = 0;
      while (pending.toolCalls.length) {
        if (++iterations > MAX_TOOL_ITERATIONS) {
          console.log('\n[stopped: tool iteration limit reached]');
          break;
        }
        const outcomes = await runToolCalls(pending.toolCalls);
        pending = await backend.turn({ toolOutcomes: outcomes }, (d) => process.stdout.write(d));
        process.stdout.write('\n');
      }
      console.log();
    }
  } finally {
    rl.close();
  }
}
