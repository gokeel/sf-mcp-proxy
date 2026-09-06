import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import open from 'open';
import { loadOAuthConfig } from './config.js';
import { SalesforceOAuthProvider } from './oauthProvider.js';
import { waitForCallback } from './callbackServer.js';

export interface ConnectResult {
  client: Client;
  transport: StreamableHTTPClientTransport;
  provider: SalesforceOAuthProvider;
  serverUrl: string;
  close: () => Promise<void>;
  /** Tear down and connect again (re-running the browser OAuth flow if needed). */
  reconnect: () => Promise<ConnectResult>;
}

const CLIENT_INFO = { name: 'tarsius-mcp-cli', version: '0.1.0' };

export { UnauthorizedError };

/**
 * Connect to a Salesforce Hosted MCP server, running the interactive OAuth
 * (Authorization Code + PKCE) flow in the browser if we have no valid token.
 */
export interface ConnectOptions {
  interactive?: boolean;
}

export async function connect(serverUrl: string, opts: ConnectOptions = {}): Promise<ConnectResult> {
  const oauth = loadOAuthConfig();
  const interactive = opts.interactive ?? true;
  const callbackPath = new URL(oauth.redirectUri).pathname || '/callback';

  const provider = new SalesforceOAuthProvider(serverUrl, oauth, async (authUrl) => {
    if (!interactive) throw new UnauthorizedError('authorization required (non-interactive)');
    console.error('\nOpening browser for Salesforce authorization…');
    console.error(`If it does not open, visit:\n  ${authUrl.toString()}\n`);
    try {
      await open(authUrl.toString());
    } catch {
      /* headless / no browser — the URL was printed above */
    }
  });

  // In non-interactive mode, fail fast if there's nothing to authenticate with.
  if (!interactive) {
    const tok = provider.tokens();
    if (!tok?.access_token && !tok?.refresh_token) {
      throw new Error(
        `No cached token for ${serverUrl}. Run \`tarsius-mcp login\` for this server first (--no-login can't open a browser).`,
      );
    }
  }

  const build = () => new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });

  let transport = build();
  const client = new Client(CLIENT_INFO, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    if (!interactive) {
      throw new Error('Cached credentials are no longer valid. Run `tarsius-mcp login` for this server.');
    }

    const { code } = await waitForCallback(oauth.callbackPort, provider.currentState(), callbackPath);
    await transport.finishAuth(code);

    // finishAuth leaves the transport half-open; reconnect with a fresh one.
    transport = build();
    await client.connect(transport);
  }

  const close = async () => {
    await transport.close().catch(() => {});
  };

  return {
    client,
    transport,
    provider,
    serverUrl,
    close,
    reconnect: async () => {
      await close();
      return connect(serverUrl, opts);
    },
  };
}

/**
 * Run `fn`; if it fails because the session lost authorization (expired/revoked
 * refresh token), transparently re-authorize once and retry.
 */
export async function withReauth<T>(
  session: ConnectResult,
  fn: (client: Client) => Promise<T>,
): Promise<{ result: T; session: ConnectResult }> {
  try {
    return { result: await fn(session.client), session };
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err;
    console.error('\nSession expired — re-authorizing…');
    const next = await session.reconnect();
    return { result: await fn(next.client), session: next };
  }
}

/** Pretty-print a CallToolResult's content blocks. */
export function formatToolResult(result: unknown): string {
  const r = (result ?? {}) as {
    content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
    isError?: boolean;
    structuredContent?: unknown;
  };
  const lines: string[] = [];
  if (r.isError) lines.push('(tool reported an error)');
  for (const block of r.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') lines.push(block.text);
    else lines.push(JSON.stringify(block, null, 2));
  }
  if (r.structuredContent !== undefined) {
    lines.push('structuredContent: ' + JSON.stringify(r.structuredContent, null, 2));
  }
  return lines.join('\n') || '(no content)';
}

/** Compact one-line rendering of a tool result, for chat transcripts. */
export function summarizeToolResult(result: unknown, max = 4000): string {
  const text = formatToolResult(result);
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}
