// GET /api/asset?id=N -> 302 to GitHub's signed download URL (.lsxz library packs only).
// Cloudflare Pages Function; logic in ../_lib/gh.js (same code as Vercel's site/api/asset.js).
import { pagesHandler } from "../_lib/pages.js";

export const onRequest = pagesHandler("asset");
