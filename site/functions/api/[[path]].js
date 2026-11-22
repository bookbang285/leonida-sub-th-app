// Any other /api/* path -> 404 JSON (more specific routes like /api/asset win over this
// catch-all). Without it Pages would fall through to static files and serve the Vercel
// sources under /api/*.js and index.html for unknown paths; on Vercel these are 404 too.
import { core, toResponse } from "../_lib/pages.js";

export function onRequest({ request }) {
  return toResponse(core.json(404, { message: "not found" }), request.method);
}
