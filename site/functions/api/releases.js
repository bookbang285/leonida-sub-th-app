// GET /api/releases -> library releases (lib-* tags), asset urls on this request's origin.
// Cloudflare Pages Function; logic in ../_lib/gh.js (same code as Vercel's site/api/releases.js).
// edgeCache: emulates Vercel's CDN s-maxage=300 with the Cache API (see ../_lib/pages.js).
import { pagesHandler } from "../_lib/pages.js";

export const onRequest = pagesHandler("releases", { edgeCache: true });
