/**
 * HTTP client for Clio API v4: bearer token, automatic refresh on 401,
 * respects X-RateLimit-* and Retry-After, readable errors.
 */
import { config } from "./config.js";
import { t } from "./i18n.js";
import { getValidTokens, refreshTokens } from "./oauth.js";
import { loadTokens, saveTokens } from "./store.js";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiResult<T = unknown> {
  status: number;
  data: T;
  rateLimit?: { limit?: number; remaining?: number; reset?: number };
  etag?: string;
}

export class ClioApiError extends Error {
  constructor(public status: number, public type: string | undefined, message: string, public body?: unknown) {
    super(message);
  }
}

let rateState = { remaining: Infinity, resetAt: 0 };

async function waitForRateLimit(): Promise<void> {
  if (rateState.remaining <= 1 && rateState.resetAt > Date.now()) {
    await new Promise((r) => setTimeout(r, Math.min(rateState.resetAt - Date.now() + 250, 65000)));
  }
}

/** Simple queue: at most 2 concurrent requests to Clio so that bulk operations stay under 50/min. */
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  return () => {
    active--;
    waiting.shift()?.();
  };
}

export function rateLimitSnapshot() {
  return { remaining: Number.isFinite(rateState.remaining) ? rateState.remaining : undefined, reset_at: rateState.resetAt ? new Date(rateState.resetAt).toISOString() : undefined };
}

function readRate(res: Response) {
  const limit = Number(res.headers.get("X-RateLimit-Limit"));
  const remaining = Number(res.headers.get("X-RateLimit-Remaining"));
  const reset = Number(res.headers.get("X-RateLimit-Reset"));
  if (Number.isFinite(remaining)) rateState.remaining = remaining;
  if (Number.isFinite(reset) && reset > 0) rateState.resetAt = reset * 1000;
  return {
    limit: Number.isFinite(limit) ? limit : undefined,
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    reset: Number.isFinite(reset) ? reset : undefined,
  };
}

function explain(status: number, body: any): string {
  const type = body?.error?.type;
  const msg = body?.error?.message ?? JSON.stringify(body)?.slice(0, 300);
  switch (status) {
    case 400:
      return t("runtime.http_400", { msg });
    case 401:
      return t("runtime.http_401", { msg });
    case 403:
      return t("runtime.http_403", { type: type ?? "", msg });
    case 404:
      return t("runtime.http_404", { msg });
    case 422:
      return t("runtime.http_422", { type: type ?? "", msg });
    case 429:
      return t("runtime.http_429", { msg });
    default:
      return t("runtime.http_other", { status, msg });
  }
}

/**
 * Generic API call. `path` is relative to /api/v4 (e.g. "/users/who_am_i") or an absolute URL
 * (e.g. meta.paging.next). `query` is appended to the URL; `body` is sent as JSON {"data": ...}
 * unless it is already wrapped.
 */
export async function apiRequest<T = unknown>(
  method: Method,
  path: string,
  opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; raw?: boolean; headers?: Record<string, string> } = {}
): Promise<ApiResult<T>> {
  // Hard guard: this connector never deletes anything in Clio (see README – Safety model).
  if (String(method).toUpperCase() === "DELETE") throw new Error(t("runtime.delete_not_permitted"));
  let tokens = await getValidTokens();
  const url = new URL(path.startsWith("http") ? path : `${config.apiBase}${path.startsWith("/") ? "" : "/"}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const doFetch = async (accessToken: string) => {
    await waitForRateLimit();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": `${config.name}/${config.version}`,
      ...(opts.headers ?? {}),
    };
    if (config.apiVersion) headers["X-API-VERSION"] = config.apiVersion;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      const b = opts.body as any;
      body = JSON.stringify(b && typeof b === "object" && "data" in b ? b : { data: b });
    }
    return fetch(url, { method, headers, body, redirect: opts.raw ? "manual" : "follow" });
  };

  const release = await acquire();
  let res: Response;
  try {
    res = await doFetch(tokens.access_token);
    if (res.status === 401) {
      tokens = await refreshTokens(loadTokens() ?? tokens);
      res = await doFetch(tokens.access_token);
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After")) || 5;
      await new Promise((r) => setTimeout(r, Math.min(retry, 60) * 1000));
      res = await doFetch(tokens.access_token);
    }
  } finally {
    release();
  }

  const rateLimit = readRate(res);
  const etag = res.headers.get("ETag") ?? undefined;

  if (opts.raw) {
    return { status: res.status, data: { location: res.headers.get("Location"), headers: Object.fromEntries(res.headers) } as T, rateLimit, etag };
  }

  const text = await res.text();
  let data: any = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 2000) };
    }
  }
  if (!res.ok) {
    throw new ClioApiError(res.status, data?.error?.type, explain(res.status, data), data);
  }
  return { status: res.status, data: data as T, rateLimit, etag };
}

export interface ListResult<T> {
  data: T[];
  records?: number;
  next_page_token?: string;
  has_more: boolean;
  rate_limit?: ApiResult["rateLimit"];
}

/** One page of a list; also returns the page_token for continuing (meta.paging.next). */
export async function apiList<T = Record<string, unknown>>(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  opts: { page_token?: string } = {}
): Promise<ListResult<T>> {
  const q = { ...query, ...(opts.page_token ? { page_token: opts.page_token } : {}) };
  const r = await apiRequest<{ data: T[]; meta?: { paging?: { next?: string }; records?: number } }>("GET", path, { query: q });
  const next = r.data?.meta?.paging?.next;
  let token: string | undefined;
  if (next) {
    try {
      token = new URL(next).searchParams.get("page_token") ?? undefined;
    } catch {
      token = undefined;
    }
  }
  return { data: r.data?.data ?? [], records: r.data?.meta?.records, next_page_token: token, has_more: Boolean(next), rate_limit: r.rateLimit };
}

/** Walks all pages (cursor, order=id(asc)) up to maxRecords. */
export async function apiListAll<T = Record<string, unknown>>(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  maxRecords = 1000
): Promise<{ data: T[]; truncated: boolean; records?: number }> {
  const out: T[] = [];
  let token: string | undefined;
  let records: number | undefined;
  for (;;) {
    const page = await apiList<T>(path, { ...query, order: query.order ?? "id(asc)", limit: query.limit ?? 200 }, { page_token: token });
    out.push(...page.data);
    records = page.records ?? records;
    if (!page.has_more) return { data: out, truncated: false, records };
    if (out.length >= maxRecords) return { data: out.slice(0, maxRecords), truncated: true, records };
    token = page.next_page_token;
  }
}

/** Stores the user's identity alongside the tokens (for the audit log). */
export function rememberUser(user: { id: number; name?: string; email?: string }) {
  const tok = loadTokens();
  if (tok) saveTokens({ ...tok, user });
}
