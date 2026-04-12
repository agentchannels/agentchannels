/**
 * Local OAuth flow for installing a Slack app to a workspace.
 *
 * Starts a temporary HTTP server, opens the browser to Slack's OAuth page,
 * and catches the redirect to exchange the auth code for a bot token.
 */

import { createServer, type Server } from 'node:http';
import { URL } from 'node:url';

const SLACK_API_BASE = 'https://slack.com/api';

export interface OAuthInstallOptions {
  appId: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  port?: number;
}

export interface OAuthInstallResult {
  botToken: string;
  teamName: string;
  teamId: string;
  botUserId?: string;
}

/**
 * Update the app manifest to include the OAuth redirect URL.
 * Requires an access token (from tooling.tokens.rotate).
 */
export async function addRedirectUrl(
  accessToken: string,
  appId: string,
  redirectUri: string,
): Promise<void> {
  // Export current manifest
  const exportResp = await fetch(`${SLACK_API_BASE}/apps.manifest.export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ app_id: appId }),
  });
  const exportData = (await exportResp.json()) as { ok: boolean; manifest?: Record<string, unknown>; error?: string };
  if (!exportData.ok) {
    throw new Error(`Failed to export manifest: ${exportData.error}`);
  }

  // Add redirect URL
  const manifest = exportData.manifest!;
  const oauthConfig = (manifest.oauth_config ?? {}) as Record<string, unknown>;
  oauthConfig.redirect_urls = [redirectUri];
  manifest.oauth_config = oauthConfig;

  // Update manifest
  const updateResp = await fetch(`${SLACK_API_BASE}/apps.manifest.update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ app_id: appId, manifest }),
  });
  const updateData = (await updateResp.json()) as { ok: boolean; error?: string };
  if (!updateData.ok) {
    throw new Error(`Failed to update manifest with redirect URL: ${updateData.error}`);
  }
}

/**
 * Run the local OAuth install flow.
 *
 * 1. Starts a local HTTP server on the given port
 * 2. Opens the browser to Slack's OAuth authorize page
 * 3. Catches the redirect callback with the auth code
 * 4. Exchanges the code for a bot token via oauth.v2.access
 * 5. Returns the bot token
 */
export function runOAuthInstall(options: OAuthInstallOptions): Promise<OAuthInstallResult> {
  const port = options.port ?? 3333;
  const redirectUri = `http://localhost:${port}/oauth/callback`;
  const authorizeUrl =
    `https://slack.com/oauth/v2/authorize` +
    `?client_id=${options.clientId}` +
    `&scope=${options.scopes.join(',')}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  return new Promise((resolve, reject) => {
    let server: Server;
    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth flow timed out after 5 minutes. Please try again.'));
    }, 5 * 60 * 1000);

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlPage('Error', `OAuth error: ${error}`, false));
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(htmlPage('Error', 'No authorization code received', false));
        return;
      }

      try {
        // Exchange code for tokens
        const tokenResp = await fetch(`${SLACK_API_BASE}/oauth.v2.access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });
        const tokenData = (await tokenResp.json()) as {
          ok: boolean;
          access_token?: string;
          team?: { id: string; name: string };
          bot_user_id?: string;
          error?: string;
        };

        if (!tokenData.ok) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(htmlPage('Error', `Token exchange failed: ${tokenData.error}`, false));
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Token exchange failed: ${tokenData.error}`));
          return;
        }

        const teamName = tokenData.team?.name ?? 'unknown';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(htmlPage(
          'Installed!',
          `AgentChannels bot installed to <strong>${teamName}</strong>. You can close this tab.`,
          true,
        ));

        clearTimeout(timeout);
        server.close();
        resolve({
          botToken: tokenData.access_token!,
          teamName,
          teamId: tokenData.team?.id ?? '',
          botUserId: tokenData.bot_user_id,
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(htmlPage('Error', (err as Error).message, false));
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`\n   OAuth callback server listening on http://localhost:${port}`);
      console.log(`   Opening browser for authorization...\n`);

      // Open browser
      const openCommand =
        process.platform === 'darwin' ? 'open' :
        process.platform === 'win32' ? 'start' : 'xdg-open';

      import('node:child_process').then(({ exec }) => {
        exec(`${openCommand} "${authorizeUrl}"`, (err) => {
          if (err) {
            console.log(`   Could not open browser automatically.`);
            console.log(`   Please open this URL manually:\n`);
            console.log(`   ${authorizeUrl}\n`);
          }
        });
      });
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Try a different port.`));
      } else {
        reject(err);
      }
    });
  });
}

function htmlPage(title: string, body: string, success: boolean): string {
  const color = success ? '#2ea44f' : '#d73a49';
  return `<!DOCTYPE html>
<html>
<head><title>AgentChannels — ${title}</title></head>
<body style="font-family: -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
  <div style="text-align: center;">
    <h1 style="color: ${color};">${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
}
