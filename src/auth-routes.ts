// Browser-based OAuth bootstrap routes.
//
// Flow:
//   1. Admin visits GET /auth/login?token=<MCP_SHARED_SECRET>
//   2. We generate a state, store it briefly, and 302 to NinjaOne /ws/oauth/authorize
//   3. User signs in to NinjaOne, NinjaOne 302s back to /auth/callback?code=...&state=...
//   4. We verify the state, exchange the code for tokens, persist refresh_token
//   5. Show "Connected" success page
//
// The state cache is in-memory and short-TTL — only needed for the OAuth dance.

import type { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "./config.js";
import { UserOAuth, UserOAuthError } from "./user-oauth.js";

const STATE_TTL_MS = 10 * 60 * 1000;

class StateCache {
  private states = new Map<string, number>();

  create(): string {
    this.gc();
    const state = randomBytes(32).toString("hex");
    this.states.set(state, Date.now() + STATE_TTL_MS);
    return state;
  }

  consume(state: string): boolean {
    this.gc();
    const expiresAt = this.states.get(state);
    if (!expiresAt) return false;
    this.states.delete(state);
    return expiresAt > Date.now();
  }

  private gc(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.states.entries()) {
      if (expiresAt <= now) this.states.delete(state);
    }
  }
}

export function buildAuthRoutes(config: AppConfig, userOAuth: UserOAuth) {
  const stateCache = new StateCache();

  function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
    if (!config.mcpSharedSecret) {
      next();
      return;
    }
    const headerToken = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    if (headerToken !== config.mcpSharedSecret && queryToken !== config.mcpSharedSecret) {
      res.status(401).send(landingPage(
        "Unauthorized",
        `<p>Append <code>?token=&lt;MCP_SHARED_SECRET&gt;</code> to this URL to start the NinjaOne sign-in flow.</p>`
      ));
      return;
    }
    next();
  }

  async function handleLogin(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.oauthRedirectUri) {
        res
          .status(500)
          .send(landingPage("Missing OAuth redirect URI", `<p>Set <code>PUBLIC_BASE_URL</code> or <code>OAUTH_REDIRECT_URI</code> in Railway → Variables, then redeploy.</p>`));
        return;
      }
      const state = stateCache.create();
      const url = userOAuth.buildAuthorizeUrl(state);
      res.redirect(url);
    } catch (err) {
      next(err);
    }
  }

  async function handleCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code, state, error, error_description } = req.query as Record<
        string,
        string | undefined
      >;
      if (error) {
        res.status(400).send(
          landingPage("NinjaOne returned an error", `<p><strong>${error}</strong></p><p>${error_description ?? ""}</p>`)
        );
        return;
      }
      if (!code || !state) {
        res.status(400).send(landingPage("Missing code or state", `<p>Restart the sign-in from <code>/auth/login</code>.</p>`));
        return;
      }
      if (!stateCache.consume(state)) {
        res.status(400).send(
          landingPage("Invalid or expired state", `<p>The sign-in took too long or was opened in a different browser. Restart from <code>/auth/login</code>.</p>`)
        );
        return;
      }
      await userOAuth.exchangeAuthorizationCode(code);
      const status = await userOAuth.getStatus();
      res.send(
        landingPage(
          "Connected to NinjaOne ✓",
          `<p>The MCP server now has a user-context refresh token. Ticket writes, comments, and updates will work.</p>
           <p>Token saved at <code>${escapeHtml(status.token_storage_path)}</code>.</p>
           <p><small>You can close this window and retry your action in Claude.</small></p>`
        )
      );
    } catch (err) {
      if (err instanceof UserOAuthError) {
        res.status(500).send(landingPage("Token exchange failed", `<p>${escapeHtml(err.message)}</p>`));
        return;
      }
      next(err);
    }
  }

  async function handleStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = await userOAuth.getStatus();
      res.json({
        ...status,
        login_url: userOAuth.loginUrl()
      });
    } catch (err) {
      next(err);
    }
  }

  return { requireSharedSecret, handleLogin, handleCallback, handleStatus };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function landingPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:4rem auto;padding:1.5rem;color:#222;line-height:1.5;}
  h1{font-size:1.4rem;margin-bottom:0.5rem;}
  code{background:#f3f4f6;padding:0.1rem 0.3rem;border-radius:3px;font-size:0.9em;}
  p{margin:0.5rem 0;}
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body></html>`;
}
