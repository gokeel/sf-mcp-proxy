# syntax=docker/dockerfile:1

# ---- build ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Token cache lives at $HOME/.sf-mcp-proxy. On a stateless host (Cloud Run, etc.)
# mount a persistent volume here so the rotated Salesforce refresh token survives
# restarts — otherwise a cold start comes back with a stale token and no browser
# to re-auth. Seed it once by running `sf-mcp-proxy login` locally and copying
# ~/.sf-mcp-proxy/*.json into the volume.
RUN mkdir -p /home/node/.sf-mcp-proxy && chown -R node:node /home/node/.sf-mcp-proxy
USER node

# Cloud Run injects $PORT (usually 8080); bind all interfaces so it's reachable.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

# Serve one Salesforce MCP server over Streamable HTTP. Provide the target with
# `-s <name|url>` and (recommended) protect /mcp with --auth-token / $SF_PROXY_AUTH_TOKEN
# or --oauth. --no-login: never try to open a browser; fail if no cached token.
ENTRYPOINT ["node", "dist/cli.js", "proxy", "--http", "--no-login"]
CMD ["-s", "sobject-reads"]
