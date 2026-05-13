import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { exchangeCodeForTokens } from "./auth.js";
import type { AppConfig } from "./config.js";
import {
  newToken,
  SessionStore,
  type RegisteredClient,
  type Session,
  type SessionUser
} from "./sessions.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

export function getIssuer(config: AppConfig): string {
  return config.publicBaseUrl ?? "";
}

export function discoveryDoc(config: AppConfig): Record<string, unknown> {
  const issuer = getIssuer(config);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["mcp"]
  };
}

export function protectedResourceDoc(config: AppConfig): Record<string, unknown> {
  const issuer = getIssuer(config);
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer]
  };
}

export async function handleRegister(req: Request, res: Response, store: SessionStore): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris.filter((u) => typeof u === "string") as string[])
    : [];
  if (redirectUris.length === 0) {
    res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
    return;
  }

  const client: RegisteredClient = {
    client_id: newToken(),
    client_name: typeof body.client_name === "string" ? body.client_name : undefined,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    created_at: Date.now()
  };
  await store.putClient(client);

  res.status(201).json({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: client.grant_types,
    response_types: client.response_types
  });
}

export async function handleAuthorize(req: Request, res: Response, config: AppConfig, store: SessionStore): Promise<void> {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type, scope } =
    req.query as Record<string, string | undefined>;

  if (response_type !== "code") {
    res.status(400).send("Unsupported response_type. Only 'code' is supported.");
    return;
  }
  if (!client_id || !redirect_uri) {
    res.status(400).send("Missing client_id or redirect_uri.");
    return;
  }

  const client = await store.getClient(client_id);
  if (!client) {
    res.status(400).send("Unknown client_id. Register the client first.");
    return;
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    res.status(400).send("redirect_uri not registered for this client.");
    return;
  }

  const ninjaState = newToken();
  store.putPendingAuth(ninjaState, {
    ninja_state: ninjaState,
    claude_state: state,
    claude_redirect_uri: redirect_uri,
    claude_client_id: client_id,
    code_challenge,
    code_challenge_method,
    scope: scope ?? "mcp",
    created_at: Date.now()
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.ninjaClientId,
    redirect_uri: config.oauthRedirectUri,
    scope: config.oauthScope,
    state: ninjaState,
    prompt: "login"
  });
  res.redirect(`${config.ninjaAuthorizeUrl}?${params.toString()}`);
}

export async function handleNinjaCallbackForMcp(
  req: Request,
  res: Response,
  config: AppConfig,
  store: SessionStore,
  identifyUser: (accessToken: string) => Promise<SessionUser | undefined>
): Promise<boolean> {
  // Returns true if this was an MCP-flow callback (state matches a pending auth)
  // so the caller can skip the legacy handler. Returns false otherwise.
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

  if (!state) return false;
  const pending = store.takePendingAuth(state);
  if (!pending) return false;

  if (error) {
    redirectWithError(res, pending.claude_redirect_uri, pending.claude_state, error, error_description);
    return true;
  }
  if (!code) {
    redirectWithError(res, pending.claude_redirect_uri, pending.claude_state, "invalid_request", "Missing code");
    return true;
  }

  try {
    const tokens = await exchangeCodeForTokens(config, code);
    if (!tokens.refresh_token) {
      redirectWithError(
        res,
        pending.claude_redirect_uri,
        pending.claude_state,
        "server_error",
        "NinjaOne did not return a refresh_token. Enable offline_access scope on the API app."
      );
      return true;
    }

    const expiresInSec = tokens.expires_in ?? 3600;
    const user = await identifyUser(tokens.access_token).catch(() => undefined);

    const ourCode = newToken();
    store.putPendingCode(ourCode, {
      code: ourCode,
      ninja_refresh_token: tokens.refresh_token,
      ninja_access_token: tokens.access_token,
      ninja_access_token_expires_at: Date.now() + expiresInSec * 1000,
      user,
      scope: pending.scope,
      client_id: pending.claude_client_id,
      redirect_uri: pending.claude_redirect_uri,
      code_challenge: pending.code_challenge,
      code_challenge_method: pending.code_challenge_method,
      created_at: Date.now()
    });

    const params = new URLSearchParams({ code: ourCode });
    if (pending.claude_state) params.set("state", pending.claude_state);
    res.redirect(`${pending.claude_redirect_uri}?${params.toString()}`);
  } catch (err) {
    redirectWithError(
      res,
      pending.claude_redirect_uri,
      pending.claude_state,
      "server_error",
      err instanceof Error ? err.message : "Token exchange failed"
    );
  }
  return true;
}

export async function handleToken(req: Request, res: Response, store: SessionStore): Promise<void> {
  const body = (req.body ?? {}) as Record<string, string>;
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    const { code, code_verifier, redirect_uri, client_id } = body;
    if (!code) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code" });
      return;
    }
    const pending = store.takePendingCode(code);
    if (!pending) {
      res.status(400).json({ error: "invalid_grant", error_description: "Unknown or expired code" });
      return;
    }
    if (pending.redirect_uri !== redirect_uri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    if (pending.client_id !== client_id) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }
    if (pending.code_challenge) {
      if (!code_verifier) {
        res.status(400).json({ error: "invalid_request", error_description: "Missing code_verifier" });
        return;
      }
      const ok = verifyPkce(code_verifier, pending.code_challenge, pending.code_challenge_method);
      if (!ok) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    const now = Date.now();
    const session: Session = {
      mcp_access_token: newToken(),
      mcp_refresh_token: newToken(),
      mcp_access_token_expires_at: now + ACCESS_TOKEN_TTL_MS,
      ninja_refresh_token: pending.ninja_refresh_token,
      ninja_access_token: pending.ninja_access_token,
      ninja_access_token_expires_at: pending.ninja_access_token_expires_at,
      user: pending.user,
      scope: pending.scope,
      client_id: pending.client_id,
      created_at: now,
      last_used_at: now
    };
    await store.putSession(session);

    res.json({
      access_token: session.mcp_access_token,
      refresh_token: session.mcp_refresh_token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: session.scope
    });
    return;
  }

  if (grantType === "refresh_token") {
    const { refresh_token, client_id } = body;
    if (!refresh_token) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing refresh_token" });
      return;
    }
    const session = await store.getSessionByRefreshToken(refresh_token);
    if (!session) {
      res.status(400).json({ error: "invalid_grant", error_description: "Unknown refresh_token" });
      return;
    }
    if (client_id && session.client_id !== client_id) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    const now = Date.now();
    session.mcp_access_token = newToken();
    session.mcp_access_token_expires_at = now + ACCESS_TOKEN_TTL_MS;
    session.last_used_at = now;
    await store.putSession(session);

    res.json({
      access_token: session.mcp_access_token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: session.scope
    });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
}

function verifyPkce(verifier: string, challenge: string, method: string | undefined): boolean {
  if (method === "S256" || !method) {
    const hash = createHash("sha256").update(verifier).digest("base64url");
    return hash === challenge;
  }
  if (method === "plain") return verifier === challenge;
  return false;
}

function redirectWithError(
  res: Response,
  redirectUri: string,
  state: string | undefined,
  error: string,
  description?: string
): void {
  const params = new URLSearchParams({ error });
  if (description) params.set("error_description", description);
  if (state) params.set("state", state);
  res.redirect(`${redirectUri}?${params.toString()}`);
}
