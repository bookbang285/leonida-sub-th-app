// Cloudflare Pages Functions adapter for the GitHub proxy (logic: ./gh.js, shared with Vercel's site/api).
// Maps a Pages `context` (Web Request + env) <-> the core's {status, headers, body}.
// Env (Pages project -> Settings -> Variables and Secrets): GH_TOKEN (secret), MIN_APP_VERSION.
import core from "./gh.js";

// vercel.json adds these to every response, functions included; Pages' _headers file only
// applies to static assets, so function responses get them here.
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// Origin for asset urls: the request's own host (never x-forwarded-host). Always https like
// the Vercel version, except for local `wrangler pages dev`.
export function baseUrl(request) {
  const u = new URL(request.url);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin;
  return `https://${u.host}`;
}

// CF-Connecting-IP is set by Cloudflare's edge (clients cannot forge it).
export function clientIp(request) {
  return String(request.headers.get("CF-Connecting-IP") || "").trim() || "?";
}

// Reads the body as text, counting characters like the Vercel version, and stops reading
// as soon as `limit` is passed (413) instead of buffering an arbitrary upload.
export async function readJson(request, limit) {
  let raw = "";
  if (request.body) {
    const reader = request.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      if (raw.length > limit) {
        reader.cancel().catch(() => {});
        throw core.httpError(413, "too large");
      }
    }
    raw += dec.decode();
  }
  return core.parseJsonObject(raw, limit);
}

function query(url, k) {
  // Vercel turns ?id=1&id=2 into "1,2" (then refused by the validators); do the same
  return url.searchParams.getAll(k).join(",");
}

export function toResponse(out, method) {
  const headers = new Headers(out.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  const body = method === "HEAD" || out.body === null || out.body === undefined ? null : out.body;
  return new Response(body, { status: out.status, headers });
}

// Pages Functions run in front of Cloudflare's CDN cache, so the `s-maxage` that Vercel's CDN
// honours does nothing on its own. `edgeCache` keeps successful GET responses in the colo's
// Cache API for their s-maxage (Cloudflare honours s-maxage on cache.put), so /api/releases
// does not hit GitHub on every app start. The Cache API is a no-op on *.pages.dev; it works
// on the custom domain.
async function cached(context, compute) {
  const { request } = context;
  const cache = request.method === "GET" && typeof caches !== "undefined" && caches.default;
  if (!cache) return compute();
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  try {
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch (_) { /* cache unavailable: fall through */ }
  const res = await compute();
  if (res.status === 200 && /s-maxage=\d+/.test(res.headers.get("Cache-Control") || "")) {
    const put = cache.put(key, res.clone()).catch(() => {});
    if (context.waitUntil) context.waitUntil(put);
  }
  return res;
}

// route name (key of core routes) -> Pages `onRequest` handler (all methods: the core
// answers 405 itself, exactly like the Vercel functions)
export function pagesHandler(route, { edgeCache = false } = {}) {
  return async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const run = async () => toResponse(await core.handle(route, {
      method: request.method,
      query: (k) => query(url, k),
      env: env || {},
      get ip() { return clientIp(request); },
      get base() { return baseUrl(request); },
      readJson: (limit) => readJson(request, limit),
    }), request.method);
    return edgeCache ? cached(context, run) : run();
  };
}

export { core };
