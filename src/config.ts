import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// Resolve config files (.env, servers.json) next to the package, not relative to
// process.cwd() — an MCP client (Hermes, Claude Desktop, …) spawns `sf-mcp-proxy` with
// an arbitrary working directory, so cwd-relative lookups silently find nothing.
// This file lives at <project>/src/config.ts or <project>/dist/config.js — either
// way its parent's parent is the project root.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

loadEnv({ path: join(PKG_ROOT, '.env') });

export type SfEnv = 'platform' | 'sandbox';

export interface ServerEntry {
  /** Short server name, e.g. "sobject-reads". */
  name: string;
  /**
   * Full server URL copied from Salesforce Setup, e.g.
   * https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-reads
   * When present it is used verbatim and `env` / `group` are ignored.
   */
  url?: string;
  /** Org tier when building the URL from `name`. Defaults to SF_ENV. */
  env?: SfEnv;
  /** Path segment between the tier and the server name. Defaults to "platform". */
  group?: string;
  description?: string;
}

export interface OAuthConfig {
  consumerKey: string;
  consumerSecret?: string;
  redirectUri: string;
  callbackPort: number;
  /** Space-delimited OAuth scopes required by Salesforce Hosted MCP. */
  scopes: string;
  /** Fallback authorization server base URL if RFC 9728 discovery fails. */
  loginUrl: string;
  /**
   * Optional hard override for the OAuth authorization server (e.g. a My Domain
   * URL like https://acme.my.salesforce.com). When set, discovery is bypassed and
   * the endpoints below it are used directly.
   */
  authServerUrl?: string;
}

const DEFAULT_SERVERS: ServerEntry[] = [
  { name: 'sobject-reads', description: 'Read Salesforce records (SOQL, get by id)' },
  { name: 'sobject-all', description: 'Full CRUD on Salesforce records' },
  { name: 'sobject-mutations', description: 'Create / update Salesforce records' },
  { name: 'sobject-deletes', description: 'Delete Salesforce records' },
  { name: 'invocable-actions', description: 'Run invocable Apex / standard actions' },
  { name: 'flows', description: 'Discover and run Flows' },
  { name: 'api-catalog', description: 'Browse the org API catalog' },
  { name: 'data-360', description: 'Data Cloud (Data 360)' },
  { name: 'prompt-builder', description: 'Run Prompt Builder templates' },
  { name: 'tableau-next', description: 'Tableau Next' },
];

const API_BASE = 'https://api.salesforce.com/platform/mcp/v1';
const DEFAULT_GROUP = 'platform';

function defaultEnv(): SfEnv {
  const v = (process.env.SF_ENV ?? 'platform').toLowerCase();
  return v === 'sandbox' ? 'sandbox' : 'platform';
}

/**
 * Build the Salesforce Hosted MCP server URL from its short name.
 *
 * Shape (verified against Salesforce Setup):
 *   production : {API_BASE}/{group}/{name}
 *   sandbox    : {API_BASE}/sandbox/{group}/{name}
 *
 * The exact URL is shown in Setup → MCP servers; prefer copying it into
 * `servers.json` as `url` rather than relying on this builder.
 */
export function resolveServerUrl(
  name: string,
  env: SfEnv = defaultEnv(),
  group: string = DEFAULT_GROUP,
): string {
  const prefix = env === 'sandbox' ? `${API_BASE}/sandbox` : API_BASE;
  return `${prefix}/${group}/${name}`;
}

/** Infer the org tier from a full server URL (used for display only). */
export function envFromUrl(url: string): SfEnv {
  return /\/mcp\/v1\/sandbox\//.test(url) ? 'sandbox' : 'platform';
}

/** Load the configured server list from servers.json, falling back to defaults. */
export function loadServers(): ServerEntry[] {
  const path = join(PKG_ROOT, 'servers.json');
  if (!existsSync(path)) return DEFAULT_SERVERS.map((s) => ({ ...s, env: defaultEnv() }));

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse servers.json: ${(err as Error).message}`);
  }

  const list = (parsed as { servers?: unknown }).servers;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('servers.json must contain a non-empty "servers" array');
  }

  return list.map((raw, i) => {
    const entry = raw as ServerEntry;
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error(`servers.json entry #${i + 1} is missing a "name"`);
    }
    if (entry.url !== undefined && !/^https?:\/\//.test(entry.url)) {
      throw new Error(`servers.json entry "${entry.name}" has an invalid "url"`);
    }
    return {
      name: entry.name.trim(),
      url: entry.url?.trim(),
      env: entry.env === 'sandbox' ? 'sandbox' : entry.env === 'platform' ? 'platform' : defaultEnv(),
      group: entry.group?.trim() || DEFAULT_GROUP,
      description: entry.description,
    };
  });
}

/**
 * Resolve a `--server` option to a full URL. The option may be:
 *   - a full `http(s)://…` URL (used verbatim)
 *   - a name present in servers.json
 *   - a bare server name (URL built from it + --env)
 * If omitted and exactly one server is configured, that one is used.
 */
export function pickServerUrl(
  server: string | undefined,
  envOverride: SfEnv | undefined,
): { name: string; env: SfEnv; url: string } {
  if (server && /^https?:\/\//.test(server)) {
    return { name: server.split('/').pop() || server, env: envFromUrl(server), url: server };
  }

  const servers = loadServers();

  let entry: ServerEntry | undefined;
  if (server) {
    entry = servers.find((s) => s.name === server) ?? { name: server, env: defaultEnv() };
  } else if (servers.length === 1) {
    entry = servers[0];
  } else {
    throw new Error(
      `Multiple servers configured — pass --server <name>. Configured: ${servers.map((s) => s.name).join(', ')}`,
    );
  }

  if (entry.url) {
    return { name: entry.name, env: envFromUrl(entry.url), url: entry.url };
  }

  const env = envOverride ?? entry.env ?? defaultEnv();
  return { name: entry.name, env, url: resolveServerUrl(entry.name, env, entry.group ?? DEFAULT_GROUP) };
}

export function loadOAuthConfig(): OAuthConfig {
  const consumerKey = process.env.SF_CONSUMER_KEY?.trim();
  if (!consumerKey) {
    throw new Error(
      'SF_CONSUMER_KEY is not set. Copy .env.example to .env and paste your External Client App Consumer Key.',
    );
  }

  const callbackPort = Number.parseInt(process.env.OAUTH_CALLBACK_PORT ?? '8000', 10);
  if (!Number.isInteger(callbackPort) || callbackPort <= 0) {
    throw new Error(`OAUTH_CALLBACK_PORT must be a positive integer (got "${process.env.OAUTH_CALLBACK_PORT}")`);
  }

  const redirectUri = process.env.OAUTH_REDIRECT_URI?.trim() || `http://localhost:${callbackPort}/callback`;

  return {
    consumerKey,
    consumerSecret: process.env.SF_CONSUMER_SECRET?.trim() || undefined,
    redirectUri,
    callbackPort,
    scopes: 'mcp_api refresh_token',
    loginUrl: process.env.SF_LOGIN_URL?.trim() || 'https://login.salesforce.com',
    authServerUrl: process.env.SF_AUTH_SERVER_URL?.trim()?.replace(/\/+$/, '') || undefined,
  };
}
