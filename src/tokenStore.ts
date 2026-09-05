import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { SecretFile, STORE_DIR } from './secretFile.js';

/** Everything we persist between CLI invocations for a single MCP server. */
export interface StoredSession {
  serverUrl: string;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationFull;
  /** OAuth `state` for the in-flight authorization request. */
  state?: string;
}

function fileFor(serverUrl: string): string {
  const hash = createHash('sha256').update(serverUrl).digest('hex').slice(0, 32);
  return join(STORE_DIR, `${hash}.json`);
}

/**
 * File-backed store for one MCP server's OAuth session.
 * Directory is created 0700, files written 0600. If SF_TOKEN_PASSPHRASE is set,
 * the file contents are AES-256-GCM encrypted (key derived via scrypt).
 */
export class FileTokenStore {
  private readonly file: SecretFile<StoredSession>;
  private readonly path: string;

  constructor(private readonly serverUrl: string) {
    this.path = fileFor(serverUrl);
    this.file = new SecretFile(this.path, () => ({ serverUrl }));
  }

  read(): StoredSession {
    return { ...this.file.read(), serverUrl: this.serverUrl };
  }

  patch(partial: Partial<StoredSession>): void {
    this.file.write({ ...this.read(), ...partial, serverUrl: this.serverUrl });
  }

  clear(): void {
    if (existsSync(this.path)) rmSync(this.path);
  }

  get filePath(): string {
    return this.path;
  }
}
