// POST /api/issues {title, body, labels} -> report issue in the private repo.
// Cloudflare Pages Function; logic in ../_lib/gh.js (same code as Vercel's site/api/issues.js).
import { pagesHandler } from "../_lib/pages.js";

export const onRequest = pagesHandler("issues");
