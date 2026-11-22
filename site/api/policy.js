// GET /api/policy -> {"min_app": "X.Y.Z"}: app versions below min_app must update
// before use (the app fails open when this cannot be reached). The value comes from
// the env var MIN_APP_VERSION, else DEFAULT_MIN_APP (in ../functions/_lib/gh.js).
// No GitHub call, no token.
"use strict";
const core = require("../functions/_lib/gh.js");

module.exports = require("./_gh").vercelHandler("policy");
module.exports.DEFAULT_MIN_APP = core.DEFAULT_MIN_APP;
