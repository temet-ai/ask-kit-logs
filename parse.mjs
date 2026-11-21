// What a log line says: its time, its level and its message, for each format the kit knows.
// Also here: the error signature (the same error with different details reads as one text) and
// the redaction of credentials. No file access in this module.

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const LEVEL_OF = new Map(
  Object.entries({
    trace: 0, finest: 0, finer: 0, silly: 0, verbose: 1, debug: 1, dbg: 1, fine: 1, timing: 1, config: 2, info: 2, inf: 2, information: 2,
    notice: 2, http: 2, log: 2, statement: 2, warn: 3, warning: 3, wrn: 3, err: 4, error: 4, severe: 4, crit: 5, critical: 5, fatal: 5,
    panic: 5, alert: 5, emerg: 5, emergency: 5,
  }),
);

/** A level in any spelling, or a number (pino 10 to 60, syslog 0 to 7), as an index into LEVELS; -1 when unknown. */
export function levelOf(v) {
  if (typeof v === "number") {
    if (v >= 10) return v >= 60 ? 5 : v >= 50 ? 4 : v >= 40 ? 3 : v >= 30 ? 2 : v >= 20 ? 1 : 0;
    return v <= 2 ? 5 : v === 3 ? 4 : v === 4 ? 3 : v <= 6 ? 2 : 1;
  }
  if (typeof v !== "string") return -1;
  const l = LEVEL_OF.get(v) ?? LEVEL_OF.get(v.trim().toLowerCase());
  return l ?? -1;
}

/** Words that mark an entry without a level as an error. */
export const ERR_WORD = /\b(error|errors|failed|failure|fatal|panic|panicked|exception|traceback|segfault|denied|refused|timed? ?out|out of memory|oom|killed|cannot|could not|unable to|critical|crit|emerg|abort(ed)?)\b/i;

// ---------------------------------------------------------------------------------------------
// Time

const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function zone(z, ctx) {
  if (!z) return ctx.offset;
  if (z === "Z" || z === "UTC" || z === "GMT") return 0;
  const sign = z[0] === "-" ? -1 : 1;
  const d = z.replace(/[^0-9]/g, "");
  return sign * ((+d.slice(0, 2)) * 60 + (+d.slice(2, 4) || 0)) * 60000;
}
const frac = (f) => (f ? Math.floor(+("0." + f) * 1000) : 0);

// Each reader is a sticky regex and a function from its match to epoch milliseconds.
const READERS = [
  {
    kind: "iso",
    re: /(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?(?:(Z|[+-]\d\d(?::?\d\d)?)(?![\w:])| (UTC|GMT|[+-]\d\d:?\d\d)(?![\w:]))?/y,
    ms: (m, ctx) => Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], frac(m[7])) - zone(m[8] || m[9], ctx),
  },
  {
    kind: "slash",
    re: /(\d{4})\/(\d\d)\/(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))?/y,
    ms: (m, ctx) => Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], frac(m[7])) - ctx.offset,
  },
  {
    kind: "clf",
    re: /(\d\d)\/([A-Z][a-z]{2})\/(\d{4}):(\d\d):(\d\d):(\d\d) ([+-]\d{4})/y,
    ms: (m, ctx) => Date.UTC(+m[3], MON[m[2]] ?? 0, +m[1], +m[4], +m[5], +m[6]) - zone(m[7], ctx),
  },
  {
    kind: "ctime",
    re: /(?:[A-Z][a-z]{2} )([A-Z][a-z]{2}) +(\d{1,2}) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,9}))? (?:[A-Z]{3,4} )?(\d{4})/y,
    ms: (m, ctx) => (m[1] in MON ? Date.UTC(+m[7], MON[m[1]], +m[2], +m[3], +m[4], +m[5], frac(m[6])) - ctx.offset : NaN),
  },
  {
    kind: "syslog",
    re: /([A-Z][a-z]{2}) +(\d{1,2}) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?/y,
    ms: (m, ctx) => {
      if (!(m[1] in MON)) return NaN;
      const mon = MON[m[1]];
      // No year in the line: the year of the file's modified time, or the one before when the month is later than that.
      const year = mon > ctx.month ? ctx.year - 1 : ctx.year;
      return Date.UTC(year, mon, +m[2], +m[3], +m[4], +m[5], frac(m[6])) - ctx.offset;
    },
  },
  {
    kind: "epoch",
    re: /(1\d{9})(?:[.,](\d{1,6})|(\d{3}))?(?!\d)/y,
    ms: (m) => +m[1] * 1000 + (m[3] ? +m[3] : frac(m[2])),
  },
];
const READER = Object.fromEntries(READERS.map((r) => [r.kind, r]));
const ANY_TIME = /\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d|\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d|\d\d\/[A-Z][a-z]{2}\/\d{4}:\d\d:\d\d:\d\d|[A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d/;

/** A fresh reading context for one file. year and month come from its modified time, offset from the setting. */
export function context({ mtime = Date.now(), offset = 0 } = {}) {
  const d = new Date(mtime);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), offset, kind: null, end: 0 };
}

/** The time written at `pos` in `line`, in epoch ms, or null. Sets ctx.end to where it stops. With ctx.kind only that kind is tried. */
export function timeAt(line, pos, ctx, only) {
  const kind = only ?? ctx.kind;
  if (kind) {
    const r = READER[kind];
    r.re.lastIndex = pos;
    const m = r.re.exec(line);
    if (!m) return null;
    const t = r.ms(m, ctx);
    if (Number.isNaN(t)) return null;
    ctx.end = r.re.lastIndex;
    return t;
  }
  for (const r of READERS) {
    if (r.kind === "epoch" && pos > 1) continue;
    r.re.lastIndex = pos;
    const m = r.re.exec(line);
    if (!m) continue;
    const t = r.ms(m, ctx);
    if (Number.isNaN(t)) continue;
    ctx.end = r.re.lastIndex;
    ctx.found = r.kind;
    return t;
  }
  return null;
}

/** A time value from a JSON or logfmt field: a number of seconds, ms, µs or ns since 1970, or text. */
export function timeOf(v, ctx) {
  if (typeof v === "number") return v < 1e11 ? Math.round(v * 1000) : v < 1e14 ? v : v < 1e17 ? Math.floor(v / 1000) : Math.floor(v / 1e6);
  if (typeof v !== "string" || v.length < 8) return null;
  // The usual case, "2026-11-08T21:00:03.123Z", read without a regex.
  if (v.length >= 20 && v.length <= 30 && v.charCodeAt(4) === 45 && v.charCodeAt(10) === 84 && v.charCodeAt(v.length - 1) === 90) {
    const c = (i) => v.charCodeAt(i) - 48;
    let ms = 0;
    if (v.charCodeAt(19) === 46) ms = c(20) * 100 + (v.length > 22 ? c(21) * 10 : 0) + (v.length > 23 ? c(22) : 0);
    const t = Date.UTC(c(0) * 1000 + c(1) * 100 + c(2) * 10 + c(3), c(5) * 10 + c(6) - 1, c(8) * 10 + c(9), c(11) * 10 + c(12), c(14) * 10 + c(15), c(17) * 10 + c(18), ms);
    if (!Number.isNaN(t)) return t;
  }
  const t = timeAt(v, 0, { ...ctx, kind: null });
  if (t != null) return t;
  if (/^\d{10,19}(\.\d+)?$/.test(v)) return timeOf(+v, ctx);
  const d = Date.parse(v);
  return Number.isNaN(d) ? null : d;
}

export const iso = (t) => (t == null ? null : new Date(t).toISOString().replace(/\.000Z$/, "Z"));

// ---------------------------------------------------------------------------------------------
// Redaction. What the investigator reads goes to a cloud model.

const SECRET_NAME = "(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|authorization|cookie|session[_-]?id|sessionid|signature)";
/** A cheap test: only lines that pass it are looked at more closely. */
export const SECRET_HINT = /pass|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authoriz|bearer|basic |cookie|session|signature|:\/\/[^\/\s:@]+:[^\/\s@]*@|-----BEGIN|eyJ[A-Za-z0-9]|gh[pousr]_|sk-|AKIA|xox[a-z]-|[\w.+-]@[\w-]+\.[A-Za-z]|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{3,4}|\b\d{15,16}\b/i;
const SECRET_KEY = new RegExp(`${SECRET_NAME}`, "i");
const R_PRIVATE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;
const R_HEADER = /\b((?:proxy-)?authorization|(?:set-)?cookie|x-api-key|x-auth-token)(\\?["']?\s*[:=]\s*\\?["']?)([^"'\\\r\n]*)/gi;
const R_SCHEME = /\b(Bearer|bearer|BEARER)\s+[A-Za-z0-9._~+\/=-]{6,}|\b(Basic|Token)\s+(?=[A-Za-z0-9+\/=._-]*[\d=])[A-Za-z0-9+\/=._-]{12,}/g;
const R_USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^\/\s:@"']*):([^\/\s@"']+)@/gi;
const R_PAIR = new RegExp(`((?:\\\\?["'])?[\\w.-]*${SECRET_NAME}[\\w-]*(?:\\\\?["'])?\\s*[=:]\\s*)(\\\\"[^"\\\\]*\\\\"|"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s&,;"'}\\])]+)`, "gi");
// Personal data: email addresses and payment card numbers (13 to 19 digits that pass the Luhn check).
const R_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g;
const R_CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
const R_SHAPES = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[a-z]-[A-Za-z0-9-]{10,}/g;

/** Text with the values of passwords, tokens, cookies and auth headers replaced by <redacted>, email addresses by <email> and card numbers by <card>. */
export function redact(s) {
  if (typeof s !== "string" || !SECRET_HINT.test(s)) return s;
  return s
    .replace(R_PRIVATE, "<redacted private key>")
    .replace(R_HEADER, (m, k, sep) => `${k}${sep}<redacted>`)
    .replace(R_SCHEME, (m, a, b) => `${a || b} <redacted>`)
    .replace(R_USERINFO, "$1:<redacted>@")
    .replace(R_PAIR, (m, k, v) => (v.startsWith("<redacted>") ? m : k + (v[0] === '"' ? '"<redacted>"' : v[0] === "'" ? "'<redacted>'" : v[0] === "\\" ? '\\"<redacted>\\"' : "<redacted>")))
    .replace(R_SHAPES, "<redacted>")
    .replace(R_EMAIL, "<email>")
    .replace(R_CARD, (m) => (luhn(m.replace(/[ -]/g, "")) ? "<card>" : m));
}

/** The same for a parsed JSON value, in place: fields named like credentials, and credentials inside any text. */
export function redactValue(v, depth = 0) {
  if (typeof v === "string") return redact(v);
  if (v === null || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = redactValue(v[i], depth + 1);
    return v;
  }
  for (const k of Object.keys(v)) v[k] = SECRET_KEY.test(k) && v[k] != null && typeof v[k] !== "boolean" ? "<redacted>" : redactValue(v[k], depth + 1);
  return v;
}

// ---------------------------------------------------------------------------------------------
// The error signature

// Tokens with digits that name a thing and are kept as they are.
const KEEP = new Set(
  "http2 http1 http3 h2 h2c h3 ipv4 ipv6 utf8 utf16 utf32 sha1 sha2 sha224 sha256 sha384 sha512 md5 md4 base64 base32 x86 x64 amd64 arm64 aarch64 i386 i686 s3 ec2 oauth2 oauth1 e2e i18n l10n a11y k8s k3s ed25519 x509 p50 p90 p95 p99 tls1 ssl3 v1 v2 v3 v4 v5 v6 win32 win64 crc32 log4j log4j2 slf4j neo4j py3 python3 python2 node22 node20 node18 es6 es2015 web3 mp3 mp4 3d 2d 2fa".split(" "),
);
const BEFORE_CODE = /(?:status|code|errno|exit(?:ed)?(?: with)?(?: code)?|signal|returned|http\/|response|sqlstate|rc|err(?:or)?)\s*[=:#(]?\s*$/i;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function tidyPath(p) {
  const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
  return p
    .split(/[\\/]/)
    .map((seg) => (seg === "" || (!/\d/.test(seg) && seg.length <= 40) ? seg : "<*>"))
    .join(sep);
}

/** A request path with its variable parts replaced: no query, and segments that hold digits become <*>. */
export function pathPattern(p) {
  if (typeof p !== "string") return String(p);
  const q = p.search(/[?#]/);
  const s = (q >= 0 ? p.slice(0, q) : p).slice(0, 200);
  return s.split("/").map((seg) => (/\d/.test(seg) || seg.length > 40 ? "<*>" : seg)).join("/") || "/";
}

/**
 * The same error with different details as one text: timestamps, UUIDs, addresses, quoted strings,
 * hex ids, durations, sizes, the variable parts of paths, and numbers become placeholders. Numbers
 * that name the error stay: a status or exit code after its word ("status 502", "exit code 137",
 * "errno 111") and codes such as E404 or TS2345.
 */
export function signature(text) {
  let s = String(text ?? "");
  const nl = s.indexOf("\n");
  if (nl >= 0) s = s.slice(0, nl);
  s = s.slice(0, 500).replace(ANSI, "");
  s = s
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d)?(?:[.,]\d+)?(?:Z|[+-]\d\d:?\d\d)?)?|\b\d{4}\/\d\d\/\d\d(?: \d\d:\d\d:\d\d(?:\.\d+)?)?|\b\d\d\/[A-Z][a-z]{2}\/\d{4}:\d\d:\d\d:\d\d(?: [+-]\d{4})?|\b\d\d:\d\d:\d\d(?:[.,]\d+)?\b/g, "<time>")
    .replace(/"(?:[^"\\]|\\.){0,300}"/g, '"<str>"')
    .replace(/(?<![\w])'[^'\n]{1,300}'(?![\w])/g, "'<str>'")
    .replace(/`[^`\n]{1,300}`/g, "`<str>`")
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "<email>")
    .replace(/\b([a-z][a-z0-9+.-]{1,12}:\/\/)([^\s"'<>,;)\]]+)/gi, (m, scheme, rest) => {
      const cut = rest.search(/[\/?#]/);
      const host = (cut < 0 ? rest : rest.slice(0, cut)).replace(/^[^@]*@/, "").replace(/:\d+$/, "");
      const p = cut < 0 || rest[cut] !== "/" ? "" : pathPattern(rest.slice(cut));
      return scheme + (/^[\d.]+$|:/.test(host) ? "<ip>" : host) + (p === "/" ? "" : p);
    })
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "<ip>")
    .replace(/(?<![\w:.<])(?=[0-9a-f:]*\d)(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:.>])/gi, "<ip>")
    .replace(/(?<![\w<>:])(?:[A-Za-z]:)?(?:[\\/][\w.@%+~-]+){2,}[\\/]?/g, tidyPath)
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b(?=[0-9a-f]*\d)(?=\d*[a-f])[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{20,}\b/g, "<id>")
    .replace(/\b\d+(?:\.\d+)?(?:ns|µs|us|ms|s|m|h|d)\b|\b\d+(?:\.\d+)? ?(?:nanoseconds?|microseconds?|milliseconds?|msecs?|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?)\b/g, "<dur>")
    .replace(/\b\d+(?:\.\d+)? ?(?:[KMGT]i?B|[kmg]b|bytes?)\b/g, "<size>")
    .replace(/\b((?:[A-Za-z][\w.-]*[_.-])?(?:id|uuid|guid|user|username|host|hostname|pid|tid|thread|session|trace|span|addr|peer|client|remote|ip|port|tenant|account|[a-z]+Id)\s*[=:]\s*)(?!<)("[^"]*"|[^\s,;)\]}]+)/g, "$1<*>")
    .replace(/[A-Za-z0-9]*\d[A-Za-z0-9]*(?:\.\d+)*/g, (tok, at, all) => {
      if (/^\d+(?:\.\d+)*$/.test(tok)) return tok.length <= 5 && BEFORE_CODE.test(all.slice(Math.max(0, at - 24), at)) ? tok : "<n>";
      if (KEEP.has(tok.toLowerCase()) || /^[A-Z]{1,8}\d{1,5}$/.test(tok)) return tok;
      return tok.replace(/\d+(?:\.\d+)*/g, "<n>");
    })
    .replace(/\s+/g, " ")
    .replace(/(?:<n>[, ]+){3,}<n>/g, "<n>, ...")
    .trim();
  return s.length > 240 ? s.slice(0, 240) + "…" : s;
}

/** The line of a stack trace that names the exception: the last line of a Python traceback, the first exception line otherwise. */
export function exceptionLine(extra) {
  if (!extra || !extra.length) return null;
  if (extra.some((l) => l.startsWith("Traceback (most recent call last)"))) {
    for (let i = extra.length - 1; i >= 0; i--) if (extra[i] && !/^\s/.test(extra[i]) && !extra[i].startsWith("Traceback")) return extra[i];
  }
  for (const l of extra) if (/^(?:Caused by: |Exception in thread "[^"]*" )?[\w.$]+(?:Exception|Error|Throwable)\b|^panic: |^(?:Uncaught |Unhandled )?\w*Error: |^thread '[^']*' panicked/.test(l)) return l;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Formats. A parser takes one line and returns an entry {t, level, msg, ...} or null, which means
// the line belongs to the entry above it.

const TIME_KEYS = ["time", "ts", "timestamp", "@timestamp", "t", "datetime", "date", "eventTime", "asctime", "created"];
const LEVEL_KEYS = ["level", "severity", "lvl", "levelname", "loglevel", "log.level", "log_level", "priority"];
const MSG_KEYS = ["msg", "message", "event", "text", "log", "textPayload", "body"];
const ERR_KEYS = ["err", "error", "exception", "exc_info", "stack", "stack_trace"];
const pick = (o, keys) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return k;
  return undefined;
};

function errText(v) {
  if (v == null || v === false) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const head = [v.type ?? v.name ?? v.code, v.message ?? v.msg].filter((x) => typeof x === "string" || typeof x === "number").join(": ");
    return head || JSON.stringify(v).slice(0, 300);
  }
  return String(v);
}

function jsonParser(ctx) {
  let tk, lk, mk, ek;
  return (line) => {
    if (line.charCodeAt(0) !== 123) {
      const s = line.trimStart();
      if (s.charCodeAt(0) !== 123) return null;
      line = s;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return null;
    }
    if (o === null || typeof o !== "object") return null;
    if (tk === undefined || o[tk] === undefined) tk = pick(o, TIME_KEYS);
    if (lk === undefined || o[lk] === undefined) lk = pick(o, LEVEL_KEYS);
    if (mk === undefined || o[mk] === undefined) mk = pick(o, MSG_KEYS);
    if (ek === undefined || o[ek] === undefined) ek = pick(o, ERR_KEYS);
    let level = lk === undefined ? (o.log && typeof o.log === "object" ? levelOf(o.log.level) : -1) : levelOf(o[lk]);
    const err = ek === undefined ? null : errText(o[ek]);
    let msg = mk === undefined ? null : o[mk];
    if (typeof msg !== "string") msg = msg == null ? null : typeof msg === "object" ? JSON.stringify(msg).slice(0, 500) : String(msg);
    if (level === -1 && err && ek !== "stack") level = 4;
    const e = { t: tk === undefined ? null : timeOf(o[tk], ctx), level, msg: msg == null ? err ?? "" : err && err !== msg ? `${msg}: ${err}` : msg, obj: o };
    if (ek !== undefined && o[ek] && typeof o[ek] === "object" && typeof o[ek].stack === "string") e.stack = o[ek].stack;
    else if (typeof o.stack === "string" && ek !== "stack") e.stack = o.stack;
    e.skip = [tk, lk, mk, ek];
    return e;
  };
}

const LOGFMT_PAIR = /([A-Za-z_@][\w.@\/-]*)=(?:"((?:[^"\\]|\\.)*)"|([^\s"]*))/g;
function logfmtParser(ctx) {
  return (line) => {
    if (line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9) return null;
    const o = {};
    let n = 0;
    LOGFMT_PAIR.lastIndex = 0;
    for (let m; (m = LOGFMT_PAIR.exec(line)); ) {
      o[m[1]] = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, "$1") : m[3];
      n++;
    }
    if (n < 2) return null;
    const tk = pick(o, TIME_KEYS), lk = pick(o, LEVEL_KEYS), mk = pick(o, MSG_KEYS), ek = pick(o, ERR_KEYS);
    if (tk === undefined && lk === undefined && mk === undefined) return null;
    let t = null;
    if (tk !== undefined) t = /^\d+(\.\d+)?$/.test(o[tk]) ? timeOf(+o[tk], ctx) : timeOf(o[tk], ctx);
    const err = ek === undefined ? null : o[ek];
    const msg = mk === undefined ? null : o[mk];
    let level = lk === undefined ? -1 : levelOf(o[lk]);
    if (level === -1 && err) level = 4;
    return { t, level, msg: msg == null ? err ?? line : err ? `${msg}: ${err}` : msg, obj: o, skip: [tk, lk, mk, ek] };
  };
}

// host ident user [time] "request" status bytes "referer" "agent" extras
const ACCESS = /^(\S+) (\S+) (\S+) \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+|-)(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?(.*)$/;
function accessParser(ctx) {
  return (line) => {
    const m = ACCESS.exec(line);
    if (!m) return null;
    const t = timeAt(m[4], 0, ctx, "clf");
    const req = m[5].split(" ");
    const status = +m[6];
    const o = { client: m[1], method: req.length > 1 ? req[0] : null, path: req.length > 1 ? req[1] : m[5], status, bytes: m[7] === "-" ? 0 : +m[7] };
    if (m[3] !== "-") o.user = m[3];
    if (m[8] && m[8] !== "-") o.referer = m[8];
    if (m[9]) o.agent = m[9];
    if (m[10]) {
      const rt = /(?:^|\s)(?:rt=|request_time=)?"?(\d+\.\d{1,6})"?(?=\s|$)/.exec(m[10]);
      if (rt) o.request_time = +rt[1];
    }
    return { t, level: status >= 500 ? 4 : status >= 400 ? 3 : 2, msg: `${m[5]} ${status} ${m[7]}${o.request_time != null ? ` ${o.request_time}s` : ""} from ${m[1]}`, obj: o, access: true };
  };
}

const SYSLOG5424 = /^<(\d{1,3})>1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[(?:[^\]\\]|\\.)*\](?:\[(?:[^\]\\]|\\.)*\])*) ?(.*)$/;
function syslog5424Parser(ctx) {
  return (line) => {
    const m = SYSLOG5424.exec(line);
    if (!m) return null;
    const o = { host: m[3], app: m[4] };
    if (m[5] !== "-") o.pid = m[5];
    if (m[6] !== "-") o.msgid = m[6];
    return { t: timeOf(m[2], ctx), level: levelOf(+m[1] & 7), msg: m[8].replace(/^\uFEFF/, ""), obj: o };
  };
}

const UPPER_LEVEL = /(?:^|[\s\[<(|=:\/-])(TRACE|DEBUG|DBG|INFO|INF|NOTICE|WARN|WARNING|WRN|ERROR|ERR|CRITICAL|CRIT|FATAL|PANIC|SEVERE|ALERT|EMERG|LOG|STATEMENT)(?=$|[\s\]>)|:,\/-])/;
const LOWER_LEVEL = /^[\[<(]?(trace|debug|info|notice|warn|warning|error|err|crit|critical|fatal|panic|alert|emerg|verbose|silly)[\]>)]?(?=[\s:|]|$)|[\[<(](trace|debug|info|notice|warn|warning|error|err|crit|critical|fatal|panic|alert|emerg)[\]>)]|\blevel=(\w+)/i;
const HEAD_LEVEL = /^[\[<(]?(?:TRACE|DEBUG|DBG|INFO|INF|NOTICE|WARN|WARNING|WRN|ERROR|ERR|CRITICAL|CRIT|FATAL|PANIC|SEVERE|ALERT|EMERG|trace|debug|info|notice|warn|warning|error|err|crit|critical|fatal|panic)[\]>)]?[\s:|-]+/;

function levelIn(rest) {
  const head = rest.length > 96 ? rest.slice(0, 96) : rest;
  let m = UPPER_LEVEL.exec(head);
  if (m) return levelOf(m[1].toLowerCase());
  m = LOWER_LEVEL.exec(head);
  if (m) return levelOf((m[1] || m[2] || m[3]).toLowerCase());
  return -1;
}

const SYSLOG_TAG = /^(\S+) ([^\s:\[]+)(?:\[(\d+)\])?: ?(.*)$/;
function syslogParser(ctx) {
  return (line) => {
    let p = 0;
    let pri = -1;
    if (line.charCodeAt(0) === 60) {
      const close = line.indexOf(">");
      if (close > 0 && close < 5) {
        pri = +line.slice(1, close) & 7;
        p = close + 1;
      }
    }
    const t = timeAt(line, p, ctx);
    if (t == null) return null;
    const rest = line.slice(ctx.end + 1);
    const m = SYSLOG_TAG.exec(rest);
    if (!m) return { t, level: pri >= 0 ? levelOf(pri) : levelIn(rest), msg: rest };
    const o = { host: m[1], app: m[2] };
    if (m[3]) o.pid = m[3];
    return { t, level: pri >= 0 ? levelOf(pri) : levelIn(m[4]), msg: m[4], obj: o };
  };
}

// A line that starts with a time (or holds one near its start, when loose), then anything.
function textParser(ctx, loose) {
  return (line) => {
    const c = line.charCodeAt(0);
    if (c === 32 || c === 9 || Number.isNaN(c)) return null;
    let t = timeAt(line, c === 91 ? 1 : 0, ctx);
    let before = "";
    if (t == null) {
      if (!loose) return null;
      const m = ANY_TIME.exec(line.length > 80 ? line.slice(0, 80) : line);
      if (!m) return null;
      t = timeAt(line, m.index, ctx);
      if (t == null) return null;
      before = line.slice(0, m.index).replace(/[\s\[(:-]+$/, "");
    }
    let rest = line.slice(ctx.end).replace(/^[\]\s:|,-]+/, "");
    const level = levelIn(rest);
    rest = rest.replace(HEAD_LEVEL, "");
    return { t, level, msg: before ? `${before}: ${rest}` : rest };
  };
}

const PY_BASIC = /^(DEBUG|INFO|WARNING|ERROR|CRITICAL):([^:\s]*):(.*)$/;
const NPM = /^(\d+) (silly|verbose|info|timing|http|notice|warn|error) (.*)$/;
function pyBasicParser() {
  return (line) => {
    const m = PY_BASIC.exec(line);
    return m ? { t: null, level: levelOf(m[1].toLowerCase()), msg: `${m[2]}: ${m[3]}` } : null;
  };
}
function npmParser() {
  return (line) => {
    const m = NPM.exec(line);
    return m ? { t: null, level: levelOf(m[2]), msg: m[3] } : null;
  };
}
// No time and no known shape: every line that does not start with a space is an entry.
function plainParser() {
  return (line) => {
    const c = line.charCodeAt(0);
    if (c === 32 || c === 9 || Number.isNaN(c)) return null;
    return { t: null, level: levelIn(line), msg: line };
  };
}

function flavour(lines, kind) {
  const all = lines.join("\n");
  if (/^Traceback \(most recent call last\)|^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} /m.test(all)) return "python logging";
  if (/^\s+at [\w.$<>]+\([\w.]+(?::\d+)?\)|^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[.,]\d{3} +(?:\[[^\]]+\] +)?[A-Z]+ +(?:\d+ --- )?\[?[\w.$-]+\]? [-:] /m.test(all)) return "java, log4j style";
  if (kind === "slash" && /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d \[\w+\] \d+#\d+: /m.test(all)) return "nginx error log";
  if (kind === "slash") return "go log";
  if (/^\d{4}-\d\d-\d\dT[\d:.]+Z +[A-Z]+ +[\w:]+(?:\{[^}]*\})?: /m.test(all)) return "rust tracing";
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)? \w+ \[\d+\] /m.test(all)) return "postgresql";
  if (kind === "ctime") return "apache error log style";
  if (kind === "epoch") return "epoch time";
  return "timestamp, then anything";
}

/**
 * The format of a log from its first lines. Returns {format, label, timed, make(ctx)}: make gives
 * the line parser for one reading of the file.
 */
export function detect(lines, ctx) {
  const sample = lines.filter((l) => l.trim() !== "").slice(0, 200);
  const n = sample.length;
  if (!n) return { format: "empty", label: "nothing readable in the first 64 KB (empty, or no line breaks)", timed: false, make: () => plainParser() };
  const share = (test) => sample.reduce((a, l) => a + (test(l) ? 1 : 0), 0) / n;
  const half = (test) => share(test) >= 0.5;

  const probe = { ...ctx, kind: null };
  const jp = jsonParser(probe);
  if (half((l) => jp(l) !== null)) return { format: "json", label: "JSON lines", timed: sample.some((l) => jp(l)?.t != null), make: (c) => jsonParser(c) };
  if (half((l) => ACCESS.test(l))) {
    const combined = sample.some((l) => ACCESS.exec(l)?.[9] !== undefined);
    return { format: "access", label: combined ? "web access log, combined" : "web access log, common", timed: true, make: (c) => accessParser(c) };
  }
  if (half((l) => SYSLOG5424.test(l))) return { format: "syslog", label: "syslog, RFC 5424", timed: true, make: (c) => syslog5424Parser(c) };
  const lp = logfmtParser(probe);
  if (half((l) => /^[A-Za-z_@][\w.@-]*=/.test(l) && lp(l) !== null)) return { format: "logfmt", label: "logfmt", timed: sample.some((l) => lp(l)?.t != null), make: (c) => logfmtParser(c) };

  // The kind of time most lines start with.
  const counts = {};
  let first = null;
  for (const l of sample) {
    const p = l.charCodeAt(0) === 91 ? 1 : l.charCodeAt(0) === 60 && l.indexOf(">") < 5 ? l.indexOf(">") + 1 : 0;
    probe.found = null;
    if (timeAt(l, p, probe) != null) {
      counts[probe.found] = (counts[probe.found] ?? 0) + 1;
      first ??= probe.found;
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (best && (best[1] / n >= 0.2 || best[0] === first)) {
    const kind = best[0];
    const withKind = (c) => Object.assign(c, { kind });
    if (kind === "syslog") return { format: "syslog", label: "syslog, RFC 3164", timed: true, make: (c) => syslogParser(withKind(c)) };
    if (kind === "iso" && half((l) => /^(?:<\d+>)?\d{4}-\d\d-\d\dT\S+ \S+ [^\s:\[]+(?:\[\d+\])?: /.test(l))) return { format: "syslog", label: "syslog with ISO time", timed: true, make: (c) => syslogParser(withKind(c)) };
    return { format: "text", label: flavour(sample, kind), timed: true, make: (c) => textParser(withKind(c), false) };
  }
  if (half((l) => PY_BASIC.test(l))) return { format: "text", label: "python logging, basicConfig (no time)", timed: false, make: () => pyBasicParser() };
  if (half((l) => NPM.test(l))) return { format: "text", label: "npm debug log (no time)", timed: false, make: () => npmParser() };
  if (share((l) => ANY_TIME.test(l.slice(0, 80))) >= 0.3) {
    const m = ANY_TIME.exec(sample.find((l) => ANY_TIME.test(l.slice(0, 80))).slice(0, 80));
    probe.found = null;
    timeAt(m[0], 0, probe);
    const kind = probe.found;
    return { format: "text", label: "text with a time near the start of the line", timed: true, make: (c) => textParser(Object.assign(c, { kind }), true) };
  }
  return { format: "plain", label: "plain lines, no time", timed: false, make: () => plainParser() };
}
