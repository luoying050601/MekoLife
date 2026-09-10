export const API_BASE_SESSION_KEY = "mekolife:api_base";

export function isTryCloudflareHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}

/** Read `?api=` / `?socket=` once, store it, then remove query from URL. */
export function applyApiBaseQueryParam(): void {
  if (typeof window === "undefined") return;
  try {
    const u = new URL(window.location.href);
    const raw = u.searchParams.get("api") ?? u.searchParams.get("socket");
    if (raw?.trim()) {
      const cleaned = raw.trim().replace(/\/$/, "");
      if (isTryCloudflareHttpsUrl(cleaned)) {
        sessionStorage.setItem(API_BASE_SESSION_KEY, cleaned);
      }
    }
    if (u.searchParams.has("api") || u.searchParams.has("socket")) {
      u.searchParams.delete("api");
      u.searchParams.delete("socket");
      window.history.replaceState({}, "", u.pathname + u.search + u.hash);
    }
  } catch {
    // ignore
  }
}

export function clearStoredApiBase(): void {
  try {
    sessionStorage.removeItem(API_BASE_SESSION_KEY);
  } catch {
    // ignore
  }
}

function readSessionApiBase(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const v = sessionStorage.getItem(API_BASE_SESSION_KEY)?.trim();
    if (!v) return undefined;
    const cleaned = v.replace(/\/$/, "");
    return isTryCloudflareHttpsUrl(cleaned) ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

/** Detect wrong default in dual quick-tunnel setup (`front-host:3000`). */
export function isMisconfiguredTryCloudflareSocketBase(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  if (!host.endsWith(".trycloudflare.com")) return false;

  let base: URL;
  try {
    base = new URL(resolveApiServerBaseUrl());
  } catch {
    return false;
  }

  const page = new URL(window.location.href);
  return base.hostname === page.hostname && base.port === "3000";
}

/** Priority: localhost fixed -> session -> env -> same-origin (production). */
export function resolveApiServerBaseUrl(): string {
  if (typeof window !== "undefined") {
    const hn = window.location.hostname;
    if (hn === "localhost" || hn === "127.0.0.1") return "http://localhost:3000";
  }

  const fromSession = readSessionApiBase();
  if (fromSession) return fromSession;

  const socketUrl = (import.meta.env.VITE_SOCKET_URL as string | undefined)?.trim();
  if (socketUrl) return socketUrl.replace(/\/$/, "");

  const serverUrl = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim();
  if (serverUrl) return serverUrl.replace(/\/$/, "");

  if (typeof window === "undefined") return "http://localhost:3000";

  const { origin, hostname, protocol } = window.location;
  if (!hostname || protocol === "file:") return "http://localhost:3000";

  // Render / Fly.io: frontend and Socket.IO share the same origin (no :3000).
  return origin;
}