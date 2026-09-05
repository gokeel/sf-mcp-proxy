import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeJwtPayload, describeToken } from '../src/identity.ts';

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

test('decodeJwtPayload returns the payload claims', () => {
  const token = makeJwt({ sub: 'user@example.com', scp: ['mcp_api', 'refresh_token'] });
  assert.deepEqual(decodeJwtPayload(token), { sub: 'user@example.com', scp: ['mcp_api', 'refresh_token'] });
});

test('decodeJwtPayload returns undefined for a non-JWT string', () => {
  assert.equal(decodeJwtPayload('00Dxx0000001234!opaque.token'), undefined);
});

test('describeToken renders known claims and formats timestamps', () => {
  const token = makeJwt({ sub: 'abc', exp: 1_700_000_000, scp: ['mcp_api'] });
  const out = describeToken(token);
  assert.match(out, /Subject {6}abc/);
  assert.match(out, /Scopes {7}mcp_api/);
  assert.match(out, /Expires {6}2023-11-14/);
});

test('describeToken handles opaque tokens', () => {
  assert.match(describeToken('not-a-jwt'), /opaque/);
});
