// GET /api/policy -> {"min_app"} from env MIN_APP_VERSION (else DEFAULT_MIN_APP). No token.
// Cloudflare Pages Function; logic in ../_lib/gh.js (same code as Vercel's site/api/policy.js).
import { pagesHandler } from "../_lib/pages.js";

export const onRequest = pagesHandler("policy");
