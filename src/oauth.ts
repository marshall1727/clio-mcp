/**
 * OAuth 2.0 Authorization Code flow with a loopback redirect (http://127.0.0.1:<port>/callback).
 * Per https://docs.developers.clio.com/api-docs/clio-manage/authorization/
 *
 * Non-blocking design: `startAuthentication()` starts the loopback server, opens the browser and returns the URL IMMEDIATELY.
 * The code-for-token exchange happens in the background on the callback; `getPendingAuth()` reports the state.
 * (The blocking variant ran into the tool-call timeout in Claude Desktop.)
 */
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { config, assertClientConfig } from "./config.js";
import { t, locale } from "./i18n.js";
import { saveTokens, loadTokens, clearTokens, type TokenSet } from "./store.js";

const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

export interface PendingAuth {
  state: string;
  port: number;
  url: string;
  startedAt: number;
  status: "pending" | "exchanging" | "done" | "error" | "expired";
  error?: string;
  user?: { id: number; name?: string; email?: string };
}

let pending: (PendingAuth & { server?: http.Server; timer?: NodeJS.Timeout }) | null = null;

export function getPendingAuth(): PendingAuth | null {
  if (!pending) return null;
  const { server: _s, timer: _t, ...pub } = pending;
  return pub;
}

function openBrowser(url: string): boolean {
  try {
    if (process.platform === "win32") {
      // Start-Process opens the URL in the default browser; PowerShell does not interpret anything inside single quotes
      spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

function listenOnFirstFreePort(ports: number[]): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryNext = (i: number) => {
      if (i >= ports.length) return reject(new Error(t("runtime.no_free_port", { ports: ports.join(", ") })));
      const server = http.createServer();
      server.once("error", () => tryNext(i + 1));
      server.listen(ports[i], "127.0.0.1", () => resolve({ server, port: ports[i] }));
    };
    tryNext(0);
  });
}

interface TokenResponse {
  token_type: string;
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(t("runtime.token_endpoint_error", { status: res.status, body: text.slice(0, 300) }));
  return JSON.parse(text) as TokenResponse;
}

function toTokenSet(r: TokenResponse, previous?: TokenSet | null): TokenSet {
  const now = Date.now();
  return {
    token_type: r.token_type,
    access_token: r.access_token,
    refresh_token: r.refresh_token ?? previous?.refresh_token ?? "",
    expires_at: now + r.expires_in * 1000,
    obtained_at: now,
    user: previous?.user,
  };
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:40em;margin:4em auto"><h2>${title}</h2><p>${body}</p></body></html>`;
}

function closePending(status: PendingAuth["status"], error?: string) {
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  try {
    pending.server?.close();
  } catch {
    /* ignore */
  }
  pending.server = undefined;
  pending.status = status;
  if (error) pending.error = error;
}

async function fetchIdentity(accessToken: string): Promise<{ id: number; name?: string; email?: string } | undefined> {
  try {
    const res = await fetch(`${config.apiBase}/users/who_am_i?fields=id,name,email`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { data: { id: number; name?: string; email?: string } };
    return j.data;
  } catch {
    return undefined;
  }
}

/**
 * Starts the authorization and returns the URL immediately. If one is already running, returns the same one.
 * `force=true` cancels the running attempt and starts over.
 */
export async function startAuthentication(force = false): Promise<{ url: string; port: number; browserOpened: boolean; reused: boolean }> {
  const { clientId, clientSecret } = assertClientConfig();

  if (pending && pending.status === "pending" && !force) {
    const opened = openBrowser(pending.url);
    return { url: pending.url, port: pending.port, browserOpened: opened, reused: true };
  }
  if (pending && pending.server) closePending("expired", t("runtime.auth_replaced"));

  const { server, port } = await listenOnFirstFreePort(config.redirectPorts);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = crypto.randomBytes(24).toString("base64url");

  const authUrl = new URL(config.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("redirect_on_decline", "true");
  const url = authUrl.toString();

  const p: NonNullable<typeof pending> = { state, port, url, startedAt: Date.now(), status: "pending", server };
  pending = p;

  p.timer = setTimeout(() => {
    if (pending === p && p.status === "pending") closePending("expired", t("runtime.auth_expired"));
  }, AUTH_TIMEOUT_MS);

  server.on("request", async (req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const err = u.searchParams.get("error");
    const gotState = u.searchParams.get("state");
    const gotCode = u.searchParams.get("code");
    if (gotState !== state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(page(t("runtime.page_error_title"), t("runtime.page_bad_state")));
      return;
    }
    if (err || !gotCode) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page(t("runtime.page_denied_title"), t("runtime.page_denied_body")));
      closePending("error", t("runtime.auth_denied", { reason: err ?? t("runtime.auth_denied_no_code") }));
      return;
    }
    p.status = "exchanging";
    try {
      const tr = await postToken({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code: gotCode,
        redirect_uri: redirectUri,
      });
      const tokens = toTokenSet(tr, null);
      tokens.user = await fetchIdentity(tokens.access_token);
      saveTokens(tokens);
      p.user = tokens.user;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        page(t("runtime.page_success_title"), t("runtime.page_success_body", { user: tokens.user?.name ? ` (${tokens.user.name})` : "" }))
      );
      closePending("done");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" }).end(page(t("runtime.page_token_error_title"), (e as Error).message));
      closePending("error", (e as Error).message);
    }
  });

  console.error(t("runtime.console_auth_url", { url }));
  const browserOpened = openBrowser(url);
  return { url, port, browserOpened, reused: false };
}

export async function refreshTokens(current: TokenSet): Promise<TokenSet> {
  const { clientId, clientSecret } = assertClientConfig();
  if (!current.refresh_token) throw new Error(t("runtime.missing_refresh_token"));
  const tr = await postToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
  });
  const next = toTokenSet(tr, current);
  saveTokens(next);
  return next;
}

/** Returns a valid access token; refreshes it when expiry is near (< 24 h). */
export async function getValidTokens(): Promise<TokenSet> {
  const tok = loadTokens();
  if (!tok) {
    const p = getPendingAuth();
    if (p?.status === "pending") throw new Error(t("runtime.auth_pending_in_browser"));
    throw new Error(t("runtime.not_signed_in"));
  }
  if (tok.expires_at - Date.now() < 24 * 3600 * 1000) {
    try {
      return await refreshTokens(tok);
    } catch (e) {
      if (tok.expires_at > Date.now()) return tok; // still valid, try with it
      throw e;
    }
  }
  return tok;
}

export async function logout(revokeRemote: boolean): Promise<{ revoked: boolean }> {
  const tok = loadTokens();
  let revoked = false;
  if (tok && revokeRemote) {
    try {
      const res = await fetch(config.deauthorizeUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tok.access_token }).toString(),
      });
      revoked = res.ok;
    } catch {
      revoked = false;
    }
  }
  clearTokens();
  if (pending) closePending("expired", t("runtime.signed_out"));
  return { revoked };
}
