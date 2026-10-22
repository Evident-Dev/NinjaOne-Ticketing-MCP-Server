// Browser-based OAuth bootstrap routes.
//
// Flow:
//   1. Tech visits GET /auth/login?token=<their personal token>
//      (or an admin with ?token=<MCP_SHARED_SECRET> for the shared sign-in)
//   2. We generate a state tied to that identity, and 302 to NinjaOne /ws/oauth/authorize
//   3. User signs in to NinjaOne, NinjaOne 302s back to /auth/callback?code=...&state=...
//   4. We verify the state, exchange the code for tokens, and store the
//      refresh_token under the identity from step 1
//   5. Show "Connected" success page
//
// The state cache is in-memory and short-TTL — only needed for the OAuth dance.

import type { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import type { AppConfig } from "./config.js";
import type { TechnicianStore } from "./technician-store.js";
import { UserOAuth, UserOAuthError, type LoginIdentity } from "./user-oauth.js";

const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingLogin {
  identity: LoginIdentity;
  expiresAt: number;
}

class StateCache {
  private states = new Map<string, PendingLogin>();

  create(identity: LoginIdentity): string {
    this.gc();
    const state = randomBytes(32).toString("hex");
    this.states.set(state, { identity, expiresAt: Date.now() + STATE_TTL_MS });
    return state;
  }

  consume(state: string): LoginIdentity | undefined {
    this.gc();
    const pending = this.states.get(state);
    if (!pending) return undefined;
    this.states.delete(state);
    return pending.expiresAt > Date.now() ? pending.identity : undefined;
  }

  private gc(): void {
    const now = Date.now();
    for (const [state, pending] of this.states.entries()) {
      if (pending.expiresAt <= now) this.states.delete(state);
    }
  }
}

type RequestWithLoginIdentity = Request & { loginIdentity?: LoginIdentity };

export function buildAuthRoutes(
  config: AppConfig,
  userOAuth: UserOAuth,
  technicianStore: TechnicianStore
) {
  const stateCache = new StateCache();

  // Works out whose sign-in this is from the presented token: a tech's
  // personal token, or the shared secret for the shared sign-in.
  async function requireLoginIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const headerToken = req.header("authorization")?.replace(/^Bearer\s+/i, "");
      const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
      const presented = headerToken ?? queryToken;
      const request = req as RequestWithLoginIdentity;

      if (presented) {
        const technician = await technicianStore.findWithRefresh(presented);
        if (technician) {
          request.loginIdentity = { kind: "technician", email: technician.email, token: technician.token };
          next();
          return;
        }
        if (config.mcpSharedSecret && presented === config.mcpSharedSecret) {
          request.loginIdentity = { kind: "shared" };
          next();
          return;
        }
      }

      // Local dev: no auth configured at all.
      if (!config.mcpSharedSecret && technicianStore.size() === 0) {
        request.loginIdentity = { kind: "shared" };
        next();
        return;
      }

      res.status(401).send(landingPage(
        "Unauthorized",
        `<p>Append <code>?token=&lt;your personal token&gt;</code> to this URL to start the NinjaOne sign-in flow.</p>`
      ));
    } catch (error) {
      next(error);
    }
  }

  async function handleLogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!config.oauthRedirectUri) {
        res
          .status(500)
          .send(landingPage("Missing OAuth redirect URI", `<p>Set <code>PUBLIC_BASE_URL</code> or <code>OAUTH_REDIRECT_URI</code> in Railway → Variables, then redeploy.</p>`));
        return;
      }
      const state = stateCache.create((req as RequestWithLoginIdentity).loginIdentity!);
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
          landingPage("NinjaOne returned an error", `<p><strong>${escapeHtml(error)}</strong></p><p>${escapeHtml(error_description ?? "")}</p>`)
        );
        return;
      }
      if (!code || !state) {
        res.status(400).send(landingPage("Missing code or state", `<p>Restart the sign-in from <code>/auth/login</code>.</p>`));
        return;
      }
      const identity = stateCache.consume(state);
      if (!identity) {
        res.status(400).send(
          landingPage("Invalid or expired state", `<p>The sign-in took too long or was opened in a different browser. Restart from <code>/auth/login</code>.</p>`)
        );
        return;
      }
      const session = await userOAuth.exchangeAuthorizationCode(code, identity);
      const status = await session.getStatus();
      res.send(
        landingPage(
          "Connected to NinjaOne ✓",
          `<p>Ticket writes, comments, and updates for <strong>${escapeHtml(status.signed_in_for)}</strong> will now use this NinjaOne sign-in.</p>
           <p>Token saved at <code>${escapeHtml(status.token_storage)}</code>.</p>
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

  async function handleStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const identity = (req as RequestWithLoginIdentity).loginIdentity!;
      const status = await userOAuth.sessionFor(identity).getStatus();
      res.json({
        ...status,
        login_url: userOAuth.loginUrl(identity)
      });
    } catch (err) {
      next(err);
    }
  }

  return { requireLoginIdentity, handleLogin, handleCallback, handleStatus };
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
