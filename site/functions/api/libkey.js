// POST /api/libkey {v, g, l, pub, i?} -> the v3 library key wrapped to the device's X25519 key.
// Cloudflare Pages only (secrets LIBKEY_MASTER + LIBKEY_PEPPER, D1 table libkey): there is deliberately no
// Vercel wrapper in site/api, so /api/libkey on Vercel stays 404. Logic in ../_lib/gh.js.
import { pagesHandler } from "../_lib/pages.js";

export const onRequest = pagesHandler("libkey");
