import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { SecretFile, STORE_DIR } from './secretFile.js';

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post';
  created_at: number;
}

interface IssuedAccessToken {
  clientId: string;
  expiresAt: number;
}

interface IssuedRefreshToken {
  clientId: string;
}

export interface ProxyAuthState {
  clients: Record<string, RegisteredClient>;
  accessTokens: Record<string, IssuedAccessToken>;
  refreshTokens: Record<string, IssuedRefreshToken>;
}

function empty(): ProxyAuthState {
  return { clients: {}, accessTokens: {}, refreshTokens: {} };
}

/**
 * Persisted state for the proxy's own OAuth 2.0 authorization server: clients
 * registered via RFC 7591 dynamic registration, and the access/refresh tokens
 * issued to them. Scoped per upstream Salesforce server URL, one file under
 * ~/.sf-mcp-proxy (same encryption-at-rest support as the Salesforce token cache).
 */
export class ProxyAuthStore {
  private readonly file: SecretFile<ProxyAuthState>;

  constructor(resource: string) {
    const hash = createHash('sha256').update(resource).digest('hex').slice(0, 32);
    this.file = new SecretFile(join(STORE_DIR, `oauth-${hash}.json`), empty);
  }

  private state(): ProxyAuthState {
    const s = this.file.read();
    return { clients: s.clients ?? {}, accessTokens: s.accessTokens ?? {}, refreshTokens: s.refreshTokens ?? {} };
  }

  private save(s: ProxyAuthState): void {
    this.file.write(s);
  }

  registerClient(input: {
    client_name?: string;
    redirect_uris: string[];
    token_endpoint_auth_method?: string;
  }): RegisteredClient {
    const s = this.state();
    const client_id = randomBytes(16).toString('hex');
    const wantsSecret = input.token_endpoint_auth_method !== 'none';
    const client: RegisteredClient = {
      client_id,
      client_secret: wantsSecret ? randomBytes(24).toString('base64url') : undefined,
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: wantsSecret ? 'client_secret_post' : 'none',
      created_at: Date.now(),
    };
    s.clients[client_id] = client;
    this.save(s);
    return client;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.state().clients[clientId];
  }

  listClients(): RegisteredClient[] {
    return Object.values(this.state().clients);
  }

  revokeClient(clientId: string): boolean {
    const s = this.state();
    if (!s.clients[clientId]) return false;
    delete s.clients[clientId];
    for (const [t, v] of Object.entries(s.accessTokens)) if (v.clientId === clientId) delete s.accessTokens[t];
    for (const [t, v] of Object.entries(s.refreshTokens)) if (v.clientId === clientId) delete s.refreshTokens[t];
    this.save(s);
    return true;
  }

  issueTokens(clientId: string, ttlSeconds: number): { accessToken: string; refreshToken: string; expiresIn: number } {
    const s = this.state();
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    s.accessTokens[accessToken] = { clientId, expiresAt: Date.now() + ttlSeconds * 1000 };
    s.refreshTokens[refreshToken] = { clientId };
    this.save(s);
    return { accessToken, refreshToken, expiresIn: ttlSeconds };
  }

  /** Rotates a refresh token; returns undefined if it's unknown (already used/revoked). */
  refresh(
    refreshToken: string,
    ttlSeconds: number,
  ): { accessToken: string; refreshToken: string; expiresIn: number } | undefined {
    const s = this.state();
    const rec = s.refreshTokens[refreshToken];
    if (!rec) return undefined;
    delete s.refreshTokens[refreshToken];
    const accessToken = randomBytes(32).toString('base64url');
    const newRefresh = randomBytes(32).toString('base64url');
    s.accessTokens[accessToken] = { clientId: rec.clientId, expiresAt: Date.now() + ttlSeconds * 1000 };
    s.refreshTokens[newRefresh] = { clientId: rec.clientId };
    this.save(s);
    return { accessToken, refreshToken: newRefresh, expiresIn: ttlSeconds };
  }

  validateAccessToken(token: string): { clientId: string } | undefined {
    const s = this.state();
    const rec = s.accessTokens[token];
    if (!rec) return undefined;
    if (rec.expiresAt < Date.now()) {
      delete s.accessTokens[token];
      this.save(s);
      return undefined;
    }
    return { clientId: rec.clientId };
  }
}
