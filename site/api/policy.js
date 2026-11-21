// GET /api/policy -> {"min_app": "X.Y.Z"}: app versions below min_app must update
// before use (the app fails open when this cannot be reached). The value comes from
// the Vercel env var MIN_APP_VERSION, else DEFAULT_MIN_APP. No GitHub call, no token.
"use strict";
const { send } = require("./_gh");

const DEFAULT_MIN_APP = "1.6.9";
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

function minApp() {
  const v = String(process.env.MIN_APP_VERSION || "").trim();
  return VERSION.test(v) ? v : DEFAULT_MIN_APP;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { message: "GET only" });
  send(res, 200, { min_app: minApp() }, { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" });
};
module.exports.DEFAULT_MIN_APP = DEFAULT_MIN_APP;
