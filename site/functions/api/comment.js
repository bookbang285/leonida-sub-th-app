// POST /api/comment?issue=N {body} -> continuation comment on a fresh missed-line report.
// Cloudflare Pages Function; logic in ../_lib/gh.js (same code as Vercel's site/api/comment.js).
import { pagesHandler } from "../_lib/pages.js";

export const onRequest = pagesHandler("comment");
