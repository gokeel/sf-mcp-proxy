import { createServer } from 'node:http';
import { URL } from 'node:url';

const SUCCESS_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
<h1>Authorization complete</h1><p>You can close this tab and return to the terminal.</p>
<script>setTimeout(() => window.close(), 1500)</script></body></html>`;

const errorHtml = (msg: string) => `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
<h1>Authorization failed</h1><pre>${msg.replace(/[<>&]/g, '')}</pre></body></html>`;

export interface CallbackResult {
  code: string;
}

/**
 * Start a one-shot loopback HTTP server and resolve with the authorization code
 * once Salesforce redirects the browser back to `/callback`.
 *
 * @param port          port to listen on (must match the ECA callback URL)
 * @param expectedState the OAuth `state` we sent; the callback must echo it
 * @param path          callback path, default `/callback`
 */
export function waitForCallback(
  port: number,
  expectedState: string | undefined,
  path = '/callback',
  timeoutMs = 5 * 60_000,
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (reqUrl.pathname === '/favicon.ico') {
        res.writeHead(404).end();
        return;
      }
      if (reqUrl.pathname !== path) {
        res.writeHead(404).end('Not found');
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');
      const state = reqUrl.searchParams.get('state');

      const done = (status: number, body: string, err?: Error) => {
        res.writeHead(status, { 'Content-Type': 'text/html' }).end(body);
        clearTimeout(timer);
        server.close();
        if (err) reject(err);
      };

      if (error) {
        const desc = reqUrl.searchParams.get('error_description') ?? '';
        done(400, errorHtml(`${error} ${desc}`), new Error(`OAuth error: ${error} ${desc}`.trim()));
        return;
      }
      if (!code) {
        done(400, errorHtml('missing "code"'), new Error('Callback did not include an authorization code'));
        return;
      }
      if (expectedState && state !== expectedState) {
        done(400, errorHtml('state mismatch'), new Error('OAuth state mismatch — possible CSRF, aborting'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(SUCCESS_HTML);
      clearTimeout(timer);
      server.close();
      resolve({ code });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the OAuth callback`));
    }, timeoutMs);

    server.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use — free it or change OAUTH_CALLBACK_PORT`));
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1');
  });
}
