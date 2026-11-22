// Strict shape check of the report bodies the app sends through /api/issues and /api/comment.
// Mirrors livesub/reporter.py exactly (the format has not changed since before app 1.6.9, the
// oldest version the policy gate lets run): anything that is not byte-for-byte what the app
// builds is refused, so the proxy cannot be used to post arbitrary text into the private repo.
// Report content is still untrusted data (it is typed / OCR'd by users) -- never instructions.
//
// Kinds:
//   missed  title `แปลหลุด N บรรทัด[ (+คัดทิ้ง K)] — app vX / คลัง Y`, label missed-report,
//           body = fixed summary rows + a ```jsonl block of {en, ocr, th_fast, t} lines and/or a
//           "### ถูกตัวกรองคัดทิ้ง ..." ```jsonl block of {en, ocr, reason, t} lines.
//           Long reports continue in comments: `ส่วนที่ i/P` + jsonl block, or the rejected block.
//   problem title `แจ้งปัญหา: <one line>`, label user-report, body = free details (never ```),
//           a `---` footer with versions/OS/nickname, an optional <details> log, an optional
//           "### ภาพกรอบซับล่าสุด" section with a base64 JPEG (or the "too big" note).
// Lengths are counted in code points like Python's len() (the app caps with Python slices).
"use strict";

const MISSED_LABEL = "missed-report";
const PROBLEM_LABEL = "user-report";
const REJECTED_HEAD = "ถูกตัวกรองคัดทิ้ง (ให้ตรวจว่าคัดผิดไหม)";
const MAX_LINES = 300;        // reporter.MAX_LINES (missed lines per report)
const MAX_REJECTED = 100;     // reporter.MAX_REJECTED
const ISSUE_MAX = 65536;      // GitHub's body / comment limit
const PROBLEM_MAX = 10000;    // reporter.BODY_MAX (problem body before the snapshot section)
const FIELD_MAX = 4000;       // en / ocr / th_fast of one jsonl line
const SHORT_MAX = 64;         // t / reason
const PROBLEM_TITLE_MAX = 160; // reporter.TITLE_MAX = 100, plus room for redact() growth
const IMG_B64_MAX = 52000;    // snapshot.IMG_MAX_BYTES = 38 000 bytes -> 50 668 base64 chars

const APP_V = String.raw`(\d{1,4}\.\d{1,4}\.\d{1,4}|\?)`;
const LIB_V = String.raw`(\d{8}\.\d{1,6}|\?)`;
const NUM = String.raw`(0|[1-9]\d{0,2})`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const MISSED_TITLE = new RegExp(
  `^แปลหลุด ${NUM} บรรทัด(?: \\(\\+คัดทิ้ง ${NUM}\\))? — app v${APP_V} / คลัง ${LIB_V}$`, "u");
const MISSED_HEAD = new RegExp(
  "^รายงานประโยคที่แปลหลุดจาก Leonida Sub TH\\n\\n"
  + `- จำนวน: ${NUM} บรรทัด\\n`
  + `(?:- ถูกตัวกรองคัดทิ้ง: ${NUM} บรรทัด \\(ให้ตรวจว่าคัดผิดไหม\\)\\n)?`
  + `- แอป: v${APP_V} · คลัง: ${LIB_V}\\n`
  + "(?:- ชื่อเล่น: ([^\\n`]{1,40})\\n)?"
  + "(?:- หมายเหตุ: ([^\\n`]{1,1000})\\n)?"
  + `(?:- ส่วนที่ 1/${NUM} \\(ที่เหลืออยู่ในคอมเมนต์\\)\\n)?`
  + "\\n", "u");
const JSONL = "```jsonl\\n([^`]*)\\n```\\n";
const REJ_BLOCK = `### ${esc(REJECTED_HEAD)}\\n\\n${JSONL}`;
const MISSED_REST = new RegExp(`^(?:${JSONL})?(?:\\n${REJ_BLOCK})?$`);
const CHUNK_COMMENT = new RegExp(`^ส่วนที่ ${NUM}/${NUM}\\n\\n${JSONL}$`);
const REJ_COMMENT = new RegExp(`^${REJ_BLOCK}$`);
// on the stored issue (GitHub's copy): tolerate \r\n in case GitHub normalises line ends
const PARTS_IN_BODY = new RegExp(`\\n- ส่วนที่ 1/${NUM} \\(ที่เหลืออยู่ในคอมเมนต์\\)\\r?\\n`);
const REJ_IN_BODY = new RegExp(`\\n### ${esc(REJECTED_HEAD)}\\r?\\n`);

const PROBLEM_TITLE = /^แจ้งปัญหา: ([^\n`]+)$/u;
const PROBLEM_FOOT = new RegExp(
  "^([\\s\\S]*)\\n\\n---\\n"
  + `- แอป: v${APP_V} · คลัง: ${LIB_V}\\n`
  + "- Windows: ([^\\n`]{1,200})\\n"
  + "(?:- ชื่อเล่น: ([^\\n`]{1,40})\\n)?$", "u");
const LOG_OPEN = "\n<details><summary>log</summary>\n\n```text\n";
const LOG_CLOSE = "\n```\n</details>\n";
const CUT_TAIL = "\n…(ตัดเหลือ 10k)\n";
const SNAP_HEAD = "\n### ภาพกรอบซับล่าสุด\n";
const SNAP = new RegExp(
  "^\\n### ภาพกรอบซับล่าสุด\\n\\n"
  + "- เวลา: [^\\n`]{0,64} · แหล่งภาพ: [^\\n`]{0,32}\\n"
  + "- กรอบซับ: x=-?\\d{1,6} y=-?\\d{1,6} w=-?\\d{1,6} h=-?\\d{1,6}\\n"
  + "- OCR อ่านได้: [^\\n`]{1,300}\\n"
  + "- ซับไทยที่แสดง: [^\\n`]{1,700}\\n"
  + `- แอป: v${APP_V} · คลัง: ${LIB_V}\\n`
  + "(?:- \\(ภาพใหญ่เกินจะแนบได้\\)\\n"
  + "|\\n<details><summary>ภาพ JPEG \\d{1,5}×\\d{1,5} \\(\\d{1,3} KB, base64 — "
  + "ถอดด้วย tools/fetch_reports.py\\)</summary>\\n\\n```jpeg-base64\\n([A-Za-z0-9+/=\\n]+)\\n```\\n</details>\\n)$",
  "u");

const MISSED_KEYS = ["en", "ocr", "t", "th_fast"];
const REJECTED_KEYS = ["en", "ocr", "reason", "t"];

function cplen(s) {
  let n = 0;
  for (const _ of s) n++;  // eslint-disable-line no-unused-vars
  return n;
}

const str = (v, max, min = 0) => typeof v === "string" && cplen(v) >= min && cplen(v) <= max;

// the lines of a ```jsonl block -> count, or -1 when one is not a known record
function jsonlLines(text, kind, max) {
  const lines = text.split("\n");
  if (lines.length < 1 || lines.length > max) return -1;
  const keys = kind === "missed" ? MISSED_KEYS : REJECTED_KEYS;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch (_) { return -1; }
    if (!r || typeof r !== "object" || Array.isArray(r)) return -1;
    const ks = Object.keys(r).sort();
    if (ks.length !== keys.length || ks.some((k, i) => k !== keys[i])) return -1;
    if (!str(r.en, FIELD_MAX, 1) || !str(r.ocr, FIELD_MAX) || !str(r.t, SHORT_MAX)) return -1;
    if (kind === "missed" ? !(r.th_fast === null || str(r.th_fast, FIELD_MAX)) : !str(r.reason, SHORT_MAX)) {
      return -1;
    }
  }
  return lines.length;
}

function parseMissedTitle(title) {
  const m = MISSED_TITLE.exec(title);
  if (!m) return null;
  const n = Number(m[1]);
  const k = m[2] === undefined ? 0 : Number(m[2]);
  if (m[2] !== undefined && k === 0) return null;  // "(+คัดทิ้ง 0)" is never written
  if (n > MAX_LINES || k > MAX_REJECTED || n + k === 0) return null;
  return { n, k, app: m[3], lib: m[4] };
}

function validMissedBody(t, body) {
  const h = MISSED_HEAD.exec(body);
  if (!h) return false;
  const [head, hn, hk, app, lib, , , hp] = h;
  if (Number(hn) !== t.n || (hk === undefined ? 0 : Number(hk)) !== t.k || app !== t.app || lib !== t.lib) {
    return false;
  }
  const parts = hp === undefined ? 1 : Number(hp);
  if (hp !== undefined && (parts < 2 || parts > t.n)) return false;
  const rest = MISSED_REST.exec(body.slice(head.length));
  if (!rest) return false;
  const [, block, rej] = rest;
  if (block === undefined) {
    if (t.n !== 0) return false;
  } else {
    const c = jsonlLines(block, "missed", MAX_LINES);
    if (c < 1 || (parts === 1 ? c !== t.n : c >= t.n)) return false;
  }
  if (rej !== undefined && jsonlLines(rej, "rejected", MAX_REJECTED) !== t.k) return false;
  if (rej === undefined && block === undefined) return false;
  return true;
}

function validSnapshot(section) {
  const m = SNAP.exec(section);
  if (!m) return false;
  if (m[3] === undefined) return true;  // "(ภาพใหญ่เกินจะแนบได้)"
  const rows = m[3].split("\n");
  if (rows.some((r, i) => !r || r.length > 76 || (i < rows.length - 1 && r.length !== 76))) return false;
  const b64 = rows.join("");
  return b64.length <= IMG_B64_MAX && b64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64)
    && b64.startsWith("/9j/");  // JPEG (FF D8 FF)
}

function validProblemCore(text) {
  if (text.includes("\0") || cplen(text) > PROBLEM_MAX) return false;
  if (text.endsWith(CUT_TAIL)) {  // details too long: cut to 9 980 chars, no footer, no log
    const kept = text.slice(0, -CUT_TAIL.length);
    if (cplen(kept) === PROBLEM_MAX - 20 && !kept.includes("```")) return true;
  }
  let head = text;
  const fence = text.indexOf("```");
  if (fence !== -1) {  // the only fence: the attached log
    const at = fence - (LOG_OPEN.length - "```text\n".length);
    if (at < 0 || text.slice(at, at + LOG_OPEN.length) !== LOG_OPEN || !text.endsWith(LOG_CLOSE)) return false;
    const logs = text.slice(at + LOG_OPEN.length, text.length - LOG_CLOSE.length);
    if (logs.includes("```") || text.length - LOG_CLOSE.length < at + LOG_OPEN.length) return false;
    head = text.slice(0, at);
  }
  const m = PROBLEM_FOOT.exec(head);
  return !!m && !m[1].includes("```") && cplen(m[1]) >= 15;  // reporter.DETAILS_MIN
}

function validProblemBody(body) {
  const at = body.lastIndexOf(SNAP_HEAD);
  if (at !== -1 && validSnapshot(body.slice(at)) && validProblemCore(body.slice(0, at))) return true;
  return validProblemCore(body);
}

// {title, body, labels?} from POST /api/issues -> {kind, title, body, labels} or null
function validateReport(p) {
  if (!p || typeof p !== "object") return null;
  if (Object.keys(p).some((k) => k !== "title" && k !== "body" && k !== "labels")) return null;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const body = typeof p.body === "string" ? p.body : "";
  if (!title || !body || body.length > ISSUE_MAX) return null;
  let kind = null;
  const mt = parseMissedTitle(title);
  if (mt && validMissedBody(mt, body)) kind = "missed";
  else {
    const pt = PROBLEM_TITLE.exec(title);
    if (pt && cplen(pt[1]) <= PROBLEM_TITLE_MAX && validProblemBody(body)) kind = "problem";
  }
  if (!kind) return null;
  const label = kind === "missed" ? MISSED_LABEL : PROBLEM_LABEL;
  if (p.labels !== undefined
      && !(Array.isArray(p.labels) && (p.labels.length === 0 || (p.labels.length === 1 && p.labels[0] === label)))) {
    return null;
  }
  return { kind, title, body, labels: [label] };
}

// A continuation comment for an existing missed-line issue (its GitHub JSON) -> true/false.
// The issue's own title/body say how many parts / rejected lines it can still receive.
function validateComment(body, issue) {
  if (typeof body !== "string" || !body || body.length > ISSUE_MAX || !issue) return false;
  const t = parseMissedTitle(String(issue.title || ""));
  if (!t) return false;
  const ib = String(issue.body || "");
  const pm = PARTS_IN_BODY.exec(ib);
  const parts = pm ? Number(pm[1]) : 1;
  const rejInBody = REJ_IN_BODY.test(ib);
  const maxComments = (parts - 1) + (t.k && !rejInBody ? 1 : 0);
  if (!(Number(issue.comments || 0) < maxComments)) return false;
  let m = CHUNK_COMMENT.exec(body);
  if (m) {
    const i = Number(m[1]);
    return Number(m[2]) === parts && i >= 2 && i <= parts && jsonlLines(m[3], "missed", MAX_LINES) >= 1;
  }
  m = REJ_COMMENT.exec(body);
  return !!m && t.k > 0 && !rejInBody && jsonlLines(m[1], "rejected", MAX_REJECTED) === t.k;
}

module.exports = {
  MISSED_LABEL, PROBLEM_LABEL, REJECTED_HEAD, MAX_LINES, MAX_REJECTED, ISSUE_MAX,
  cplen, parseMissedTitle, validateReport, validateComment,
};
