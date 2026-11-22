// Log files for ask-kit: what went wrong and when, which errors happen most, when one first
// appeared, what happened around a time or a request id, how the rate changed, how two logs differ.
//
// Pure Node and streaming: a file is read once from start to end, a chunk at a time, so a log of
// several GB is read without holding it in memory. Gzip files are read through zlib, and a rotated
// set (app.log, app.log.1, app.log.2.gz) is read as one log, oldest part first.
//
// Three rules:
//  - it only reads; nothing here writes, deletes or runs a program;
//  - credentials are replaced with <redacted> before a line is parsed, so no result, signature or
//    search can show them, because what the investigator reads goes to a cloud model;
//  - every call is bounded: a time limit on reading, caps on lists, clipped text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { LEVELS, levelOf, ERR_WORD, context, timeOf, iso, redact, redactValue, SECRET_HINT, signature, exceptionLine, pathPattern, detect } from "./parse.mjs";

const HEAD_BYTES = 64 << 10;
const TAIL_BYTES = 256 << 10;
const MAX_LINE = 64 << 10;
const MAX_EXTRA = 60;
const MAX_SIGS = 5000;
const TIME_LIMIT_MS = 100_000;
const DAY = 86_400_000;
const SKIP_DIRS = new Set(["node_modules", "journal", "private", "__pycache__", "target", "vendor", "dist", "build"]);
const CRED_FILE = /(^|[\\/])(\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pgpass|\.my\.cnf|\.git-credentials|\.?htpasswd|shadow-?|gshadow-?|sudoers|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|[^\\/]*\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg)|credentials?(\.[^\\/]*)?|secrets?(\.[^\\/]*)?|\.[a-z_]*history)$|[\\/]\.(ssh|aws|gnupg|kube|docker)[\\/]/i;
const NOT_LOG_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|md|html?|css|py|rb|rs|go|java|c|h|cpp|sh|toml|ya?ml|xml|lock|png|jpe?g|gif|svg|pdf|zip|tar|exe|dll|so|db|sqlite|conf|cfg|ini|journal|csv|tsv)$/;
const OTHER_PACK = /\.(xz|bz2|zst|zip|7z|lz4)$/i;

const UNITS = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, d: DAY, day: DAY, days: DAY, w: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY };
const BUCKETS = [1000, 5000, 10_000, 30_000, 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, DAY, 7 * DAY];

const clip = (s, n) => (s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s);
// A string of its own: a piece cut from a chunk of the file would keep the whole chunk in memory.
const own = (s) => (typeof s === "string" && s.length > 12 ? Buffer.from(s, "utf8").toString("utf8") : s);
const human = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`);
const span = (ms) => (ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : ms < 2 * 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 2 * DAY ? `${+(ms / 3_600_000).toFixed(1)} h` : `${+(ms / DAY).toFixed(1)} days`);
const bucketName = (ms) => (ms < 60_000 ? `${ms / 1000} s` : ms < 3_600_000 ? `${ms / 60_000} min` : ms < DAY ? `${ms / 3_600_000} h` : `${ms / DAY} d`);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function setKey(name) {
  return name
    .replace(/\.gz$/i, "")
    .replace(/[.-]\d{4}-?\d\d-?\d\d(?:[-_.]\d+)?$/, "")
    .replace(/\.\d{1,4}$/, "")
    .replace(/[.-]\d{4}-?\d\d-?\d\d(?=\.[a-z]+$)/i, "")
    .replace(/\.\d{1,4}(?=\.[a-z]+$)/i, "");
}

function isLogName(name) {
  const n = name.toLowerCase();
  if (OTHER_PACK.test(n)) return false;
  const base = n.replace(/\.gz$/, "");
  if (/\.(log|out|err|jsonl|ndjson)$/.test(base) || /\.(log|out|err)\.[\w.-]+$/.test(base)) return true;
  if (NOT_LOG_EXT.test(base) || /^(lastlog|faillog|wtmp|btmp|changelog|readme)/.test(base)) return false;
  return /(^|[._-])(sys)?logs?([._-]|\d|$)|logfile|^messages(\.\d+)?$|_log$/.test(base);
}

export function make({ settings = {}, push = () => {} } = {}) {
  const workdir = path.resolve(settings.WORKDIR || process.env.WORKDIR || process.cwd());
  const offset = parseOffset(settings.LOGS_UTC_OFFSET || process.env.LOGS_UTC_OFFSET);
  const dirsSetting = String(settings.LOGS_DIRS || process.env.LOGS_DIRS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const defaultDirs = dirsSetting.length ? dirsSetting.map((d) => path.resolve(workdir, d)) : [path.join(workdir, "logs"), path.join(workdir, "log"), "/var/log"];
  const cache = new Map();

  function parseOffset(v) {
    if (!v) return 0;
    const m = /^([+-])(\d\d):?(\d\d)?$/.exec(String(v).trim());
    if (!m) throw new Error(`LOGS_UTC_OFFSET must look like +02:00 or -0500, not "${v}"`);
    return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +(m[3] ?? 0)) * 60000;
  }

  const show = (p) => {
    const r = path.relative(workdir, p);
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : p;
  };
  const refuse = (p) => {
    if (CRED_FILE.test(p)) throw new Error(`refused: ${show(p)} is named like a file of credentials, and what is read here goes to a model. logs reads log files only; name the log itself`);
  };

  // ---------------------------------------------------------------------------------------
  // Reading

  function headText(p, gz) {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(gz ? HEAD_BYTES * 4 : HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      let b = buf.subarray(0, n);
      if (gz) b = zlib.gunzipSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, HEAD_BYTES);
      return b;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** What one file is: size, modified time, format, first time. Read from its first 64 KB and kept until the file changes. */
  function info(p) {
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return { path: p, show: show(p), error: e.code === "ENOENT" ? "no such file" : e.message };
    }
    const key = `${p}\0${st.mtimeMs}\0${st.size}`;
    if (cache.has(key)) return cache.get(key);
    const part = { path: p, show: show(p), size: st.size, mtime: st.mtimeMs, gz: false, enc: "utf8", first: null, last: undefined };
    const started = Date.now();
    try {
      const fd = fs.openSync(p, "r");
      const magic = Buffer.alloc(4);
      const got = fs.readSync(fd, magic, 0, 4, 0);
      fs.closeSync(fd);
      part.gz = got >= 2 && magic[0] === 0x1f && magic[1] === 0x8b;
      let b = headText(p, part.gz);
      if (b[0] === 0xff && b[1] === 0xfe) part.enc = "utf16le";
      if (part.enc === "utf8" && b.subarray(0, 4096).includes(0)) {
        part.det = { format: "binary", label: "not text", timed: false };
        part.error = "not a text file";
      } else {
        let text = b.toString(part.enc).replace(/^\uFEFF/, "");
        const lines = text.split(/\r?\n/);
        if (b.length >= HEAD_BYTES || lines.length > 1) lines.pop();
        const ctx = context({ mtime: st.mtimeMs, offset });
        part.det = detect(lines, ctx);
        if (part.det.timed) {
          const parse = part.det.make(context({ mtime: st.mtimeMs, offset }));
          for (const l of lines) {
            const e = parse(l);
            if (e && e.t != null) {
              part.first = e.t;
              break;
            }
          }
        }
      }
      push({ kind: "read", detail: `head of ${part.show}`, ms: Date.now() - started, code: 0, size: Math.min(st.size, HEAD_BYTES) });
    } catch (e) {
      part.det = { format: "unreadable", label: "unreadable", timed: false };
      part.error = e.code === "EACCES" ? "permission denied" : e.message;
      push({ kind: "read", detail: `head of ${part.show}`, ms: Date.now() - started, code: 1, size: 0 });
    }
    cache.set(key, part);
    return part;
  }

  /** Every line of a file, in order: onLine(line, number). onLine returns false to stop. Never throws: {lines, bytes, error?, stopped?}. */
  async function readLines(part, onLine, ctl) {
    const started = Date.now();
    const out = { lines: 0, bytes: 0 };
    const raw = fs.createReadStream(part.path, { highWaterMark: 1 << 20 });
    let src = raw;
    if (part.gz) {
      src = zlib.createGunzip();
      raw.on("error", (e) => src.destroy(e));
      raw.pipe(src);
    }
    const decoder = new StringDecoder(part.enc);
    let carry = "";
    let n = 0;
    let skipping = false;
    let stop = false;
    try {
      for await (const chunk of src) {
        out.bytes += chunk.length;
        let s = decoder.write(chunk);
        if (n === 0 && !carry && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
        if (carry) s = carry + s;
        let start = 0;
        for (let i; (i = s.indexOf("\n", start)) !== -1; start = i + 1) {
          n++;
          if (skipping) {
            skipping = false;
            continue;
          }
          let end = i;
          if (end > start && s.charCodeAt(end - 1) === 13) end--;
          if (end - start > MAX_LINE) end = start + MAX_LINE;
          if (onLine(s.slice(start, end), n) === false) {
            stop = true;
            break;
          }
        }
        if (stop) break;
        carry = start ? s.slice(start) : s;
        if (carry.length > 1 << 20) {
          // A line longer than 1 MB: its start is handed on, the rest is skipped.
          if (!skipping && onLine(carry.slice(0, MAX_LINE), n + 1) === false) break;
          skipping = true;
          carry = "";
        }
        if (Date.now() > ctl.deadline) {
          out.stopped = `stopped at the time limit after ${human(out.bytes)} of ${part.show}`;
          ctl.stopped = out.stopped;
          break;
        }
      }
      if (!stop && !out.stopped) {
        carry += decoder.end();
        if (carry && !skipping) {
          n++;
          onLine(carry.length > MAX_LINE ? carry.slice(0, MAX_LINE) : carry.replace(/\r$/, ""), n);
        }
      }
    } catch (e) {
      out.error = e.code === "EACCES" ? "permission denied" : e.code === "Z_DATA_ERROR" || e.code === "Z_BUF_ERROR" ? `damaged gzip (${e.message})` : e.message;
    } finally {
      raw.destroy();
      if (src !== raw) src.destroy();
    }
    out.lines = n;
    push({ kind: "read", detail: part.show, ms: Date.now() - started, code: out.error ? 1 : 0, size: out.bytes });
    return out;
  }

  /** A function that turns the lines of one file into entries: feed(line, number) and end(). Lines without a time join the entry above. */
  function assembler(part, onEntry) {
    const parse = part.det.make(context({ mtime: part.mtime, offset }));
    const json = part.det.format === "json";
    let cur = null;
    let lastT = null;
    const flush = () => {
      if (!cur) return;
      const e = cur;
      cur = null;
      return onEntry(e);
    };
    const feed = (line, n) => {
      if (line === "") return;
      if (SECRET_HINT.test(line)) {
        if (json) {
          try {
            line = JSON.stringify(redactValue(JSON.parse(line)));
          } catch {
            line = redact(line);
          }
        } else line = redact(line);
      }
      const e = parse(line);
      if (e === null && cur) {
        if (!cur.extra) cur.extra = [line];
        else if (cur.extra.length < MAX_EXTRA) cur.extra.push(line);
        else cur.more = (cur.more ?? 0) + 1;
        return;
      }
      const r = flush();
      cur = e ?? { t: null, level: -1, msg: line };
      cur.line = n;
      cur.file = part.show;
      cur.raw = line;
      if (cur.t == null) {
        cur.t = lastT;
        cur.untimed = true;
      } else lastT = cur.t;
      if (cur.stack) cur.extra = cur.stack.split("\n").slice(0, MAX_EXTRA);
      return r;
    };
    return { feed, end: flush };
  }

  async function walkPart(part, onEntry, ctl) {
    if (part.error) return { lines: 0, bytes: 0, error: part.error };
    let stopped = false;
    const a = assembler(part, (e) => {
      if (onEntry(e) === false) {
        stopped = true;
        return false;
      }
    });
    const r = await readLines(part, a.feed, ctl);
    if (!stopped && !r.stopped) a.end();
    return r;
  }

  // ---------------------------------------------------------------------------------------
  // Finding files

  function discover(dirs, { depth = 3, maxEntries = 20000 } = {}) {
    const found = [];
    let seen = 0;
    const visit = (dir, d) => {
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of ents) {
        if (++seen > maxEntries) return;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (d < depth && !ent.name.startsWith(".") && !SKIP_DIRS.has(ent.name)) visit(p, d + 1);
        } else if (ent.isFile() && isLogName(ent.name) && !CRED_FILE.test(p)) found.push(p);
      }
    };
    for (const dir of dirs) {
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(dir, 0);
      else if (st.isFile() && !CRED_FILE.test(dir)) found.push(dir);
    }
    return [...new Set(found)];
  }

  /** Files grouped into logs: the parts of a rotated set become one log, oldest part first. */
  function group(paths) {
    const sets = new Map();
    for (const p of paths) {
      const key = path.join(path.dirname(p), setKey(path.basename(p)));
      if (!sets.has(key)) sets.set(key, []);
      sets.get(key).push(p);
    }
    return [...sets.entries()].map(([key, ps]) => asLog(key, ps));
  }

  function asLog(key, paths) {
    const parts = paths.map(info).filter((p) => !p.error || paths.length === 1);
    parts.sort((a, b) => (a.first ?? a.mtime ?? 0) - (b.first ?? b.mtime ?? 0) || (a.mtime ?? 0) - (b.mtime ?? 0));
    const newest = parts.at(-1) ?? { show: show(key) };
    return { name: parts.length > 1 ? show(key) : newest.show, parts };
  }

  function siblings(p) {
    const dir = path.dirname(p);
    const name = path.basename(p);
    if (setKey(name) !== name) return [p];
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    const out = ents.filter((e) => e.isFile() && setKey(e.name) === name && !OTHER_PACK.test(e.name)).map((e) => path.join(dir, e.name));
    return out.length ? out : [p];
  }

  /** The logs a `file` argument names: a path, a folder, a name or part of one, a list, or nothing (the logs found in LOGS_DIRS). */
  function resolve(spec, { max = 40 } = {}) {
    const notes = [];
    const specs = spec == null || spec === "" ? null : (Array.isArray(spec) ? spec : String(spec).split(",")).map((s) => String(s).trim()).filter(Boolean);
    if (!specs || !specs.length) {
      const all = group(discover(defaultDirs)).filter((l) => l.parts.length && !l.parts[0].error && l.parts.some((p) => p.size > 0));
      if (!all.length) return { error: `no log files found in ${defaultDirs.map(show).join(", ")}; name a file or a folder (file: "path/to/app.log"), or set LOGS_DIRS` };
      all.sort((a, b) => b.parts.at(-1).mtime - a.parts.at(-1).mtime);
      if (all.length > max) notes.push(`${all.length} logs found; only the ${max} most recently written are read`);
      notes.push(`no file was named: read ${plural(Math.min(all.length, max), "log")} found in ${defaultDirs.map(show).join(", ")}`);
      return { logs: all.slice(0, max), notes };
    }
    const logs = [];
    let pool = null;
    for (const s of specs) {
      const p = path.resolve(workdir, s);
      refuse(p);
      let st = null;
      try {
        st = fs.statSync(p);
      } catch {}
      if (st?.isFile()) {
        const sib = siblings(p);
        logs.push(asLog(p, sib));
        if (sib.length > 1) notes.push(`${show(p)} is a rotated set of ${sib.length} files, read as one log, oldest first`);
        continue;
      }
      if (st?.isDirectory()) {
        const inDir = group(discover([p])).filter((l) => l.parts.length && !l.parts[0].error);
        if (!inDir.length) return { error: `no log files in ${show(p)}` };
        if (inDir.length > max) notes.push(`${inDir.length} logs in ${show(p)}; only the first ${max} are read`);
        logs.push(...inDir.slice(0, max));
        continue;
      }
      pool ??= group(discover([...defaultDirs, workdir]));
      const want = s.toLowerCase();
      const base = (l) => path.basename(l.name).toLowerCase();
      const hit = pool.find((l) => l.name.toLowerCase() === want || base(l) === want) ?? pool.find((l) => base(l).replace(/\.[a-z]+$/, "") === want) ?? pool.find((l) => l.name.toLowerCase().includes(want));
      if (!hit) {
        const near = pool.slice(0, 20).map((l) => l.name);
        return { error: `no log file ${s}${near.length ? `; have: ${near.join(", ")}${pool.length > 20 ? ` and ${pool.length - 20} more` : ""}` : `, and no log files under ${show(workdir)} or ${defaultDirs.map(show).join(", ")}`}` };
      }
      notes.push(`"${s}" matched ${hit.name}`);
      logs.push(hit);
    }
    for (const l of logs) for (const p of l.parts) if (p.error && l.parts.length === 1) return { error: `${p.show}: ${p.error}` };
    return { logs, notes };
  }

  // ---------------------------------------------------------------------------------------
  // Time

  async function lastOf(part, ctl) {
    if (part.last !== undefined) return part.last;
    part.last = null;
    if (part.error || !part.det.timed) return null;
    if (part.gz) {
      let last = null;
      await walkPart(part, (e) => {
        if (!e.untimed) last = e.t;
      }, ctl);
      return (part.last = last);
    }
    const started = Date.now();
    try {
      const fd = fs.openSync(part.path, "r");
      const len = Math.min(part.size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, part.size - len);
      fs.closeSync(fd);
      const lines = buf.toString(part.enc).split(/\r?\n/);
      if (len < part.size) lines.shift();
      const parse = part.det.make(context({ mtime: part.mtime, offset }));
      for (let i = lines.length - 1; i >= 0; i--) {
        const e = lines[i] ? parse(lines[i]) : null;
        if (e && e.t != null) {
          part.last = e.t;
          break;
        }
      }
      push({ kind: "read", detail: `tail of ${part.show}`, ms: Date.now() - started, code: 0, size: len });
    } catch {}
    return part.last;
  }

  /** The first and last time of a set of logs. */
  async function bounds(logs, ctl) {
    let first = null;
    let last = null;
    for (const l of logs) {
      for (const p of l.parts) if (p.first != null && (first == null || p.first < first)) first = p.first;
      for (let i = l.parts.length - 1; i >= 0; i--) {
        const t = await lastOf(l.parts[i], ctl);
        if (t != null) {
          if (last == null || t > last) last = t;
          break;
        }
      }
    }
    return { first, last };
  }

  const TIME_HELP = 'a time is an ISO time ("2026-11-08T21:00"), a date, a time of day ("21:14", on the day the log ends), "2h", "30m", "3d" (before now), "today", "yesterday", or relative to the log itself: "last", "last-1h", "first", "first+10m"';
  function when(arg, edge, env) {
    if (arg == null || arg === "") return null;
    if (typeof arg === "number") return timeOf(arg, { offset });
    const s = String(arg).trim();
    const l = s.toLowerCase();
    let m = /^(last|first|now)\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*([a-z]+))?$/.exec(l);
    if (m) {
      const base = m[1] === "now" ? env.now : env[m[1]];
      if (base == null) throw new Error(`"${s}" needs a log with times in it, and none was found in this one; use an ISO time`);
      if (!m[2]) return base;
      if (!UNITS[m[4]]) throw new Error(`unknown unit in "${s}"; ${TIME_HELP}`);
      return base + (m[2] === "-" ? -1 : 1) * +m[3] * UNITS[m[4]];
    }
    m = /^(\d+(?:\.\d+)?)\s*([a-z]+)(?:\s+ago)?$/.exec(l);
    if (m && UNITS[m[2]]) return env.now - +m[1] * UNITS[m[2]];
    const dayStart = (t) => Math.floor((t + offset) / DAY) * DAY - offset;
    if (l === "today") return dayStart(env.now) + (edge === "until" ? DAY : 0);
    if (l === "yesterday") return dayStart(env.now) - (edge === "until" ? 0 : DAY);
    m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(l);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) - offset + (edge === "until" ? DAY : 0);
    m = /^(\d{1,2}):(\d\d)(?::(\d\d))?$/.exec(l);
    if (m) return dayStart(env.last ?? env.now) + (+m[1] * 3600 + +m[2] * 60 + +(m[3] ?? 0)) * 1000;
    const t = timeOf(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d$/.test(s) ? s + ":00" : s, { offset });
    if (t == null) throw new Error(`cannot read "${s}" as a time; ${TIME_HELP}`);
    return t;
  }

  async function windowOf(logs, since, until, ctl, always = false) {
    const needs = (v) => typeof v === "string" && /last|first|^\s*\d{1,2}:\d\d/i.test(v);
    const env = { now: Date.now(), first: null, last: null };
    if (always || needs(since) || needs(until)) Object.assign(env, await bounds(logs, ctl));
    return { since: when(since, "since", env), until: when(until, "until", env), env };
  }

  // ---------------------------------------------------------------------------------------
  // Filtering and showing

  const isError = (e) => e.level >= 4 || (e.level === -1 && ERR_WORD.test(e.msg));
  function minLevel(level) {
    if (level == null || level === "") return null;
    const l = levelOf(String(level));
    if (l < 0) throw new Error(`unknown level "${level}"; have: ${LEVELS.join(", ")}`);
    return l;
  }
  const atLevel = (e, min) => (e.level >= 0 ? e.level >= min : min >= 4 ? ERR_WORD.test(e.msg) : min === 3 ? ERR_WORD.test(e.msg) || /warn/i.test(e.msg) : true);

  function regex(grep, flags = "i") {
    if (grep == null || grep === "") return null;
    if (grep instanceof RegExp) return grep;
    try {
      return new RegExp(String(grep), flags);
    } catch (e) {
      throw new Error(`grep is not a regular expression: ${e.message}. For a literal text, escape its special characters or use the "text" param where there is one`);
    }
  }
  const literal = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const hits = (re, e) => re.test(e.raw) || (e.extra ? e.extra.some((l) => re.test(l)) : false);

  const get = (o, key) => {
    if (o == null) return undefined;
    if (key in o) return o[key];
    let v = o;
    for (const k of key.split(".")) {
      if (v == null || typeof v !== "object") return undefined;
      v = v[k];
    }
    return v;
  };
  function fieldTest(where) {
    if (where == null) return null;
    if (typeof where !== "object" || Array.isArray(where)) throw new Error('where is an object of field conditions: {status: 502}, {status: {gte: 500}}, {path: {contains: "/clacks"}}; operators: eq, ne, gt, gte, lt, lte, contains, re');
    const tests = Object.entries(where).map(([key, cond]) => {
      const ops = cond !== null && typeof cond === "object" ? cond : { eq: cond };
      for (const op of Object.keys(ops)) if (!["eq", "ne", "gt", "gte", "lt", "lte", "contains", "re"].includes(op)) throw new Error(`unknown operator "${op}" on ${key}; have: eq, ne, gt, gte, lt, lte, contains, re`);
      const re = ops.re != null ? regex(ops.re) : null;
      const same = (a, b) => a === b || String(a).toLowerCase() === String(b).toLowerCase();
      return (o) => {
        const v = get(o, key);
        if (v === undefined || v === null) return ops.ne !== undefined && Object.keys(ops).length === 1;
        if (ops.eq !== undefined && !same(v, ops.eq)) return false;
        if (ops.ne !== undefined && same(v, ops.ne)) return false;
        if (ops.gt !== undefined && !(+v > +ops.gt)) return false;
        if (ops.gte !== undefined && !(+v >= +ops.gte)) return false;
        if (ops.lt !== undefined && !(+v < +ops.lt)) return false;
        if (ops.lte !== undefined && !(+v <= +ops.lte)) return false;
        if (ops.contains !== undefined && !String(v).toLowerCase().includes(String(ops.contains).toLowerCase())) return false;
        if (re && !re.test(String(v))) return false;
        return true;
      };
    });
    return (e) => {
      const o = e.obj;
      if (!o) return false;
      for (const t of tests) if (!t(o)) return false;
      return true;
    };
  }

  /** An entry as it is returned: {time, level, message, fields?, line, file}. Text is clipped and of its own. */
  function shown(e, o = {}) {
    let message = clip(e.msg ?? "", o.clip ?? 400);
    if (e.extra && o.trace !== 0) {
      const keep = o.trace ?? 12;
      const ex = e.extra;
      const lines = ex.length <= keep ? ex : [...ex.slice(0, Math.ceil(keep / 2)), `… ${ex.length - keep + (e.more ?? 0)} more lines …`, ...ex.slice(-Math.floor(keep / 2))];
      message += "\n" + lines.map((l) => clip(l, 200)).join("\n");
      if (ex.length <= keep && e.more) message += `\n… ${e.more} more lines`;
    }
    const out = { time: e.untimed ? null : iso(e.t), level: LEVELS[e.level] ?? null, message: own(message) };
    if (e.obj && o.fields !== false) {
      const want = Array.isArray(o.fields) ? o.fields : typeof o.fields === "string" ? o.fields.split(",").map((s) => s.trim()) : null;
      const f = {};
      let n = 0;
      let left = 0;
      for (const k of want ?? Object.keys(e.obj)) {
        if (!want && e.skip && e.skip.includes(k)) continue;
        const v = want ? get(e.obj, k) : e.obj[k];
        if (v === undefined || v === null || v === "") continue;
        if (!want && n >= 10) {
          left++;
          continue;
        }
        f[k] = typeof v === "string" ? clip(v, 160) : typeof v === "object" ? clip(JSON.stringify(v), 160) : v;
        n++;
      }
      if (left) f["…"] = `${left} more fields`;
      if (n) out.fields = f;
    }
    out.line = e.line;
    out.file = e.file;
    return out;
  }

  /** The signature of an entry: its message, and for a stack trace the line that names the exception. */
  function sigOf(e, memo) {
    if (e.access) return `${e.obj.method ?? "-"} ${pathPattern(e.obj.path)} -> ${e.obj.status}`;
    const exc = e.extra ? exceptionLine(e.extra) : null;
    const text = exc ? `${e.msg} | ${exc}` : e.msg;
    if (!memo) return signature(text);
    const key = text.length > 500 ? text.slice(0, 500).replace(/\d+/g, "0") : text.replace(/\d+/g, "0");
    let s = memo.get(key);
    if (s === undefined) {
      if (memo.size > 50000) memo.clear();
      s = own(exc ? `${signature(e.msg)} | ${signature(exc)}` : signature(text));
      memo.set(own(key), s);
    }
    return s;
  }

  /**
   * Walk logs and call fn for every entry in the window that passes the filters. onBefore gets the
   * entries before `since`. Returns {scanned, matched, lines, bytes, notes}.
   */
  async function run(logs, q, fn, ctl, onBefore) {
    const stats = { scanned: 0, matched: 0, lines: 0, bytes: 0, notes: [] };
    let halt = false;
    for (const log of logs) {
      if (halt) break;
      let done = false;
      for (let i = 0; i < log.parts.length && !done && !halt; i++) {
        const part = log.parts[i];
        const next = log.parts[i + 1];
        if (!onBefore && q.since != null && next?.first != null && next.first <= q.since) continue;
        if (q.until != null && part.first != null && part.first > q.until) continue;
        let past = 0;
        const r = await walkPart(part, (e) => {
          stats.scanned++;
          if (!e.untimed || e.t != null) {
            if (q.until != null && e.t > q.until) {
              if (++past > 500) {
                done = true;
                return false;
              }
              return;
            }
            past = 0;
            if (q.since != null && e.t < q.since) {
              if (onBefore) onBefore(e);
              return;
            }
          }
          if (q.min != null && !atLevel(e, q.min)) return;
          if (q.re && !hits(q.re, e)) return;
          if (q.where && !q.where(e)) return;
          stats.matched++;
          if (fn(e) === false) {
            halt = true;
            return false;
          }
        }, ctl);
        stats.lines += r.lines;
        stats.bytes += r.bytes;
        if (r.error) stats.notes.push(`${part.show}: ${r.error}`);
        if (r.stopped) {
          stats.notes.push(`${r.stopped}; the result covers only what was read. Narrow it with since, until or one file`);
          halt = true;
        }
      }
    }
    return stats;
  }

  const newCtl = (o) => ({ deadline: Date.now() + Math.min(+(o?.timeoutMs ?? TIME_LIMIT_MS) || TIME_LIMIT_MS, 600_000) });
  const describe = (logs) => logs.map((l) => (l.parts.length > 1 ? { log: l.name, parts: l.parts.map((p) => p.show), format: l.parts.at(-1).det.label } : { log: l.name, format: l.parts[0]?.det.label }));
  const names = (logs) => (logs.length === 1 ? logs[0].name : logs.length <= 3 ? logs.map((l) => l.name).join(", ") : `${logs.length} logs`);
  const windowText = (w) => ({ since: iso(w.since), until: iso(w.until) });
  const untimedNote = (logs, w) => (w.since != null || w.until != null) && logs.some((l) => l.parts.some((p) => !p.det.timed)) ? [`${logs.filter((l) => l.parts.some((p) => !p.det.timed)).map((l) => l.name).join(", ")}: no times in the lines, so since and until do not apply to it and every entry counts`] : [];
  // A window that lies wholly after the log ends is the usual mistake with a saved log: say so.
  async function emptyHint(logs, w, ctl) {
    if (w.since == null) return null;
    const b = await bounds(logs, ctl);
    if (b.last != null && b.last < w.since) return `the window starts at ${iso(w.since)} and the log ends at ${iso(b.last)}; for a log that is not being written now, count from its end: since: "last-1h"`;
    if (b.first != null && w.until != null && b.first > w.until) return `the window ends at ${iso(w.until)} and the log starts at ${iso(b.first)}`;
    return null;
  }

  function prepare(file, o) {
    const r = resolve(file, o);
    if (r.error) return r;
    return r;
  }

  // ---------------------------------------------------------------------------------------
  // The global

  const api = {
    /**
     * The log files in a folder (default: the folders in LOGS_DIRS), a rotated set as one log.
     * {dirs, count, logs:[{log, parts?, size, bytes, modified, format, first, last}], leftOut?} or {error}.
     */
    async files(dir, o = {}) {
      const dirs = dir ? [path.resolve(workdir, String(dir))] : defaultDirs;
      if (dir) refuse(dirs[0]);
      if (dir && !fs.existsSync(dirs[0])) return { error: `no folder or file ${show(dirs[0])}` };
      const ctl = newCtl(o);
      const all = group(discover(dirs)).filter((l) => l.parts.length);
      all.sort((a, b) => (b.parts.at(-1).mtime ?? 0) - (a.parts.at(-1).mtime ?? 0));
      const max = Math.min(o.max ?? 60, 200);
      const out = [];
      for (const l of all.slice(0, max)) {
        const size = l.parts.reduce((a, p) => a + (p.size ?? 0), 0);
        const b = l.parts[0].error ? { first: null, last: null } : await bounds([l], ctl);
        out.push({ log: l.name, ...(l.parts.length > 1 ? { parts: l.parts.map((p) => p.show) } : {}), size: human(size), bytes: size, modified: iso(Math.round(l.parts.at(-1).mtime)), format: l.parts.at(-1).det.label, first: iso(b.first), last: iso(b.last), ...(l.parts[0].error ? { error: l.parts[0].error } : {}) });
      }
      return { dirs: dirs.map(show), count: all.length, logs: out, ...(all.length > max ? { leftOut: all.length - max } : {}) };
    },

    /**
     * The entries of a log that pass the filters, as {time, level, message, fields?, line, file}.
     * {logs, window, scanned, matched, entries, leftOut?, notes?} or {error}.
     */
    async scan(file, o = {}) {
      const r = prepare(file);
      if (r.error) return r;
      const ctl = newCtl(o);
      const w = await windowOf(r.logs, o.since, o.until, ctl);
      const q = { since: w.since, until: w.until, min: minLevel(o.level), re: regex(o.grep), where: fieldTest(o.where) };
      const limit = Math.max(1, Math.min(+(o.limit ?? 50) || 50, 500));
      const entries = [];
      const stats = await run(r.logs, q, (e) => {
        if (o.last) {
          entries.push(shown(e, o));
          if (entries.length > limit) entries.shift();
        } else if (entries.length < limit) entries.push(shown(e, o));
        else if (o.count === false) return false;
      }, ctl);
      if (r.logs.length > 1) entries.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
      const notes = [...r.notes, ...stats.notes, ...untimedNote(r.logs, w)];
      if (!stats.matched) {
        const hint = await emptyHint(r.logs, w, ctl);
        if (hint) notes.push(hint);
      }
      return { logs: describe(r.logs), window: windowText(w), scanned: stats.scanned, matched: stats.matched, entries, ...(stats.matched > entries.length ? { leftOut: stats.matched - entries.length, kept: o.last ? "the latest" : "the earliest" } : {}), ...(notes.length ? { notes } : {}) };
    },

    /**
     * Call fn(entry) for every entry that passes the filters, for a count or a sum of your own:
     * entry is {t (epoch ms), time, level, message, fields, line, file}. Returns {scanned, matched, notes?}.
     */
    async each(file, o, fn) {
      if (typeof o === "function") [o, fn] = [{}, o];
      if (typeof fn !== "function") throw new Error("each needs a function: await logs.each(file, {level: 'error'}, (e) => { ... })");
      const r = prepare(file);
      if (r.error) return r;
      const ctl = newCtl(o);
      const w = await windowOf(r.logs, o.since, o.until, ctl);
      const q = { since: w.since, until: w.until, min: minLevel(o.level), re: regex(o.grep), where: fieldTest(o.where) };
      const stats = await run(r.logs, q, (e) => fn({ t: e.untimed ? null : e.t, time: e.untimed ? null : iso(e.t), level: LEVELS[e.level] ?? null, message: e.msg, fields: e.obj ?? {}, line: e.line, file: e.file, trace: e.extra ?? null }), ctl);
      const notes = [...r.notes, ...stats.notes];
      return { scanned: stats.scanned, matched: stats.matched, ...(notes.length ? { notes } : {}) };
    },

    /** The last n entries of a log (default 20, at most 200). {log, format, entries} or {error}. */
    async tail(file, n = 20, o = {}) {
      const r = prepare(file);
      if (r.error) return r;
      if (r.logs.length > 1) return { error: `tail reads one log; ${r.logs.length} match: ${r.logs.slice(0, 20).map((l) => l.name).join(", ")}` };
      const want = Math.max(1, Math.min(+n || 20, 200));
      const ctl = newCtl(o);
      const log = r.logs[0];
      const ring = [];
      const notes = [...r.notes];
      // Parts are read newest first until enough entries are held. A plain file is read from its end.
      for (let i = log.parts.length - 1; i >= 0 && ring.length < want; i--) {
        const part = log.parts[i];
        const got = [];
        if (part.gz || part.size <= 4 * TAIL_BYTES) {
          const res = await walkPart(part, (e) => {
            got.push(e);
            if (got.length > want) got.shift();
          }, ctl);
          if (res.error) notes.push(`${part.show}: ${res.error}`);
        } else {
          let len = TAIL_BYTES;
          for (;;) {
            got.length = 0;
            const start = Math.max(0, part.size - len);
            const fh = await fs.promises.open(part.path, "r");
            let before = 0;
            let text;
            try {
              const buf = Buffer.alloc(part.size - start);
              await fh.read(buf, 0, buf.length, start);
              // The line numbers of the tail need the count of lines before it.
              const chunk = Buffer.alloc(1 << 20);
              for (let pos = 0; pos < start; ) {
                const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, start - pos), pos);
                if (!bytesRead) break;
                for (let j = chunk.indexOf(10); j !== -1 && j < bytesRead; j = chunk.indexOf(10, j + 1)) before++;
                pos += bytesRead;
              }
              text = buf.toString(part.enc);
            } finally {
              await fh.close();
            }
            push({ kind: "read", detail: `tail of ${part.show}`, ms: 0, code: 0, size: len });
            const lines = text.split("\n");
            let no = before + 1;
            if (start > 0) {
              lines.shift();
              no++;
            }
            if (lines.at(-1) === "") lines.pop();
            const a = assembler(part, (e) => {
              got.push(e);
            });
            for (const l of lines) a.feed(l.endsWith("\r") ? l.slice(0, -1) : l, no++);
            a.end();
            if (start > 0 && got.length) got.shift();
            if (got.length >= want || start === 0 || len >= 64 << 20) break;
            len *= 4;
          }
        }
        ring.unshift(...got.slice(-(want - ring.length)));
      }
      return { log: log.name, format: log.parts.at(-1).det.label, entries: ring.map((e) => shown(e, o)), ...(notes.length ? { notes } : {}) };
    },

    /**
     * The entries around a point: at.time, at.line (one file), at.grep (the first entry matching a
     * regex; at.nth for a later one) or at.id (every entry holding this text, such as a request id).
     * With several logs the entries are merged in time order. {logs, anchor, entries:[{..., hit?}], matches?} or {error}.
     */
    async around(file, at = {}, o = {}) {
      const r = prepare(file);
      if (r.error) return r;
      const modes = ["time", "line", "grep", "id"].filter((k) => at[k] != null && at[k] !== "");
      if (modes.length !== 1) throw new Error('around needs exactly one of: time ("21:14", "last-5m", an ISO time), line (a line number), grep (a regex), id (a literal text such as a request id)');
      const mode = modes[0];
      const ctl = newCtl(o);
      const idMode = mode === "id";
      const before = Math.max(0, Math.min(+(o.before ?? (idMode ? 0 : 10)) || 0, 100));
      const after = Math.max(0, Math.min(+(o.after ?? (idMode ? 0 : 10)) || 0, 100));
      const limit = Math.max(1, Math.min(+(o.limit ?? 60) || 60, 200));
      const notes = [...r.notes];
      if (mode === "line" && (r.logs.length > 1 || r.logs[0].parts.length > 1)) {
        const parts = r.logs.flatMap((l) => l.parts.map((p) => p.show));
        return { error: `a line number belongs to one file; name one of: ${parts.slice(0, 20).join(", ")}` };
      }

      // One pass over a log: the entries that hit, each with `before` entries above and `after` below.
      const collect = async (log, isHit, maxHits) => {
        const out = [];
        let found = 0;
        let total = 0;
        let pending = 0;
        let ring = [];
        for (const part of log.parts) {
          let stop = false;
          const res = await walkPart(part, (e) => {
            if (isHit(e)) {
              total++;
              if (found < maxHits) {
                found++;
                for (const b of ring) out.push(b);
                ring = [];
                e.hit = true;
                out.push(e);
                pending = after;
                return;
              }
            }
            if (pending > 0) {
              out.push(e);
              pending--;
              if (pending === 0 && found >= maxHits && !idMode) {
                stop = true;
                return false;
              }
            } else if (before) {
              ring.push(e);
              if (ring.length > before) ring.shift();
            }
            if (found >= maxHits && !idMode && after === 0) {
              stop = true;
              return false;
            }
          }, ctl);
          if (res.error) notes.push(`${part.show}: ${res.error}`);
          if (stop || ctl.stopped) break;
        }
        // In time mode nothing may be at or after the time: then the last entries before it are the answer.
        return { out, found, total, ring };
      };

      let entries = [];
      let anchor = null;
      let matches;
      const timeAround = async (logs, t) => {
        for (const log of logs) {
          const c = await collect(log, (e) => e.t != null && e.t >= t, 1);
          const got = c.found ? c.out : c.ring;
          if (c.found) for (const e of got) if (e.hit && e.t !== t) e.hit = false;
          entries.push(...got);
        }
      };
      if (mode === "time") {
        const w = await windowOf(r.logs, at.time, null, ctl, true);
        if (w.since == null) throw new Error(`cannot read "${at.time}" as a time`);
        anchor = { time: iso(w.since) };
        await timeAround(r.logs, w.since);
      } else if (mode === "line") {
        const n = +at.line;
        if (!Number.isInteger(n) || n < 1) throw new Error("line is a line number, 1 or more");
        const c = await collect(r.logs[0], (e) => e.line + (e.extra ? e.extra.length + (e.more ?? 0) : 0) >= n, 1);
        if (!c.found) return { error: `${r.logs[0].name} has fewer than ${n} lines` };
        entries = c.out;
        anchor = { line: n, file: r.logs[0].parts[0].show };
      } else {
        const re = idMode ? literal(at.id) : regex(at.grep);
        const nth = Math.max(1, +(at.nth ?? 1) || 1);
        let first = null;
        const rest = [];
        matches = 0;
        for (const log of r.logs) {
          let seen = 0;
          const c = await collect(log, (e) => hits(re, e) && (idMode || ++seen === nth), idMode ? limit : 1);
          matches += c.total;
          if (c.found) {
            entries.push(...c.out);
            const h = c.out.find((e) => e.hit);
            if (h.t != null && (first == null || h.t < first.t)) first = h;
          } else rest.push(log);
        }
        if (!entries.length) return { logs: describe(r.logs), matches: 0, entries: [], verdict: `nothing in ${names(r.logs)} matches ${idMode ? `"${at.id}"` : `/${at.grep}/`}`, ...(notes.length ? { notes } : {}) };
        anchor = first ? { time: iso(first.t), file: first.file, line: first.line } : { file: entries[0].file, line: entries[0].line };
        // Logs that do not hold the text still say what happened at that moment.
        if (!idMode && first && rest.length && (before || after)) await timeAround(rest, first.t);
      }
      if (r.logs.length > 1) entries.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      const leftOut = Math.max(0, entries.length - limit);
      const outE = entries.slice(0, limit).map((e) => ({ ...shown(e, o), ...(e.hit ? { hit: true } : {}) }));
      if (ctl.stopped) notes.push(ctl.stopped);
      return { logs: describe(r.logs), anchor, ...(matches != null ? { matches } : {}), entries: outE, ...(leftOut ? { leftOut } : {}), ...(notes.length ? { notes } : {}) };
    },

    /**
     * The kinds of error in a window, most frequent first. Entries that are the same error with
     * different details share a signature. {logs, window, entries, errors, kinds, new?, top:[{signature, count, first, last, levels, new?, example}], leftOut?, notes?}.
     */
    async errors(file, o = {}) {
      const r = prepare(file);
      if (r.error) return r;
      const ctl = newCtl(o);
      const w = await windowOf(r.logs, o.since, o.until, ctl);
      const min = minLevel(o.level) ?? 4;
      const re = regex(o.grep);
      const memo = new Map();
      const sigs = new Map();
      const beforeSigs = new Set();
      let entriesBefore = 0;
      let errors = 0;
      let other = 0;
      const stats = await run(r.logs, { since: w.since, until: w.until }, (e) => {
        if (!atLevel(e, min) || (re && !hits(re, e))) return;
        errors++;
        const s = sigOf(e, memo);
        let g = sigs.get(s);
        if (!g) {
          if (sigs.size >= MAX_SIGS) {
            other++;
            return;
          }
          g = { signature: s, count: 0, first: e.untimed ? null : e.t, last: null, levels: {}, example: shown(e, { clip: 300, trace: 8 }) };
          sigs.set(s, g);
        }
        g.count++;
        if (!e.untimed) g.last = e.t;
        const lv = LEVELS[e.level] ?? "no level";
        g.levels[lv] = (g.levels[lv] ?? 0) + 1;
      }, ctl, w.since == null ? null : (e) => {
        entriesBefore++;
        if (atLevel(e, min) && beforeSigs.size < MAX_SIGS * 4) beforeSigs.add(sigOf(e, memo));
      });
      const all = [...sigs.values()].sort((a, b) => b.count - a.count || (a.first ?? 0) - (b.first ?? 0));
      const canBeNew = w.since != null && entriesBefore > 0;
      const top = Math.max(1, Math.min(+(o.top ?? 10) || 10, 50));
      const rows = all.slice(0, top).map((g) => ({ signature: g.signature, count: g.count, first: iso(g.first), last: iso(g.last), levels: Object.entries(g.levels).map(([k, v]) => `${k} ${v}`).join(", "), ...(canBeNew ? { new: !beforeSigs.has(g.signature) } : {}), example: g.example }));
      const fresh = canBeNew ? all.filter((g) => !beforeSigs.has(g.signature)) : [];
      const notes = [...r.notes, ...stats.notes, ...untimedNote(r.logs, w)];
      if (other) notes.push(`${other} errors belong to kinds beyond the first ${MAX_SIGS} and are not grouped`);
      if (w.since != null && !entriesBefore) notes.push("the log holds nothing before the window, so whether a kind is new cannot be said");
      if (!stats.matched) {
        const hint = await emptyHint(r.logs, w, ctl);
        if (hint) notes.push(hint);
      }
      return { logs: describe(r.logs), window: windowText(w), entries: stats.matched, errors, kinds: all.length, ...(canBeNew ? { new: fresh.length, newSignatures: fresh.slice(0, 5).map((g) => g.signature) } : {}), top: rows, ...(all.length > top ? { leftOut: all.length - top } : {}), ...(notes.length ? { notes } : {}), lines: stats.lines, bytes: stats.bytes };
    },

    /**
     * Entries per bucket of time, with warnings and errors counted apart and the buckets that
     * spike marked. The bucket size follows the window unless given ("1m", "1h").
     */
    async timeline(file, o = {}) {
      const r = prepare(file);
      if (r.error) return r;
      const ctl = newCtl(o);
      const w = await windowOf(r.logs, o.since, o.until, ctl, true);
      const from = w.since ?? w.env.first;
      const to = w.until ?? w.env.last;
      if (from == null || to == null) return { logs: describe(r.logs), error: `no times found in ${names(r.logs)}, so there is no timeline; errors and scan still work` };
      if (to < from) return { logs: describe(r.logs), window: { since: iso(from), until: iso(to) }, error: (await emptyHint(r.logs, w, ctl)) ?? "the window ends before it starts" };
      let size;
      if (o.bucket) {
        const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(String(o.bucket).toLowerCase());
        if (!m || !UNITS[m[2]]) throw new Error(`bucket is a length such as "10s", "1m", "5m", "1h", "1d", not "${o.bucket}"`);
        size = Math.max(1000, +m[1] * UNITS[m[2]]);
        if ((to - from) / size > 500) throw new Error(`bucket ${o.bucket} gives ${Math.ceil((to - from) / size)} buckets over ${span(to - from)}; at most 500. Use a longer bucket or a shorter window`);
      } else size = BUCKETS.find((b) => (to - from) / b <= 48) ?? BUCKETS.at(-1);
      const start = Math.floor(from / size) * size;
      const n = Math.floor((to - start) / size) + 1;
      const total = new Array(n).fill(0);
      const errs = new Array(n).fill(0);
      const warns = new Array(n).fill(0);
      const re = regex(o.grep);
      const min = minLevel(o.level);
      const stats = await run(r.logs, { since: from, until: to, re, min, where: fieldTest(o.where) }, (e) => {
        if (e.t == null) return;
        const i = Math.floor((e.t - start) / size);
        if (i < 0 || i >= n) return;
        total[i]++;
        if (isError(e)) errs[i]++;
        else if (e.level === 3) warns[i]++;
      }, ctl);
      const median = (a) => {
        const s = [...a].sort((x, y) => x - y);
        return s[Math.floor(s.length / 2)] ?? 0;
      };
      const mt = median(total);
      const me = median(errs);
      const spike = (v, m) => v >= 3 * m && v - m >= 5;
      const fmt = (t) => (size >= DAY ? iso(t).slice(0, 10) : size >= 60_000 ? iso(t).slice(0, 16) + "Z" : iso(t));
      const rows = [];
      const spikes = [];
      for (let i = 0; i < n; i++) {
        const marks = [spike(total[i], mt) ? "entries" : null, spike(errs[i], me) ? "errors" : null].filter(Boolean);
        if (marks.length) spikes.push({ at: fmt(start + i * size), entries: total[i], errors: errs[i], of: marks.join(" and ") });
        rows.push(`${fmt(start + i * size)}  ${total[i]}${warns[i] ? `  warn ${warns[i]}` : ""}${errs[i] ? `  error ${errs[i]}` : ""}${marks.length ? `  << spike in ${marks.join(" and ")}` : ""}`);
      }
      // Long runs of empty buckets are folded, and a long timeline keeps its busiest part visible.
      const folded = [];
      for (let i = 0; i < rows.length; ) {
        let j = i;
        while (j < rows.length && total[j] === 0) j++;
        if (j - i >= 3) {
          folded.push(`${fmt(start + i * size)}  0  (${j - i} empty buckets)`);
          i = j;
        } else folded.push(rows[i++]);
      }
      const notes = [...r.notes, ...stats.notes];
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      return { logs: describe(r.logs), window: { since: iso(from), until: iso(to) }, bucket: bucketName(size), entries: sum(total), errors: sum(errs), warnings: sum(warns), usual: { entries: mt, errors: me }, spikes: spikes.slice(0, 20), buckets: folded.length > 120 ? [...folded.slice(0, 120), `… ${folded.length - 120} more buckets`] : folded, ...(notes.length ? { notes } : {}) };
    },

    /**
     * When a text or a signature first appeared, how often since, and the entries just before the
     * first one. o.text is literal (any case), o.regex a regular expression, o.signature a signature or part of one.
     */
    async firstSeen(file, o = {}) {
      const r = prepare(file);
      if (r.error) return r;
      const given = ["text", "regex", "signature"].filter((k) => o[k] != null && o[k] !== "");
      if (given.length !== 1) throw new Error("firstSeen needs exactly one of: text (literal), regex, signature (as the errors script prints it, or a part of it)");
      const ctl = newCtl(o);
      const w = await windowOf(r.logs, o.since, o.until, ctl);
      const memo = new Map();
      const re = o.text != null ? literal(o.text) : o.regex != null ? regex(o.regex) : null;
      const sig = o.signature != null ? String(o.signature).toLowerCase() : null;
      const match = re ? (e) => hits(re, e) : (e) => (e.level >= 3 || e.level === -1 || e.access) && sigOf(e, memo).toLowerCase().includes(sig);
      const keep = Math.max(0, Math.min(+(o.before ?? 5) || 0, 30));
      let first = null;
      let last = null;
      let count = 0;
      const perLog = [];
      let lead = [];
      const days = new Map();
      for (const log of r.logs) {
        let ring = [];
        let mine = 0;
        let myFirst = null;
        const stats = await run([log], { since: w.since, until: w.until }, (e) => {
          if (match(e)) {
            count++;
            mine++;
            if (!e.untimed) {
              const d = iso(e.t).slice(0, 13);
              days.set(d, (days.get(d) ?? 0) + 1);
            }
            if (!myFirst) {
              myFirst = e;
              if (!first || (e.t != null && first.t != null && e.t < first.t)) {
                first = { t: e.t, entry: shown(e, { clip: 400 }), sig: sigOf(e) };
                lead = ring.map((b) => shown(b, { clip: 200, trace: 0, fields: false }));
              }
              ring = null;
            }
            if (last == null || (e.t != null && e.t >= last.t)) last = { t: e.t, file: e.file, line: e.line, time: e.untimed ? null : iso(e.t) };
          } else if (ring && keep) {
            ring.push(e);
            if (ring.length > keep) ring.shift();
          }
        }, ctl);
        r.notes.push(...stats.notes);
        if (r.logs.length > 1 && mine) perLog.push({ log: log.name, count: mine, first: myFirst.untimed ? null : iso(myFirst.t) });
      }
      const what = o.text != null ? `"${o.text}"` : o.regex != null ? `/${o.regex}/` : `signature "${o.signature}"`;
      if (!first) {
        const hint = await emptyHint(r.logs, w, ctl);
        return { logs: describe(r.logs), window: windowText(w), count: 0, verdict: `${what} does not appear in ${names(r.logs)}${w.since != null || w.until != null ? " in the window" : ""}`, ...(r.notes.length || hint ? { notes: [...r.notes, ...(hint ? [hint] : [])] } : {}) };
      }
      const hours = [...days.entries()];
      const byHour = hours.length <= 36 ? hours.map(([h, c]) => `${h}:00Z  ${c}`) : (() => {
        const d = new Map();
        for (const [h, c] of hours) d.set(h.slice(0, 10), (d.get(h.slice(0, 10)) ?? 0) + c);
        return [...d.entries()].slice(0, 60).map(([k, c]) => `${k}  ${c}`);
      })();
      return { logs: describe(r.logs), window: windowText(w), what, count, first: first.entry, signature: first.sig, last: last && count > 1 ? { time: last.time, file: last.file, line: last.line } : null, before: lead, over: hours.length > 36 ? "per day" : "per hour", counts: byHour, ...(perLog.length ? { perLog } : {}), ...(r.notes.length ? { notes: r.notes } : {}) };
    },

    /**
     * For a web access log (or a log whose entries have a status field): counts by status class,
     * the paths that fail most, the slowest paths, the error rate over time.
     */
    async requests(file, o = {}) {
      const r = prepare(file);
      if (r.error) return r;
      const ctl = newCtl(o);
      const w = await windowOf(r.logs, o.since, o.until, ctl, true);
      const top = Math.max(1, Math.min(+(o.top ?? 5) || 5, 30));
      const from = w.since ?? w.env.first;
      const to = w.until ?? w.env.last;
      const size = from != null && to != null && to > from ? BUCKETS.find((b) => (to - from) / b <= 30) ?? BUCKETS.at(-1) : null;
      const start = size ? Math.floor(from / size) * size : 0;
      const buckets = new Map();
      const classes = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };
      const statuses = new Map();
      const paths = new Map();
      const clients = new Map();
      const slow = [];
      let total = 0;
      let timed = 0;
      let skipped = 0;
      const pathRe = o.path ? literal(o.path) : null;
      const stats = await run(r.logs, { since: w.since, until: w.until, re: regex(o.grep) }, (e) => {
        const f = e.obj;
        const status = f ? +(f.status ?? f.status_code ?? f.statusCode ?? f.code) : NaN;
        if (!f || !Number.isFinite(status) || status < 100 || status > 599) {
          skipped++;
          return;
        }
        const raw = f.path ?? f.url ?? f.uri ?? f.request ?? f.route ?? "?";
        if (pathRe && !pathRe.test(String(raw))) return;
        total++;
        const cls = status >= 500 ? "5xx" : status >= 400 ? "4xx" : status >= 300 ? "3xx" : status >= 200 ? "2xx" : "other";
        classes[cls]++;
        statuses.set(status, (statuses.get(status) ?? 0) + 1);
        const key = `${f.method ? f.method + " " : ""}${pathPattern(String(raw))}`;
        let p = paths.get(key);
        if (!p) {
          if (paths.size >= MAX_SIGS) return;
          p = { path: own(key), count: 0, e5: 0, e4: 0, sum: 0, timed: 0, max: 0 };
          paths.set(p.path, p);
        }
        p.count++;
        if (status >= 500) p.e5++;
        else if (status >= 400) p.e4++;
        const who = f.client ?? f.remote_addr ?? f.ip;
        if (who && (clients.size < 20000 || clients.has(who))) clients.set(who, (clients.get(who) ?? 0) + 1);
        let rt = f.request_time ?? f.duration ?? f.latency ?? f.elapsed ?? f.duration_ms ?? f.ms;
        if (rt != null && Number.isFinite(+rt)) {
          rt = f.request_time != null || (f.duration_ms == null && f.ms == null && +rt < 1000 && !Number.isInteger(+rt)) ? +rt : +rt / 1000;
          timed++;
          p.sum += rt;
          p.timed++;
          if (rt > p.max) p.max = rt;
          if (slow.length < top || rt > slow.at(-1).seconds) {
            slow.push({ seconds: +rt.toFixed(3), status, request: own(clip(`${f.method ?? ""} ${raw}`.trim(), 160)), time: iso(e.t), line: e.line, file: e.file });
            slow.sort((a, b) => b.seconds - a.seconds);
            if (slow.length > top) slow.pop();
          }
        }
        if (size && e.t != null) {
          const i = Math.floor((e.t - start) / size);
          const b = buckets.get(i) ?? [0, 0];
          b[0]++;
          if (status >= 500) b[1]++;
          buckets.set(i, b);
        }
      }, ctl);
      const notes = [...r.notes, ...stats.notes];
      if (!total) {
        const hint = stats.scanned && skipped === stats.scanned ? `the entries of ${names(r.logs)} (${r.logs[0].parts[0]?.det.label}) have no status field, so this is not a request log; use errors or timeline` : await emptyHint(r.logs, w, ctl);
        return { logs: describe(r.logs), window: windowText(w), requests: 0, verdict: `no requests found in ${names(r.logs)}${hint ? `: ${hint}` : ""}`, ...(notes.length ? { notes } : {}) };
      }
      const pct = (a, b) => (b ? +((100 * a) / b).toFixed(1) : 0);
      const all = [...paths.values()];
      const fmt = (t) => (size >= DAY ? iso(t).slice(0, 10) : size >= 60_000 ? iso(t).slice(0, 16) + "Z" : iso(t));
      const rate = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
      const usual = total ? classes["5xx"] / total : 0;
      const overTime = rate.map(([i, [n, e]]) => `${fmt(start + i * size)}  ${n} requests  ${e} 5xx (${pct(e, n)}%)${e >= 5 && e / n >= Math.max(0.2, 3 * usual) ? "  << failing" : ""}`);
      const worst = rate.filter(([, [n, e]]) => e >= 5 && e / n >= Math.max(0.2, 3 * usual));
      return {
        logs: describe(r.logs),
        window: { since: iso(from), until: iso(to) },
        requests: total,
        byClass: classes,
        statuses: [...statuses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s, c]) => `${s}: ${c}`),
        errorRate: `${pct(classes["5xx"], total)}% 5xx, ${pct(classes["4xx"], total)}% 4xx`,
        failing: all.filter((p) => p.e5).sort((a, b) => b.e5 - a.e5).slice(0, top).map((p) => ({ path: p.path, "5xx": p.e5, of: p.count, share: `${pct(p.e5, p.count)}%` })),
        notFound: all.filter((p) => p.e4).sort((a, b) => b.e4 - a.e4).slice(0, top).map((p) => ({ path: p.path, "4xx": p.e4, of: p.count })),
        busiest: all.sort((a, b) => b.count - a.count).slice(0, top).map((p) => ({ path: p.path, requests: p.count })),
        ...(timed ? { slowestPaths: all.filter((p) => p.timed >= 3).sort((a, b) => b.sum / b.timed - a.sum / a.timed).slice(0, top).map((p) => ({ path: p.path, meanSeconds: +(p.sum / p.timed).toFixed(3), maxSeconds: +p.max.toFixed(3), requests: p.timed })), slowestRequests: slow } : { slowest: "the log has no request time" }),
        clients: [...clients.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([c, n]) => `${c}: ${n}`),
        bucket: size ? bucketName(size) : null,
        failingBuckets: worst.map(([i]) => fmt(start + i * size)),
        overTime,
        ...(skipped ? { notRequests: skipped } : {}),
        ...(notes.length ? { notes } : {}),
      };
    },

    /**
     * Two logs, or two windows of one log, compared by signature: the kinds only in one, and those
     * whose count changed most. a and b are each a file, or {file?, since?, until?}. By default only
     * warnings and errors are compared; all: true compares every entry.
     */
    async compare(a, b, o = {}) {
      const side = (x, name) => {
        if (x == null || x === "") throw new Error(`compare needs ${name}: a file, or a window of the same file as {since, until}`);
        return typeof x === "object" && !Array.isArray(x) ? x : { file: x };
      };
      const A = side(a, "a");
      const B = side(b, "b");
      const ctl = newCtl(o);
      const min = o.all ? null : minLevel(o.level) ?? 3;
      const memo = new Map();
      const read = async (s) => {
        const r = prepare(s.file ?? o.file);
        if (r.error) return r;
        const w = await windowOf(r.logs, s.since, s.until, ctl);
        const counts = new Map();
        const examples = new Map();
        let n = 0;
        const stats = await run(r.logs, { since: w.since, until: w.until }, (e) => {
          if (min != null && !atLevel(e, min)) return;
          n++;
          const sg = sigOf(e, memo);
          const c = counts.get(sg);
          if (c === undefined) {
            if (counts.size >= MAX_SIGS) return;
            counts.set(sg, 1);
            examples.set(sg, { time: e.untimed ? null : iso(e.t), file: e.file, line: e.line, message: own(clip(e.msg, 200)) });
          } else counts.set(sg, c + 1);
        }, ctl);
        return { r, w, counts, examples, n, stats };
      };
      // The two sides do not depend on each other: read them at the same time.
      const [ra, rb] = await Promise.all([read(A), read(B)]);
      if (ra.error) return { error: `a: ${ra.error}` };
      if (rb.error) return { error: `b: ${rb.error}` };
      const top = Math.max(1, Math.min(+(o.top ?? 8) || 8, 40));
      const onlyA = [];
      const onlyB = [];
      const changed = [];
      let same = 0;
      for (const [s, c] of ra.counts) {
        const d = rb.counts.get(s);
        if (d === undefined) onlyA.push({ signature: s, count: c, example: ra.examples.get(s) });
        else if (d === c) same++;
        else changed.push({ signature: s, a: c, b: d, change: d - c });
      }
      for (const [s, c] of rb.counts) if (!ra.counts.has(s)) onlyB.push({ signature: s, count: c, example: rb.examples.get(s) });
      onlyA.sort((x, y) => y.count - x.count);
      onlyB.sort((x, y) => y.count - x.count);
      changed.sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
      const sideOut = (x) => ({ logs: describe(x.r.logs), window: windowText(x.w), entries: x.stats.matched, compared: x.n, kinds: x.counts.size });
      const notes = [...ra.r.notes.map((n) => `a: ${n}`), ...rb.r.notes.map((n) => `b: ${n}`), ...ra.stats.notes, ...rb.stats.notes];
      return {
        what: o.all ? "every entry" : `entries at ${LEVELS[min]} and above`,
        a: sideOut(ra),
        b: sideOut(rb),
        onlyInA: onlyA.slice(0, top),
        onlyInB: onlyB.slice(0, top),
        changed: changed.slice(0, top),
        unchanged: same,
        ...(onlyA.length > top || onlyB.length > top || changed.length > top ? { leftOut: { onlyInA: Math.max(0, onlyA.length - top), onlyInB: Math.max(0, onlyB.length - top), changed: Math.max(0, changed.length - top) } } : {}),
        counts: { onlyInA: onlyA.length, onlyInB: onlyB.length, changed: changed.length },
        ...(notes.length ? { notes } : {}),
      };
    },

    /**
     * The log files found, each with size, format, time span, number of lines and share of errors.
     * Lines and errors are counted by reading the file, for at most o.budgetMB (default 512) in all.
     */
    async overview(dir, o = {}) {
      const ctl = newCtl(o);
      let logs;
      const notes = [];
      if (dir) {
        const r = prepare(dir);
        if (r.error) return r;
        logs = r.logs;
        notes.push(...r.notes);
      } else {
        logs = group(discover(defaultDirs)).filter((l) => l.parts.length);
        if (!logs.length) return { dirs: defaultDirs.map(show), count: 0, logs: [], notes: [`no log files in ${defaultDirs.map(show).join(", ")}; name a folder or a file, or set LOGS_DIRS`] };
      }
      logs.sort((a, b) => (b.parts.at(-1).mtime ?? 0) - (a.parts.at(-1).mtime ?? 0));
      const max = Math.min(+(o.max ?? 40) || 40, 100);
      let budget = (+(o.budgetMB ?? 512) || 512) << 20;
      // Each log is read on its own: start them all, and keep the rows in order.
      const out = await Promise.all(logs.slice(0, max).map(async (l) => {
        const size = l.parts.reduce((x, p) => x + (p.size ?? 0), 0);
        const row = { log: l.name, ...(l.parts.length > 1 ? { parts: l.parts.length } : {}), size: human(size), format: l.parts.at(-1).det.label };
        if (l.parts[0].error) {
          row.error = l.parts[0].error;
          return row;
        }
        const cost = l.parts.reduce((x, p) => x + (p.gz ? p.size * 8 : p.size), 0);
        if (cost <= budget && !ctl.stopped) {
          budget -= cost;
          let errs = 0;
          let warns = 0;
          let first = null;
          let last = null;
          const stats = await run([l], {}, (e) => {
            if (isError(e)) errs++;
            else if (e.level === 3) warns++;
            if (!e.untimed) {
              first ??= e.t;
              last = e.t;
            }
          }, ctl);
          Object.assign(row, { first: iso(first), last: iso(last), lines: stats.lines, entries: stats.scanned, errors: errs, warnings: warns, errorShare: stats.scanned ? `${+((100 * errs) / stats.scanned).toFixed(1)}%` : "0%" });
          if (stats.notes.length) row.notes = stats.notes;
        } else {
          const b = await bounds([l], ctl);
          Object.assign(row, { first: iso(b.first), last: iso(b.last), lines: null, counted: false });
        }
        return row;
      }));
      if (out.some((x) => x.counted === false)) notes.push("lines and errors were not counted for the logs marked counted: false (the reading budget ran out); run errors on one of them");
      return { ...(dir ? {} : { dirs: defaultDirs.map(show) }), count: logs.length, logs: out, ...(logs.length > max ? { leftOut: logs.length - max } : {}), ...(notes.length ? { notes } : {}) };
    },

    /** The signature of a text, as errors and compare group by it. */
    signature: (text) => signature(redact(String(text ?? ""))),

    /** The settings in use: {workdir, dirs, utcOffset}. */
    where: () => ({ workdir, dirs: defaultDirs.map(show), utcOffsetMinutes: offset / 60000 }),
  };
  return api;
}
