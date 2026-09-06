import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProxyOAuth } from '../src/proxyOAuth.ts';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Wrap a fresh ProxyOAuth in a real HTTP server. */
async function harness() {
  const resource = `https://test.invalid/mcp/${randomUUID()}`;
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const issuer = `http://127.0.0.1:${port}`;
  const oauth = new ProxyOAuth(issuer, resource, 'Test Server');
  server.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const handled = await oauth.handle(req, res, url);
    if (!handled) res.writeHead(404).end();
  });

  const cleanup = () => {
    server.close();
    const hash = createHash('sha256').update(resource).digest('hex').slice(0, 32);
    rmSync(join(homedir(), '.tarsius-mcp', `oauth-${hash}.json`), { force: true });
  };
  return { issuer, oauth, cleanup };
}

async function registerClient(issuer: string, redirectUri: string, authMethod: 'none' | 'client_secret_post' = 'client_secret_post') {
  const res = await fetch(`${issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Client', redirect_uris: [redirectUri], token_endpoint_auth_method: authMethod }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

test('discovery documents point at this issuer', async () => {
  const h = await harness();
  try {
    const prm = await (await fetch(`${h.issuer}/.well-known/oauth-protected-resource`)).json();
    assert.equal(prm.authorization_servers[0], h.issuer);
    const asm = await (await fetch(`${h.issuer}/.well-known/oauth-authorization-server`)).json();
    assert.equal(asm.authorization_endpoint, `${h.issuer}/authorize`);
    assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
  } finally {
    h.cleanup();
  }
});

test('full authorization_code + PKCE flow issues a working access token', async () => {
  const h = await harness();
  try {
    const redirectUri = 'http://localhost:5173/callback';
    const client = await registerClient(h.issuer, redirectUri);
    assert.ok(client.client_id);

    const { verifier, challenge } = pkce();
    const authorizeUrl = new URL(`${h.issuer}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'xyz');

    const consentPage = await fetch(authorizeUrl);
    assert.equal(consentPage.status, 200);
    assert.match(await consentPage.text(), /Authorize access/);

    const decision = await fetch(`${h.issuer}/authorize/decision`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        decision: 'approve',
        client_id: client.client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        state: 'xyz',
      }),
    });
    assert.equal(decision.status, 302);
    const location = new URL(decision.headers.get('location')!);
    assert.equal(location.searchParams.get('state'), 'xyz');
    const code = location.searchParams.get('code');
    assert.ok(code);

    assert.ok(client.client_secret, 'default registration is a confidential client (matches Gemini-style setup)');

    const tokenRes = await fetch(`${h.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: client.client_secret!,
        code_verifier: verifier,
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokens = await tokenRes.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);

    // The issued token authenticates against the resource-server gate.
    const fakeReq = { headers: { authorization: `Bearer ${tokens.access_token}` } } as never;
    assert.equal(h.oauth.authenticate(fakeReq), true);

    // The code is single-use.
    const replay = await fetch(`${h.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        client_secret: client.client_secret!,
        code_verifier: verifier,
      }),
    });
    assert.equal(replay.status, 400);

    // Refresh rotates the token.
    const refreshed = await (
      await fetch(`${h.issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
      })
    ).json();
    assert.ok(refreshed.access_token);
    assert.notEqual(refreshed.access_token, tokens.access_token);
  } finally {
    h.cleanup();
  }
});

test('wrong PKCE verifier is rejected', async () => {
  const h = await harness();
  try {
    const redirectUri = 'http://localhost:5173/callback';
    const client = await registerClient(h.issuer, redirectUri, 'none');
    const { challenge } = pkce();

    const decision = await fetch(`${h.issuer}/authorize/decision`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'approve', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge }),
    });
    const code = new URL(decision.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await fetch(`${h.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: 'totally-wrong-verifier',
      }),
    });
    assert.equal(tokenRes.status, 400);
    assert.equal((await tokenRes.json()).error, 'invalid_grant');
  } finally {
    h.cleanup();
  }
});

test('denying the consent screen issues no code', async () => {
  const h = await harness();
  try {
    const redirectUri = 'http://localhost:5173/callback';
    const client = await registerClient(h.issuer, redirectUri);
    const decision = await fetch(`${h.issuer}/authorize/decision`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'deny', client_id: client.client_id, redirect_uri: redirectUri }),
    });
    const location = new URL(decision.headers.get('location')!);
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('code'), null);
  } finally {
    h.cleanup();
  }
});

test('unregistered client / mismatched redirect_uri is rejected at /authorize', async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.issuer}/authorize?response_type=code&client_id=nope&redirect_uri=http://x&code_challenge=a&code_challenge_method=S256`);
    assert.equal(res.status, 400);
  } finally {
    h.cleanup();
  }
});

test('revoked client can no longer redeem its tokens', async () => {
  const h = await harness();
  try {
    const redirectUri = 'http://localhost:5173/callback';
    const client = await registerClient(h.issuer, redirectUri, 'none');
    const { verifier, challenge } = pkce();
    const decision = await fetch(`${h.issuer}/authorize/decision`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ decision: 'approve', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge }),
    });
    const code = new URL(decision.headers.get('location')!).searchParams.get('code')!;
    const tokens = await (
      await fetch(`${h.issuer}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier }),
      })
    ).json();

    assert.equal(h.oauth.revokeClient(client.client_id), true);
    const fakeReq = { headers: { authorization: `Bearer ${tokens.access_token}` } } as never;
    assert.equal(h.oauth.authenticate(fakeReq), false);
  } finally {
    h.cleanup();
  }
});
