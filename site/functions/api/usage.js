// GET /api/usage?key=<USAGE_KEY> -> anonymous usage aggregates from the D1 binding USAGE_DB
// (docs/usage-stats.md); 404 without the right key. Never cached.
// Cloudflare Pages Function; logic in ../_lib/gh.js (same code as Vercel's site/api/usage.js).
import { pagesHandler } from "../_lib/pages.js";

export const onRequest = pagesHandler("usage");
