import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProxyAuthStore } from './proxyAuthStore.js';

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  state?: string;
  expiresAt: number;
}

const CODE_TTL_MS = 60_000;
const TOKEN_TTL_SECONDS = 3600;

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseFormOrJson(raw: string, contentType: string | undefined): Record<string, string> {
  if (!raw) return {};
  if (contentType?.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string);
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorize</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:4rem auto;padding:0 1.25rem;color:#1a1a1a}
  button{padding:.6rem 1.3rem;margin-right:.6rem;font-size:1rem;border-radius:8px;border:1px solid #999;cursor:pointer;background:#fff}
  .approve{background:#2563eb;color:#fff;border-color:#2563eb}
  code{background:#f1f1f1;padding:.15rem .35rem;border-radius:4px;font-size:.9em}
  p{line-height:1.5}
</style></head><body>${body}</body></html>`;
}

/**
 * A minimal, spec-shaped OAuth 2.0 Authorization Server + Resource Server for
 * the proxy's own `/mcp` endpoint: RFC 9728 / RFC 8414 discovery, RFC 7591
 * Dynamic Client Registration, and Authorization Code + PKCE(S256) with a
 * human-approval gate on every `/authorize` request. Separate from — and
 * downstream of — the Salesforce OAuth the proxy already holds; this layer
 * only decides who may reach the proxy, not which Salesforce identity is used.
 */
export class ProxyOAuth {
  private readonly store: ProxyAuthStore;
  private readonly codes = new Map<string, PendingCode>();

  constructor(
    private readonly issuer: string,
    private readonly resource: string,
    private readonly serverLabel: string,
  ) {
    this.store = new ProxyAuthStore(resource);
  }

  listClients() {
    return this.store.listClients();
  }

  revokeClient(id: string): boolean {
    return this.store.revokeClient(id);
  }

  /** Bearer-token gate for the proxied /mcp endpoint. */
  authenticate(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return false;
    return !!this.store.validateAccessToken(header.slice('Bearer '.length));
  }

  /** Returns true if this request matched one of our routes and was handled. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      this.json(res, 200, {
        resource: this.resource,
        authorization_servers: [this.issuer],
        scopes_supported: ['mcp'],
      });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      this.json(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        registration_endpoint: `${this.issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      await this.register(req, res);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      this.renderAuthorize(res, url);
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/authorize/decision') {
      await this.decide(req, res);
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      await this.token(req, res);
      return true;
    }
    return false;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readRawBody(req);
    let body: Record<string, unknown>;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      this.json(res, 400, { error: 'invalid_client_metadata' });
      return;
    }
    const redirect_uris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
      : [];
    if (!redirect_uris.length) {
      this.json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
      return;
    }
    const client = this.store.registerClient({
      client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
      redirect_uris,
      token_endpoint_auth_method:
        typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'client_secret_post',
    });
    console.error(`\n📋 New OAuth client registered: "${client.client_name ?? '(unnamed)'}" (${client.client_id})`);
    this.json(res, 201, {
      client_id: client.client_id,
      client_secret: client.client_secret,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  private renderAuthorize(res: ServerResponse, url: URL): void {
    const p = url.searchParams;
    const client = this.store.getClient(p.get('client_id') ?? '');
    const redirectUri = p.get('redirect_uri') ?? '';

    if (!client || !client.redirect_uris.includes(redirectUri)) {
      res
        .writeHead(400, { 'content-type': 'text/html' })
        .end(
          page(
            '<h1>Invalid client</h1><p>Unknown <code>client_id</code> or a <code>redirect_uri</code> that was not registered. Register the client via <code>POST /register</code> first.</p>',
          ),
        );
      return;
    }
    if (p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) {
      res
        .writeHead(400, { 'content-type': 'text/html' })
        .end(page('<h1>Unsupported request</h1><p>Only <code>response_type=code</code> with PKCE (S256) is supported.</p>'));
      return;
    }

    const hidden = ['client_id', 'redirect_uri', 'code_challenge', 'state', 'scope']
      .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(p.get(k) ?? '')}">`)
      .join('\n');

    console.error(
      `\n🔐 Authorization requested by "${client.client_name ?? client.client_id}" — open ${this.issuer}/authorize in a browser to approve or deny.`,
    );

    res.writeHead(200, { 'content-type': 'text/html' }).end(
      page(`
        <h1>Authorize access</h1>
        <p><strong>${escapeHtml(client.client_name ?? client.client_id)}</strong> is requesting access to
        <strong>${escapeHtml(this.serverLabel)}</strong> through this proxy.</p>
        <p>Approving lets it call every tool on that Salesforce server, as the identity that
        authorized this proxy (<code>tarsius-mcp login</code>). Only approve clients you recognize.</p>
        <form method="post" action="/authorize/decision">
          ${hidden}
          <button class="approve" name="decision" value="approve">Approve</button>
          <button name="decision" value="deny">Deny</button>
        </form>`),
    );
  }

  private async decide(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readRawBody(req);
    const body = parseFormOrJson(raw, req.headers['content-type']);
    const client = this.store.getClient(body.client_id ?? '');
    const redirectUri = body.redirect_uri ?? '';

    if (!client || !client.redirect_uris.includes(redirectUri)) {
      res.writeHead(400, { 'content-type': 'text/html' }).end(page('<h1>Invalid request</h1>'));
      return;
    }

    const redirect = new URL(redirectUri);
    if (body.decision !== 'approve') {
      redirect.searchParams.set('error', 'access_denied');
      if (body.state) redirect.searchParams.set('state', body.state);
      console.error(`✗ Denied access for "${client.client_name ?? client.client_id}"`);
      res.writeHead(302, { location: redirect.toString() }).end();
      return;
    }

    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      clientId: client.client_id,
      redirectUri,
      codeChallenge: body.code_challenge ?? '',
      scope: body.scope,
      state: body.state,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    redirect.searchParams.set('code', code);
    if (body.state) redirect.searchParams.set('state', body.state);
    console.error(`✓ Approved access for "${client.client_name ?? client.client_id}"`);
    res.writeHead(302, { location: redirect.toString() }).end();
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readRawBody(req);
    const body = parseFormOrJson(raw, req.headers['content-type']);

    if (body.grant_type === 'authorization_code') {
      const code = body.code ?? '';
      const pending = this.codes.get(code);
      if (!pending || pending.expiresAt < Date.now()) {
        this.codes.delete(code);
        this.json(res, 400, { error: 'invalid_grant', error_description: 'unknown or expired code' });
        return;
      }
      this.codes.delete(code); // single use

      if (pending.redirectUri !== body.redirect_uri || pending.clientId !== body.client_id) {
        this.json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri/client_id mismatch' });
        return;
      }
      const client = this.store.getClient(pending.clientId);
      if (client?.client_secret && client.client_secret !== body.client_secret) {
        this.json(res, 401, { error: 'invalid_client' });
        return;
      }
      const verifier = body.code_verifier ?? '';
      const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : '';
      if (!verifier || challenge !== pending.codeChallenge) {
        this.json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      const tokens = this.store.issueTokens(pending.clientId, TOKEN_TTL_SECONDS);
      this.json(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        scope: pending.scope,
      });
      return;
    }

    if (body.grant_type === 'refresh_token') {
      const tokens = this.store.refresh(body.refresh_token ?? '', TOKEN_TTL_SECONDS);
      if (!tokens) {
        this.json(res, 400, { error: 'invalid_grant' });
        return;
      }
      this.json(res, 200, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
      });
      return;
    }

    this.json(res, 400, { error: 'unsupported_grant_type' });
  }
}
