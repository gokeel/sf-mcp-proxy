#!/usr/bin/env node
import { Command } from 'commander';
import type { SfEnv } from './config.js';
import { loadOAuthConfig, loadServers, pickServerUrl, resolveServerUrl } from './config.js';
import { connect, formatToolResult } from './mcpClient.js';
import { runRepl } from './repl.js';
import { runChat } from './chat.js';
import { runProxy } from './proxy.js';
import { ProxyOAuth } from './proxyOAuth.js';
import { describeToken } from './identity.js';
import { SalesforceOAuthProvider } from './oauthProvider.js';

const program = new Command();

program
  .name('tarsius-mcp')
  .description('Interactive MCP client for Salesforce Hosted MCP Servers (OAuth 2.0 Auth Code + PKCE)')
  .version('0.1.0');

function envOpt(v?: string): SfEnv | undefined {
  if (!v) return undefined;
  if (v !== 'platform' && v !== 'sandbox') throw new Error('--env must be "platform" or "sandbox"');
  return v;
}

const serverOption = ['-s, --server <name|url>', 'server name from servers.json, or a full server URL'] as const;
const envOption = ['-e, --env <tier>', 'override org tier: platform | sandbox'] as const;

program
  .command('servers')
  .description('list configured servers and their resolved URLs')
  .action(() => {
    for (const s of loadServers()) {
      const url = s.url ?? resolveServerUrl(s.name, s.env ?? 'platform', s.group ?? 'platform');
      console.log(`  ${s.name.padEnd(20)} ${url}`);
      if (s.description) console.log(`  ${' '.repeat(20)} ${s.description}`);
    }
  });

program
  .command('login')
  .description('run the OAuth flow and cache tokens for a server')
  .option(...serverOption)
  .option(...envOption)
  .action(async (opts) => {
    const { name, env, url } = pickServerUrl(opts.server, envOpt(opts.env));
    console.log(`Authorizing ${name} (${env})\n  ${url}`);
    const { client, close, provider } = await connect(url, { interactive: true });
    try {
      const { tools } = await client.listTools();
      console.log(`\n✓ Authorized. Tokens cached at ${provider.storePath}`);
      console.log(`  ${tools.length} tool(s) available.`);
    } finally {
      await close();
    }
  });

program
  .command('logout')
  .description('delete cached tokens for a server')
  .option(...serverOption)
  .option(...envOption)
  .action((opts) => {
    const { name, env, url } = pickServerUrl(opts.server, envOpt(opts.env));
    const provider = new SalesforceOAuthProvider(url, loadOAuthConfig(), () => {});
    provider.clearAll();
    console.log(`Cleared cached credentials for ${name} (${env}).`);
  });

program
  .command('whoami')
  .description('show the identity claims in the cached access token for a server')
  .option(...serverOption)
  .option(...envOption)
  .action((opts) => {
    const { name, env, url } = pickServerUrl(opts.server, envOpt(opts.env));
    const provider = new SalesforceOAuthProvider(url, loadOAuthConfig(), () => {});
    const token = provider.tokens()?.access_token;
    if (!token) {
      console.log(`No cached token for ${name} (${env}). Run \`tarsius-mcp login -s ${name}\`.`);
      return;
    }
    console.log(`${name} (${env})`);
    console.log(describeToken(token));
  });

program
  .command('tools')
  .description('list tools exposed by a server')
  .option(...serverOption)
  .option(...envOption)
  .option('--json', 'print the raw tool definitions as JSON')
  .action(async (opts) => {
    const { url } = pickServerUrl(opts.server, envOpt(opts.env));
    const { client, close } = await connect(url, { interactive: true });
    try {
      const { tools } = await client.listTools();
      if (opts.json) {
        console.log(JSON.stringify(tools, null, 2));
      } else {
        for (const t of tools) console.log(`  ${t.name}${t.description ? ` — ${t.description}` : ''}`);
        if (!tools.length) console.log('  (none)');
      }
    } finally {
      await close();
    }
  });

program
  .command('toolspec')
  .description('print a toolspec.json ({ "tools": [...] }) for static registries (e.g. Gemini Enterprise Agent Registry)')
  .option(...serverOption)
  .option(...envOption)
  .action(async (opts) => {
    const { url } = pickServerUrl(opts.server, envOpt(opts.env));
    const { client, close } = await connect(url, { interactive: true });
    try {
      const { tools } = await client.listTools();
      const json = JSON.stringify({ tools }, null, 2);
      console.log(json);
      const bytes = Buffer.byteLength(json, 'utf8');
      if (bytes > 10_000) {
        console.error(`\n⚠ ${bytes} bytes — over the 10 KB limit some registries enforce. Trim tool descriptions or split servers.`);
      }
    } finally {
      await close();
    }
  });

program
  .command('call <tool>')
  .description('call a single tool and print the result')
  .option(...serverOption)
  .option(...envOption)
  .option('-a, --args <json>', 'tool arguments as a JSON object', '{}')
  .option('--json', 'print the raw CallToolResult as JSON')
  .action(async (tool, opts) => {
    const { url } = pickServerUrl(opts.server, envOpt(opts.env));
    let args: unknown;
    try {
      args = JSON.parse(opts.args);
    } catch {
      throw new Error(`--args is not valid JSON: ${opts.args}`);
    }
    const { client, close } = await connect(url, { interactive: true });
    try {
      const result = await client.callTool({ name: tool, arguments: args as Record<string, unknown> });
      console.log(opts.json ? JSON.stringify(result, null, 2) : formatToolResult(result));
    } finally {
      await close();
    }
  });

program
  .command('repl')
  .description('interactive session against a server')
  .option(...serverOption)
  .option(...envOption)
  .action(async (opts) => {
    const { name, env, url } = pickServerUrl(opts.server, envOpt(opts.env));
    const session = await connect(url, { interactive: true });
    try {
      await runRepl(session.client, `${name} (${env})`);
    } finally {
      await session.close();
    }
  });

program
  .command('chat')
  .description('natural-language chat with an LLM that can call the server\'s tools')
  .option(...serverOption)
  .option(...envOption)
  .option(
    '-p, --provider <name>',
    'anthropic | openai | deepseek | kimi | qwen | openrouter | custom (default: $SFCHAT_PROVIDER, or anthropic if ANTHROPIC_API_KEY is set)',
  )
  .option('-m, --model <id>', 'model id (default: the provider preset, or $SFCHAT_MODEL)')
  .option('--base-url <url>', 'override the provider base URL (or $SFCHAT_BASE_URL)')
  .option('-y, --yes', 'auto-approve every tool call')
  .option('--confirm-all', 'prompt before every tool call, not just likely writes')
  .action(async (opts) => {
    const { name, env, url } = pickServerUrl(opts.server, envOpt(opts.env));
    const session = await connect(url, { interactive: true });
    try {
      await runChat(session, `${name} (${env})`, {
        provider: opts.provider,
        model: opts.model,
        baseUrl: opts.baseUrl,
        autoApprove: opts.yes,
        confirmAll: opts.confirmAll,
      });
    } finally {
      await session.close();
    }
  });

program
  .command('proxy')
  .description('expose one Salesforce MCP server to other MCP clients (stdio, or local Streamable HTTP)')
  .option(...serverOption)
  .option(...envOption)
  .option('--http', 'serve Streamable HTTP instead of stdio')
  .option('--host <addr>', 'HTTP bind address (default 127.0.0.1)', '127.0.0.1')
  .option('--port <n>', 'HTTP port (default 9000)', (v) => Number.parseInt(v, 10), 9000)
  .option('--auth-token <token>', 'require this static bearer token from downstream HTTP clients')
  .option(
    '--oauth',
    'run a full OAuth 2.0 authorization server in front of /mcp instead (dynamic client registration + PKCE + a human approval per client) — mutually exclusive with --auth-token',
  )
  .option('--public-url <url>', 'externally-reachable base URL to advertise in OAuth metadata (default http://host:port, e.g. behind a TLS reverse proxy)')
  .option('--no-login', 'never open a browser; fail if there is no cached token')
  .action(async (opts) => {
    const { name, env, url } = pickServerUrl(opts.server, envOpt(opts.env));
    await runProxy(url, {
      http: opts.http,
      host: opts.host,
      port: opts.port,
      authToken: opts.authToken,
      oauth: opts.oauth,
      publicUrl: opts.publicUrl,
      serverLabel: `${name} (${env})`,
      noLogin: opts.login === false,
    });
  });

program
  .command('oauth-clients')
  .description('manage clients registered against the proxy\'s own OAuth server (see `proxy --oauth`)')
  .option(...serverOption)
  .option(...envOption)
  .option('--revoke <clientId>', 'revoke one client (and its tokens) instead of listing')
  .action((opts) => {
    const { name, env, url } = pickServerUrl(opts.server, envOpt(opts.env));
    const oauth = new ProxyOAuth('http://unused', url, `${name} (${env})`);
    if (opts.revoke) {
      console.log(oauth.revokeClient(opts.revoke) ? `Revoked ${opts.revoke}.` : `No such client: ${opts.revoke}`);
      return;
    }
    const clients = oauth.listClients();
    if (!clients.length) {
      console.log(`No OAuth clients registered for ${name} (${env}).`);
      return;
    }
    for (const c of clients) {
      console.log(`  ${c.client_id}  ${c.client_name ?? '(unnamed)'}  registered ${new Date(c.created_at).toISOString()}`);
      console.log(`    redirect_uris: ${c.redirect_uris.join(', ')}`);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
});
