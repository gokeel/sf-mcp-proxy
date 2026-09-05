import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthConfig } from './config.js';
import { FileTokenStore } from './tokenStore.js';

export type RedirectHandler = (authorizationUrl: URL) => void | Promise<void>;

/**
 * OAuthClientProvider for Salesforce Hosted MCP Servers.
 *
 * Salesforce External Client Apps do NOT support Dynamic Client Registration, so
 * client credentials are supplied statically from the ECA's Consumer Key (and,
 * only if the app requires it, the Consumer Secret). Everything else — PKCE,
 * RFC 9728 discovery, the token exchange and refresh — is handled by the SDK's
 * `auth()` routine, which drives the methods below.
 */
export class SalesforceOAuthProvider implements OAuthClientProvider {
  private readonly store: FileTokenStore;

  constructor(
    private readonly serverUrl: string,
    private readonly oauth: OAuthConfig,
    private readonly onRedirect: RedirectHandler,
  ) {
    this.store = new FileTokenStore(serverUrl);
  }

  get redirectUrl(): string {
    return this.oauth.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Salesforce MCP CLI',
      redirect_uris: [this.oauth.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: this.oauth.scopes,
      token_endpoint_auth_method: this.oauth.consumerSecret ? 'client_secret_post' : 'none',
    };
  }

  clientInformation(): OAuthClientInformation | OAuthClientInformationFull | undefined {
    const stored = this.store.read().clientInformation;
    if (stored) return stored;
    return {
      client_id: this.oauth.consumerKey,
      ...(this.oauth.consumerSecret ? { client_secret: this.oauth.consumerSecret } : {}),
    };
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.store.patch({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    // Success — the one-time PKCE/state material is no longer needed.
    this.store.patch({ tokens, codeVerifier: undefined, state: undefined });
  }

  state(): string {
    const value = randomBytes(32).toString('base64url');
    this.store.patch({ state: value });
    return value;
  }

  /** The `state` value the SDK generated for the current in-flight request. */
  currentState(): string | undefined {
    return this.store.read().state;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.patch({ codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.store.read().codeVerifier;
    if (!verifier) throw new Error('No PKCE code verifier saved — restart the login flow.');
    return verifier;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.onRedirect(authorizationUrl);
  }

  /**
   * When SF_AUTH_SERVER_URL is set (e.g. a My Domain host), bypass RFC 9728 /
   * RFC 8414 discovery and hand the SDK a hand-built authorization server config.
   * Otherwise return undefined so the SDK discovers everything itself — which
   * works for the default `login.salesforce.com` authorization server.
   */
  discoveryState(): OAuthDiscoveryState | undefined {
    const base = this.oauth.authServerUrl;
    if (!base) return undefined;
    return {
      authorizationServerUrl: base,
      authorizationServerMetadata: {
        issuer: base,
        authorization_endpoint: `${base}/services/oauth2/authorize`,
        token_endpoint: `${base}/services/oauth2/token`,
        revocation_endpoint: `${base}/services/oauth2/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      },
      resourceMetadata: {
        resource: this.serverUrl,
        authorization_servers: [base],
        scopes_supported: this.oauth.scopes.split(' '),
      },
    };
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') {
      this.store.clear();
      return;
    }
    if (scope === 'tokens') this.store.patch({ tokens: undefined });
    if (scope === 'client') this.store.patch({ clientInformation: undefined });
    if (scope === 'verifier') this.store.patch({ codeVerifier: undefined, state: undefined });
  }

  /** Convenience for the `logout` command. */
  clearAll(): void {
    this.store.clear();
  }

  get storePath(): string {
    return this.store.filePath;
  }
}
