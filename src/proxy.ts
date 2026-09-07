import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';
import { connect, type ConnectResult } from './mcpClient.js';
import { ProxyOAuth } from './proxyOAuth.js';

const PROXY_INFO = { name: 'sf-mcp-proxy', version: '0.1.0' };

export interface ProxyOptions {
  http?: boolean;
  host?: string;
  port?: number;
  /** Require `Authorization: Bearer <token>` from downstream clients (HTTP only). */
  authToken?: string;
  /**
   * Run a full OAuth 2.0 authorization server in front of /mcp (DCR + Auth
   * Code + PKCE, one human approval per /authorize request) instead of a
   * static bearer token. Mutually exclusive with `authToken`.
   */
  oauth?: boolean;
  /** Externally-reachable base URL to advertise in OAuth metadata/links, if different from http://host:port (e.g. behind a TLS reverse proxy). */
  publicUrl?: string;
  /** Human-readable label for the upstream server, shown on the consent page. */
  serverLabel?: string;
  /** Don't run the browser OAuth flow; fail if there's no cached token. */
  noLogin?: boolean;
}

/** Downstream MCP servers currently connected (for fanning out upstream notifications). */
type ServerSet = Set<Server>;

function buildProxyServer(upstream: ConnectResult, servers: ServerSet): Server {
  const server = new Server(PROXY_INFO, {
    capabilities: upstream.client.getServerCapabilities() ?? {},
    instructions:
      `Proxy to a Salesforce Hosted MCP server (${upstream.serverUrl}). ` +
      `All calls run as the Salesforce user who authorized this proxy.`,
  });

  // Forward every request (tools/list, tools/call, resources/*, prompts/*, …) upstream.
  server.fallbackRequestHandler = async (request, extra) =>
    upstream.client.request(
      { method: request.method, params: request.params },
      ResultSchema,
      { signal: extra.signal },
    );

  // Forward downstream notifications (e.g. cancellations) upstream.
  server.fallbackNotificationHandler = async (notification) => {
    await upstream.client.notification(notification as Notification);
  };

  server.onclose = () => servers.delete(server);
  servers.add(server);
  return server;
}

async function connectUpstream(serverUrl: string, opts: ProxyOptions, servers: ServerSet): Promise<ConnectResult> {
  const upstream = await connect(serverUrl, { interactive: !opts.noLogin });
  // Fan out upstream notifications (tool-list changes, logging, …) to every downstream client.
  upstream.client.fallbackNotificationHandler = async (notification) => {
    for (const s of servers) await s.notification(notification as Notification).catch(() => {});
  };
  return upstream;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Run the proxy over stdio — the transport an agent spawns as a subprocess. */
async function runStdio(serverUrl: string, opts: ProxyOptions): Promise<void> {
  const servers: ServerSet = new Set();
  const upstream = await connectUpstream(serverUrl, opts, servers);
  const { tools } = await upstream.client.listTools().catch(() => ({ tools: [] as unknown[] }));
  console.error(`sf-mcp-proxy proxy (stdio) → ${serverUrl} · ${tools.length} tools`);

  const server = buildProxyServer(upstream, servers);
  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    await server.close().catch(() => {});
    await upstream.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Run the proxy as a Streamable HTTP endpoint at http://<host>:<port>/mcp. */
async function runHttp(serverUrl: string, opts: ProxyOptions): Promise<void> {
  if (opts.oauth && opts.authToken) {
    throw new Error('--oauth and --auth-token are mutually exclusive — pick one.');
  }
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 9000;
  const publicUrl = (opts.publicUrl ?? `http://${host}:${port}`).replace(/\/+$/, '');
  const servers: ServerSet = new Set();
  const upstream = await connectUpstream(serverUrl, opts, servers);
  const { tools } = await upstream.client.listTools().catch(() => ({ tools: [] as unknown[] }));

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const oauth = opts.oauth ? new ProxyOAuth(publicUrl, serverUrl, opts.serverLabel ?? serverUrl) : undefined;

  const authorized = (req: IncomingMessage): boolean => {
    if (oauth) return oauth.authenticate(req);
    return !opts.authToken || req.headers.authorization === `Bearer ${opts.authToken}`;
  };

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    if (oauth && (await oauth.handle(req, res, url))) return;
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end('Not found');
      return;
    }
    if (!authorized(req)) {
      const challenge = oauth
        ? `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`
        : 'Bearer';
      res.writeHead(401, { 'WWW-Authenticate': challenge }).end('Unauthorized');
      return;
    }

    try {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      const existing = sid ? transports.get(sid) : undefined;
      const body = req.method === 'POST' ? await readBody(req) : undefined;

      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }

      const isInit =
        !!body && typeof body === 'object' && (body as { method?: string }).method === 'initialize';
      if (req.method !== 'POST' || !isInit) {
        res.writeHead(400).end('No valid session; send an initialize request first');
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = buildProxyServer(upstream, servers);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(`proxy error: ${(err as Error).message}`);
    }
  });

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  const remoteNote =
    host === '127.0.0.1' || host === 'localhost'
      ? '  localhost only — put a TLS reverse proxy in front for remote clients'
      : `  reachable on ${host}:${port}`;
  const authNote = oauth ? '  (OAuth 2.0 required)' : opts.authToken ? '  (Bearer token required)' : '';
  console.error(
    `sf-mcp-proxy proxy (http) → ${serverUrl} · ${tools.length} tools\n` +
      `  endpoint: ${publicUrl}/mcp${authNote}\n${remoteNote}`,
  );
  if (oauth) {
    console.error(
      `\nOAuth 2.0 (dynamic client registration + PKCE, one approval per client):\n` +
        `  discovery:    ${publicUrl}/.well-known/oauth-authorization-server\n` +
        `  authorize:    ${publicUrl}/authorize\n` +
        `  token:        ${publicUrl}/token\n` +
        `  register:     ${publicUrl}/register\n` +
        `A spec-compliant client (one that follows the MCP Authorization spec) discovers these on its\n` +
        `own from the 401 it gets hitting /mcp. A client that wants them typed in manually (e.g. Gemini\n` +
        `Enterprise's "Authorization URL" / "Token URL" fields) can use the authorize/token URLs above.\n` +
        `Every /authorize hit needs your approval — it renders an Approve/Deny page; open it in a browser.\n` +
        `Manage registered clients with \`sf-mcp-proxy oauth-clients list|revoke\`.`,
    );
  }

  const shutdown = async () => {
    http.close();
    for (const t of transports.values()) await t.close().catch(() => {});
    await upstream.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function runProxy(serverUrl: string, opts: ProxyOptions = {}): Promise<void> {
  if (opts.http) await runHttp(serverUrl, opts);
  else await runStdio(serverUrl, opts);
}
