/** Decode a JWT payload without verifying its signature (display only). */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

const CLAIM_LABELS: Record<string, string> = {
  sub: 'Subject',
  client_id: 'Client ID',
  scp: 'Scopes',
  scope: 'Scopes',
  aud: 'Audience',
  iss: 'Issuer',
  exp: 'Expires',
  iat: 'Issued',
  sfoid: 'Org ID',
  sfuid: 'User ID',
  username: 'Username',
  email: 'Email',
};

/** Human-readable lines for the interesting claims in a Salesforce access token. */
export function describeToken(token: string): string {
  const payload = decodeJwtPayload(token);
  if (!payload) return 'Access token is opaque (not a JWT) — no claims to show.';

  const lines: string[] = [];
  for (const [key, label] of Object.entries(CLAIM_LABELS)) {
    if (!(key in payload)) continue;
    let value = payload[key];
    if ((key === 'exp' || key === 'iat') && typeof value === 'number') {
      value = new Date(value * 1000).toISOString();
    }
    if (Array.isArray(value)) value = value.join(' ');
    lines.push(`  ${label.padEnd(12)} ${String(value)}`);
  }
  const shown = new Set(Object.keys(CLAIM_LABELS));
  const extra = Object.keys(payload).filter((k) => !shown.has(k));
  if (extra.length) lines.push(`  ${'Other'.padEnd(12)} ${extra.join(', ')}`);
  return lines.join('\n') || '  (no recognizable claims)';
}
