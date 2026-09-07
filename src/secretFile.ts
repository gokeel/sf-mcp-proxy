import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STORE_DIR = join(homedir(), '.sf-mcp-proxy');

interface EncryptedEnvelope {
  enc: 'scrypt-aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function passphrase(): string | undefined {
  return process.env.SF_TOKEN_PASSPHRASE?.trim() || undefined;
}

function encrypt(plaintext: string, pass: string): EncryptedEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    enc: 'scrypt-aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(env: EncryptedEnvelope, pass: string): string {
  const key = scryptSync(pass, Buffer.from(env.salt, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * A small JSON file under ~/.sf-mcp-proxy, mode 0600 (dir 0700). If SF_TOKEN_PASSPHRASE
 * is set, contents are AES-256-GCM encrypted (key derived via scrypt) — used for
 * both the Salesforce OAuth session cache and the proxy's own OAuth server state.
 */
export class SecretFile<T> {
  constructor(
    private readonly path: string,
    private readonly empty: () => T,
  ) {}

  read(): T {
    if (!existsSync(this.path)) return this.empty();
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as T | EncryptedEnvelope;
      if ((raw as EncryptedEnvelope).enc === 'scrypt-aes-256-gcm') {
        const pass = passphrase();
        if (!pass) throw new Error('file is encrypted but SF_TOKEN_PASSPHRASE is not set');
        return JSON.parse(decrypt(raw as EncryptedEnvelope, pass)) as T;
      }
      return raw as T;
    } catch (err) {
      if ((err as Error).message.includes('SF_TOKEN_PASSPHRASE')) throw err;
      // Corrupt / wrong passphrase — treat as empty; callers re-derive/re-auth.
      return this.empty();
    }
  }

  write(value: T): void {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
    const pass = passphrase();
    const json = JSON.stringify(value, null, 2);
    const body = pass ? JSON.stringify(encrypt(json, pass), null, 2) : json;
    writeFileSync(this.path, body, { mode: 0o600 });
  }

  get filePath(): string {
    return this.path;
  }
}
