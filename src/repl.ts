import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { formatToolResult } from './mcpClient.js';

const HELP = `Commands:
  tools                       list available tools
  schema <tool>               print a tool's JSON input schema
  call <tool> [json-args]     call a tool (args default to {})
  resources                   list resources
  read <uri>                  read a resource
  prompts                     list prompts
  help                        show this help
  quit / exit                 leave`;

/** Split "call myTool {\"a\":1}" into ["call", "myTool", "{\"a\":1}"]. */
function tokenize(line: string): [string, string, string] {
  const trimmed = line.trim();
  const sp1 = trimmed.indexOf(' ');
  if (sp1 === -1) return [trimmed, '', ''];
  const cmd = trimmed.slice(0, sp1);
  const rest = trimmed.slice(sp1 + 1).trim();
  const sp2 = rest.indexOf(' ');
  if (sp2 === -1) return [cmd, rest, ''];
  return [cmd, rest.slice(0, sp2), rest.slice(sp2 + 1).trim()];
}

export async function runRepl(client: Client, serverLabel: string): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const version = client.getServerVersion();
  console.log(`\nConnected to ${serverLabel}${version ? ` (${version.name} ${version.version})` : ''}`);
  console.log(HELP + '\n');

  try {
    for (;;) {
      const line = (await rl.question('sf-mcp-proxy> ')).trim();
      if (!line) continue;
      const [cmd, arg, rest] = tokenize(line);

      try {
        if (cmd === 'quit' || cmd === 'exit') break;
        else if (cmd === 'help') console.log(HELP);
        else if (cmd === 'tools') {
          const { tools } = await client.listTools();
          for (const t of tools) console.log(`  ${t.name}${t.description ? ` — ${t.description}` : ''}`);
          if (!tools.length) console.log('  (none)');
        } else if (cmd === 'schema') {
          const { tools } = await client.listTools();
          const tool = tools.find((t) => t.name === arg);
          console.log(tool ? JSON.stringify(tool.inputSchema, null, 2) : `unknown tool: ${arg}`);
        } else if (cmd === 'call') {
          if (!arg) {
            console.log('usage: call <tool> [json-args]');
            continue;
          }
          const args = rest ? JSON.parse(rest) : {};
          const result = await client.callTool({ name: arg, arguments: args });
          console.log(formatToolResult(result));
        } else if (cmd === 'resources') {
          const { resources } = await client.listResources();
          for (const r of resources) console.log(`  ${r.uri}${r.name ? ` (${r.name})` : ''}`);
          if (!resources.length) console.log('  (none)');
        } else if (cmd === 'read') {
          if (!arg) {
            console.log('usage: read <uri>');
            continue;
          }
          const res = await client.readResource({ uri: arg });
          console.log(JSON.stringify(res.contents, null, 2));
        } else if (cmd === 'prompts') {
          const { prompts } = await client.listPrompts();
          for (const p of prompts) console.log(`  ${p.name}${p.description ? ` — ${p.description}` : ''}`);
          if (!prompts.length) console.log('  (none)');
        } else {
          console.log(`unknown command: ${cmd} (try "help")`);
        }
      } catch (err) {
        console.error(`error: ${(err as Error).message}`);
      }
    }
  } finally {
    rl.close();
  }
}
