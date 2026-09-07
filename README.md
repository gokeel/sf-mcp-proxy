# sf-mcp-proxy

> **Disclaimer.** This is an independent, unofficial project and is not affiliated
> with, endorsed by, or sponsored by Salesforce, Inc. "Salesforce" and related
> marks are trademarks of Salesforce, Inc.

**Why this exists:** Salesforce's Hosted MCP servers sit behind OAuth, but
Salesforce does not support Dynamic Client Registration — so every client has to
be wired up by hand with a pre-issued Consumer Key and a full Authorization
Code + PKCE flow before it can call a single tool. `sf-mcp-proxy` does that setup
once and hands you a CLI, a chat loop, and a proxy on top of it.

An interactive command-line **MCP client** — and, via `sf-mcp-proxy proxy`, an **MCP
server/bridge** other clients can connect to — for **Salesforce Hosted MCP
Servers**.

It authenticates you against Salesforce with **OAuth 2.0 Authorization Code + PKCE**
(the same flow the Claude and ChatGPT connectors use), caches the resulting tokens,
refreshes them automatically, and lets you list and call tools on any of the
Salesforce hosted MCP servers (`sobject-reads`, `sobject-all`, `flows`,
`invocable-actions`, …).

The OAuth flow — RFC 9728 metadata discovery, PKCE, the `resource` indicator, the
token exchange and refresh — is handled by [`@modelcontextprotocol/sdk`]. This app
supplies a Salesforce-specific `OAuthClientProvider`: it uses the pre-issued
**Consumer Key** from an External Client App and persists tokens to
`~/.sf-mcp-proxy/`.

> **API scope.** Tested against the GA release of the Salesforce Hosted MCP API
> (April 2026). Salesforce owns this API and can change it without notice;
> behavior may drift on later releases, and support for such changes is
> best-effort.

---

## 1. Create a Salesforce External Client App (ECA)

Do this once, in the org you want to connect to.

1. **Setup → App Manager → External Client App Manager → New External Client App.**
   Wait — if you only see "App Manager", enable External Client Apps first under
   *Setup → External Client Apps → Settings → Allow creation of connected apps*.
2. **Basic Information**
   - Name: e.g. `Local MCP CLI`
   - Contact email: your email
   - Distribution State: **Local**
3. **API (Enable OAuth Settings)** → check **Enable OAuth**
   - **Callback URL:** `http://localhost:8000/callback`
     *(must exactly match `OAUTH_REDIRECT_URI` in your `.env`; add more lines if you
     use other ports)*
   - **OAuth Scopes:** add
     - **Access MCP servers (`mcp_api`)**
     - **Perform requests at any time (`refresh_token`)**
   - Check **Require Proof Key for Code Exchange (PKCE)** — mandatory.
   - **Uncheck** *Require secret for Web Server Flow* and *Require secret for
     Refresh Token Flow* → the CLI runs as a public client (PKCE only, no secret).
     If you leave them checked, put the Consumer Secret in `SF_CONSUMER_SECRET`.
4. **Save.**
5. **Policies tab → OAuth Policies:** set *Permitted Users* and, under
   *Access Token / Session*, select **Issue JSON Web Token (JWT)-based access
   tokens for named users**. Relax IP restrictions if your org requires it.
6. **Settings tab → OAuth Settings → Consumer Key and Secret → (reveal).**
   Copy the **Consumer Key** (and the Secret only if you kept it required).
7. **Wait up to ~30 minutes** for the ECA to propagate before first use.

---

## 2. Configure the client

```bash
npm install
cp .env.example .env
cp servers.json.example servers.json
```

Edit **`.env`**:

| Variable              | Notes                                                                 |
|-----------------------|----------------------------------------------------------------------|
| `SF_CONSUMER_KEY`     | **Required.** Consumer Key from the ECA.                             |
| `SF_CONSUMER_SECRET`  | Only if the ECA still requires a secret.                            |
| `SF_ENV`              | `platform` (production) or `sandbox`. Default per server.           |
| `OAUTH_REDIRECT_URI`  | Must match an ECA Callback URL. Default `http://localhost:8000/callback`. |
| `OAUTH_CALLBACK_PORT` | Loopback port for the callback. Keep in sync with the redirect URI. |
| `SF_AUTH_SERVER_URL`  | Optional. Set to your My Domain host (e.g. `https://acme.my.salesforce.com`) if the org blocks login on `login.salesforce.com`. |
| `ANTHROPIC_API_KEY`   | Required only for `sf-mcp-proxy chat`. |
| `ANTHROPIC_MODEL`     | Optional chat model override (default `claude-opus-5`). |
| `SF_TOKEN_PASSPHRASE` | Optional. Encrypts cached tokens at rest. |

Edit **`servers.json`** to list the servers you care about. The reliable way is
to **copy the exact URL from Salesforce Setup → MCP servers** into `url`:

```json
{
  "servers": [
    { "name": "sobject-reads", "url": "https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-reads" },
    { "name": "flows", "env": "platform" }
  ]
}
```

If you omit `url`, the URL is built as:

| Tier | Pattern |
|---|---|
| production | `https://api.salesforce.com/platform/mcp/v1/{group}/{name}` |
| sandbox | `https://api.salesforce.com/platform/mcp/v1/sandbox/{group}/{name}` |

`group` defaults to `platform` and is overridable per entry. `-s/--server` on any
command also accepts a full URL directly.

---

## 3. Use it

```bash
# during development (no build step needed)
npm run dev -- <command> [options]

# or build once and use the bin
npm run build
node dist/cli.js <command>        # or: npm link  →  sf-mcp-proxy <command>
```

| Command | What it does |
|---|---|
| `sf-mcp-proxy servers` | list servers from `servers.json` with resolved URLs |
| `sf-mcp-proxy login  -s <name> [-e sandbox]` | run the browser OAuth flow, cache tokens |
| `sf-mcp-proxy whoami -s <name>` | show identity claims from the cached access token (JWT) |
| `sf-mcp-proxy tools  -s <name> [--json]` | list the server's tools |
| `sf-mcp-proxy toolspec -s <name>` | print `{ "tools": [...] }` for static tool registries (e.g. Gemini Enterprise Agent Registry) |
| `sf-mcp-proxy call   <tool> -s <name> -a '<json>' [--json]` | call one tool, print the result |
| `sf-mcp-proxy repl   -s <name>` | interactive session (`tools`, `schema`, `call`, `resources`, `read`, `quit`) |
| `sf-mcp-proxy chat   -s <name> [-p <provider>] [-m <model>] [-y]` | natural-language chat; an LLM calls the tools |
| `sf-mcp-proxy proxy  -s <name> [--http --port N --auth-token T \| --oauth]` | re-expose the server as MCP (stdio or HTTP) for other clients |
| `sf-mcp-proxy oauth-clients -s <name> [--revoke <id>]` | list/revoke clients registered against `proxy --oauth` |
| `sf-mcp-proxy logout -s <name>` | delete cached tokens for that server |

`-s/--server` may be omitted if `servers.json` has exactly one entry, and also
accepts a full server URL. `-e/--env` overrides the org tier for that run.

### Example

```bash
npm run dev -- login -s sobject-reads -e sandbox
# → browser opens to the Salesforce login/consent screen; approve it.

npm run dev -- tools -s sobject-reads
npm run dev -- call query -s sobject-reads \
  -a '{"soql":"SELECT Id, Name FROM Account LIMIT 3"}'
```

*(Use `sf-mcp-proxy repl` then `schema <tool>` to see a tool's exact argument shape.)*

### Chat mode (`sf-mcp-proxy chat`)

Starts an LLM in a tool-use loop over the selected server's tools:

```bash
npm run dev -- chat -s sobject-reads
you> how many open opportunities are closing this quarter?
⚙  soqlQuery({"soql":"SELECT COUNT() FROM Opportunity WHERE IsClosed = false AND ..."})
   run soqlQuery? [y/N] y
…
```

Tool calls whose name looks like a write (`create`/`update`/`delete`/`run`/…)
prompt for confirmation. `-y/--yes` approves everything; `--confirm-all` prompts
for every call. In-chat commands: `/tools`, `/reset`, `/quit`.

#### Model provider

`--provider` (or `SFCHAT_PROVIDER`) selects the LLM. Anthropic uses its native
SDK; everything else goes through the OpenAI-compatible `/chat/completions` API.

| `--provider` | Base URL | API key env | Default model |
|---|---|---|---|
| `anthropic` (default) | — | `ANTHROPIC_API_KEY` | `claude-opus-5` |
| `openai` | `api.openai.com/v1` | `OPENAI_API_KEY` | `gpt-4.1` |
| `deepseek` | `api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `kimi` / `moonshot` | `api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | `kimi-k2-0711-preview` |
| `qwen` | `dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | `qwen-plus` |
| `openrouter` | `openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | — (set `--model`) |
| `custom` | `--base-url` / `SFCHAT_BASE_URL` | `SFCHAT_API_KEY` | — (set `--model`) |

`SFCHAT_API_KEY` works as the key for any provider. Override per run with
`--model` / `--base-url`, or persist with `SFCHAT_MODEL` / `SFCHAT_BASE_URL`.

```bash
# DeepSeek
DEEPSEEK_API_KEY=sk-... npm run dev -- chat -s sobject-reads -p deepseek

# Kimi with a specific model
npm run dev -- chat -s flows -p kimi -m kimi-k2-0905-preview

# Qwen (use the Beijing endpoint instead of the default Singapore one)
npm run dev -- chat -s sobject-reads -p qwen \
  --base-url https://dashscope.aliyuncs.com/compatible-mode/v1

# Any other OpenAI-compatible endpoint (local llama.cpp, vLLM, Together, …)
npm run dev -- chat -s sobject-reads -p custom \
  --base-url http://localhost:8000/v1 -m my-model
```

The chosen model must support **function/tool calling** — `deepseek-chat`,
Kimi K2, `qwen-plus`/`qwen3-*`, GPT-4-class models all do.

### Proxy mode (`sf-mcp-proxy proxy`) — let other MCP clients connect

`sf-mcp-proxy proxy` re-exposes **one** Salesforce Hosted MCP server as a plain MCP
server that any MCP client can connect to. The proxy owns the Salesforce OAuth
(it uses the token cached by `sf-mcp-proxy login`), so downstream clients — Gemini
Enterprise agent platform, Nous Research Hermes, Claude Desktop, Cursor, a custom
agent — need no Salesforce auth support of their own. Every request is forwarded
upstream and runs **as the Salesforce user who authorized the proxy** (one
identity per proxy process).

Authorize once, then run the proxy unattended:

```bash
npm run dev -- login -s sobject-reads -e sandbox    # one-time browser consent
npm run build && npm link                           # so `sf-mcp-proxy` is on PATH
```

**stdio** — for clients that spawn a subprocess (Claude Desktop, Cursor, most
agent frameworks). Point the client at `sf-mcp-proxy proxy`:

```json
{
  "mcpServers": {
    "salesforce-sobject-reads": {
      "command": "sf-mcp-proxy",
      "args": ["proxy", "-s", "sobject-reads", "-e", "sandbox", "--no-login"]
    }
  }
}
```

`--no-login` makes it fail fast (instead of opening a browser) if the token is
missing or dead — re-run `sf-mcp-proxy login` when that happens.

**Streamable HTTP** — for clients that take a URL (Gemini Enterprise, remote
platforms):

```bash
sf-mcp-proxy proxy -s sobject-reads -e sandbox --no-login \
  --http --port 9000 --auth-token "$(openssl rand -hex 16)"
# → endpoint: http://127.0.0.1:9000/mcp   (send: Authorization: Bearer <token>)
```

The client configures the MCP server URL `http://127.0.0.1:9000/mcp` and sends
the bearer token. For a **remote** client (Gemini Enterprise can't reach your
localhost):

- bind wider with `--host 0.0.0.0` **and** put a TLS reverse proxy / tunnel
  (Caddy, nginx, `cloudflared`, `ngrok`) in front — the proxy speaks plain HTTP;
- always set `--auth-token` (it's the only thing gating access to your org), **or**
  use `--oauth` (below) if the client wants real OAuth2 (e.g. Gemini Enterprise's
  connected-data-store setup) instead of a bearer token you paste in;
- run it on a small always-on VM or container; restart it after `sf-mcp-proxy login`.

Run one proxy per Salesforce server you want to expose (different `--port`).

#### `--oauth` — a real OAuth2 authorization server in front of the proxy

`--auth-token` is a shared secret; `--oauth` instead runs a small, spec-shaped
OAuth 2.0 Authorization Server + Resource Server on the same HTTP port:

- **RFC 9728 / RFC 8414 discovery** (`/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`) — a spec-compliant client finds
  everything itself from the 401 it gets hitting `/mcp`.
- **RFC 7591 Dynamic Client Registration** (`POST /register`) — any client can
  self-register; you don't hand out a shared secret in advance.
- **Authorization Code + PKCE (S256)**, and **every `/authorize` request needs
  your explicit approval** — it renders an Approve/Deny page (open it in a
  browser) naming the requesting client before any code is issued.

```bash
sf-mcp-proxy proxy -s sobject-reads -e sandbox --no-login --http --port 9000 --oauth
# prints the authorize/token/discovery URLs to paste into a client's OAuth
# config (e.g. Gemini Enterprise's "Authorization URL" / "Token URL" fields)
```

This is a *second*, separate OAuth layer — it only gates who may reach the
proxy. It does not change who the proxy acts as in Salesforce; every approved
client still runs as the one identity that ran `sf-mcp-proxy login`.

Manage registered clients:

```bash
sf-mcp-proxy oauth-clients -s sobject-reads -e sandbox                    # list
sf-mcp-proxy oauth-clients -s sobject-reads -e sandbox --revoke <clientId> # revoke (kills its tokens too)
```

Behind a TLS reverse proxy / tunnel, pass `--public-url https://your.public.host`
so the discovery documents and redirect URLs advertise the externally-reachable
address instead of `http://127.0.0.1:9000`.

### Token storage

Cached tokens live in `~/.sf-mcp-proxy/<hash>.json` (dir `0700`, files `0600`). Set
`SF_TOKEN_PASSPHRASE` in `.env` to AES-256-GCM encrypt those files (scrypt-derived
key). Changing or losing the passphrase just forces a re-login.

### Tests

```bash
npm test        # node:test via tsx — config URL building, JWT decode, tool mapping
```

---

## How auth works

1. First request to the MCP server returns `401`. The SDK discovers
   `https://api.salesforce.com/.well-known/oauth-protected-resource/platform/mcp/v1/…`,
   which names the org's authorization server (your My Domain for sandboxes, or
   `https://login.salesforce.com`).
2. The SDK builds the authorize URL with PKCE (`code_challenge`, `S256`), the
   `mcp_api refresh_token` scopes, and `resource=<server URL>` (RFC 8707), then
   opens your browser.
3. Salesforce redirects to `http://localhost:<port>/callback` with a `code`; a
   one-shot loopback server catches it and the SDK exchanges it (+ `code_verifier`)
   for tokens.
4. Tokens are written to `~/.sf-mcp-proxy/<hash>.json` (dir `0700`, files `0600`). On
   later runs the access token is reused and silently refreshed via the refresh
   token when expired.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `redirect_uri_mismatch` | The ECA Callback URL must byte-for-byte equal `OAUTH_REDIRECT_URI`. |
| `invalid_client_id` right after creating the ECA | Wait ~30 min for propagation. |
| Browser shows the wrong org / login | Set `SF_AUTH_SERVER_URL` to your My Domain, or `SF_LOGIN_URL=https://test.salesforce.com` for sandboxes. |
| `Port 8000 is already in use` | Change `OAUTH_CALLBACK_PORT` **and** the ECA Callback URL. |
| Stuck / bad token | `sf-mcp-proxy logout -s <name>` then `login` again. |

## License

MIT — see [LICENSE](LICENSE).

[`@modelcontextprotocol/sdk`]: https://github.com/modelcontextprotocol/typescript-sdk
