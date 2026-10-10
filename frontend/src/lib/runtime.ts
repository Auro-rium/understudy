/**
 * Runtime configuration, resolved in the browser so the tunnel URL / demo key can change
 * without a rebuild.
 *
 *   API base URL:  ?api=<url>  ->  saved (localStorage)  ->  NEXT_PUBLIC_API_URL  ->  http://127.0.0.1:8000
 *   Demo key:      ?key=<key>  ->  saved (localStorage)
 *
 * A value from the query string is persisted, then removed from the visible address bar
 * (cleanAddressBar) so the key is not left in the URL or in screenshots. Every storage
 * access is wrapped in try/catch: with storage blocked the page still works for the
 * current load (and the params stay in the URL, so a reload keeps working).
 * On the server (SSR / static build) there is no window: the env value is used, and the
 * browser re-resolves on its first call.
 */

export const DEFAULT_API_URL = "http://127.0.0.1:8000";

const API_STORAGE_KEY = "understudy.api.v1";
const DEMO_KEY_STORAGE_KEY = "understudy.demokey.v1";

interface Resolved {
  api: string;
  key: string | null;
  /** query params that were present and are now safely persisted (safe to strip from the address bar) */
  strip: { api: boolean; key: boolean };
}

let resolved: Resolved | null = null;

/** Accepts only http(s) URLs. Returns origin + path without a trailing slash, query or hash; null otherwise. */
export function sanitizeApiUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function sanitizeKey(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  // header-safe: visible ASCII only, bounded length
  return v && v.length <= 256 && /^[\x21-\x7e]+$/.test(v) ? v : null;
}

function readStore(name: string): string | null {
  try {
    return window.localStorage.getItem(name);
  } catch {
    return null;
  }
}

/** true when the value was written (or removed) successfully */
function writeStore(name: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, value);
    return true;
  } catch {
    return false;
  }
}

function envApiUrl(): string {
  return sanitizeApiUrl(process.env.NEXT_PUBLIC_API_URL) ?? DEFAULT_API_URL;
}

function resolve(): Resolved {
  let query: URLSearchParams | null = null;
  try {
    query = new URLSearchParams(window.location.search);
  } catch {
    query = null;
  }

  const strip = { api: false, key: false };

  let api: string | null = null;
  const qApi = query?.get("api");
  if (qApi !== null && qApi !== undefined) {
    if (qApi.trim() === "") {
      // "?api=" with no value clears the saved override
      strip.api = writeStore(API_STORAGE_KEY, null);
    } else {
      api = sanitizeApiUrl(qApi);
      // an invalid value is ignored (not saved) but still removed from the address bar
      strip.api = api ? writeStore(API_STORAGE_KEY, api) : true;
    }
  }
  if (!api) api = sanitizeApiUrl(readStore(API_STORAGE_KEY));

  let key: string | null = null;
  const qKey = query?.get("key");
  if (qKey !== null && qKey !== undefined) {
    if (qKey.trim() === "") {
      strip.key = writeStore(DEMO_KEY_STORAGE_KEY, null);
    } else {
      key = sanitizeKey(qKey);
      strip.key = key ? writeStore(DEMO_KEY_STORAGE_KEY, key) : true;
    }
  }
  if (!key) key = sanitizeKey(readStore(DEMO_KEY_STORAGE_KEY));

  return { api: api ?? envApiUrl(), key, strip };
}

function current(): Resolved | null {
  if (typeof window === "undefined") return null;
  if (!resolved) resolved = resolve();
  return resolved;
}

/** Base URL of the backend, no trailing slash. */
export function getApiUrl(): string {
  return current()?.api ?? envApiUrl();
}

/** Demo key to send as X-Demo-Key on mutating requests; null when none is known. */
export function getDemoKey(): string | null {
  return current()?.key ?? null;
}

/** "host[:port]" of the API for display, e.g. "abc.trycloudflare.com" or "127.0.0.1:8000". */
export function getApiHost(): string {
  try {
    return new URL(getApiUrl()).host;
  } catch {
    return getApiUrl();
  }
}

/**
 * Removes ?api and ?key from the address bar once they are persisted (history.replaceState,
 * no navigation, other params and the hash are kept). Call from an effect, not during render.
 */
export function cleanAddressBar(): void {
  const r = current();
  if (!r) return;
  try {
    const u = new URL(window.location.href);
    let changed = false;
    if (r.strip.api && u.searchParams.has("api")) {
      u.searchParams.delete("api");
      changed = true;
    }
    if (r.strip.key && u.searchParams.has("key")) {
      u.searchParams.delete("key");
      changed = true;
    }
    if (changed) window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
  } catch {
    /* leave the URL as is */
  }
}

/* useSyncExternalStore helpers: the host is "" on the server and for the first client render (no hydration mismatch). */
export function subscribeRuntime(): () => void {
  return () => undefined;
}
export function serverApiHost(): string {
  return "";
}
