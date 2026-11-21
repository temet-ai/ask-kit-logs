// Builds bench/fixture/logs/: the Ankh-Morpork clacks, as three kinds of log file with fixed
// contents (a seeded generator), so the bench questions have fixed answers.
//   clacks.log, clacks.log.1, clacks.log.2.gz   JSON lines, one rotated set, 8 to 10 November 2026
//   gate.access.log                              a web server's access log, 10 November 13:00 to 16:00
//   watch.log                                    plain text with Python tracebacks, 10 November
// Run: node bench/fixture/build.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "logs");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

let seed = 20261110;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[int(0, a.length - 1)];
const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
const iso = (t) => new Date(t).toISOString();
const at = (day, h, m, s = 0, ms = 0) => Date.UTC(2026, 10, day, h, m, s, ms);

// ---- clacks: JSON lines --------------------------------------------------------------------
const towers = [3, 6, 9, 14, 21, 27];
function clacksDay(day, endHour, errorPlan) {
  const rows = [];
  const total = Math.round((endHour * 60) / 9);
  for (let i = 0; i < total; i++) {
    const t = at(day, 0, 0) + i * 9 * 60_000 + int(0, 8) * 60_000 + int(0, 59_000);
    const tower = pick(towers);
    rows.push({ t, level: "info", msg: "message relayed", tower, request_id: `req-${hex(8)}`, ms: int(12, 140) });
    if (i % 7 === 3) rows.push({ t: t + 400, level: "warn", msg: `retrying relay to tower ${tower}`, tower, attempt: 2 });
  }
  for (const [kind, n] of Object.entries(errorPlan)) {
    for (let i = 0; i < n; i++) {
      const t = at(day, 0, 0) + int(0, endHour * 3600 - 1) * 1000 + int(0, 999);
      const tower = pick(towers);
      if (kind === "refused") rows.push({ t, level: "error", msg: `connection refused to tower ${tower} at 10.0.3.${int(2, 40)}:7001`, tower, request_id: `req-${hex(8)}` });
      else rows.push({ t, level: "error", msg: `relay timed out after 30s waiting for tower ${tower}`, tower, request_id: `req-${hex(8)}` });
    }
  }
  return rows;
}
const line = (r) => {
  const { t, level, msg, ...rest } = r;
  return JSON.stringify({ time: iso(t), level, msg, ...rest });
};
const sorted = (rows) => rows.sort((a, b) => a.t - b.t);

const day8 = sorted(clacksDay(8, 24, { refused: 12, timeout: 6 }));
const day9 = sorted(clacksDay(9, 24, { refused: 14, timeout: 5 }));
const day10 = clacksDay(10, 18, { refused: 11, timeout: 7 });
// The new error: first at 14:02:11 on the 10th, in request req-7f3a91c2, then 8 more until 14:40.
const rid = "req-7f3a91c2";
day10.push(
  { t: at(10, 14, 2, 9, 120), level: "info", msg: "message relayed", tower: 6, request_id: rid, ms: 31, headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJnb3Zlcm5vciJ9.c2lnbmF0dXJlMDAwMA" } },
  { t: at(10, 14, 2, 10, 40), level: "warn", msg: "retrying relay to tower 6", tower: 6, request_id: rid, attempt: 2 },
  { t: at(10, 14, 2, 11, 5), level: "error", msg: "semaphore flag stuck on tower 6: expected 7 got 3", tower: 6, request_id: rid },
  { t: at(10, 14, 2, 11, 900), level: "error", msg: `relay failed for user carrot.ironfoundersson@watch.ankh-morpork.example after 3 attempts`, tower: 6, request_id: rid },
);
for (let i = 0; i < 8; i++) day10.push({ t: at(10, 14, 5 + i * 5, int(0, 59)), level: "error", msg: `semaphore flag stuck on tower ${pick([6, 6, 9])}: expected ${int(1, 9)} got ${int(1, 9)}`, tower: 6, request_id: `req-${hex(8)}` });
sorted(day10);

fs.writeFileSync(path.join(dir, "clacks.log.2.gz"), zlib.gzipSync(day8.map(line).join("\n") + "\n"));
fs.writeFileSync(path.join(dir, "clacks.log.1"), day9.map(line).join("\n") + "\n");
fs.writeFileSync(path.join(dir, "clacks.log"), day10.map(line).join("\n") + "\n");

// ---- gate.access.log: combined log format ---------------------------------------------------
const paths = ["/clacks/relay/", "/clacks/status", "/towers/", "/guild/ledger", "/watch/reports/"];
const out = [];
const clf = (t) => {
  const d = new Date(t);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${mon}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};
for (let i = 0; i < 1400; i++) {
  const t = at(10, 13, 0) + Math.floor((i / 1400) * 3 * 3_600_000);
  const spike = t >= at(10, 14, 0) && t < at(10, 14, 20);
  const p = pick(paths);
  const full = p.endsWith("/") ? p + int(1, 400) : p;
  let status = pick([200, 200, 200, 200, 200, 200, 304, 200, 404, 200]);
  if (spike && p === "/clacks/relay/" && rnd() < 0.8) status = 502;
  const method = p === "/clacks/relay/" ? "POST" : "GET";
  out.push(`10.0.${int(0, 3)}.${int(2, 200)} - - [${clf(t)}] "${method} ${full} HTTP/1.1" ${status} ${int(120, 9000)} "-" "clacks-client/2.4"`);
}
fs.writeFileSync(path.join(dir, "gate.access.log"), out.join("\n") + "\n");

// ---- watch.log: plain text with tracebacks --------------------------------------------------
const w = [];
const stamp = (h, m, s, ms) => `2026-11-10 ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
w.push(`${stamp(13, 58, 2, 114)} INFO watch.patrol: patrol 41 started from Pseudopolis Yard`);
w.push(`${stamp(13, 58, 40, 5)} INFO watch.patrol: patrol 41 reached Treacle Mine Road`);
w.push(`${stamp(14, 3, 5, 412)} ERROR watch.relay: could not relay report 8812 to the Yard`);
w.push("Traceback (most recent call last):");
w.push('  File "/srv/watch/relay.py", line 88, in send');
w.push("    tower.wait(30)");
w.push('  File "/srv/watch/tower.py", line 17, in wait');
w.push("    raise TowerError(self.number)");
w.push("watch.tower.TowerError: tower 6 did not answer");
w.push(`${stamp(14, 3, 6, 20)} WARNING watch.relay: falling back to the courier for report 8812`);
w.push(`${stamp(14, 9, 31, 777)} ERROR watch.relay: could not relay report 8830 to the Yard`);
w.push("Traceback (most recent call last):");
w.push('  File "/srv/watch/relay.py", line 88, in send');
w.push("    tower.wait(30)");
w.push('  File "/srv/watch/tower.py", line 17, in wait');
w.push("    raise TowerError(self.number)");
w.push("watch.tower.TowerError: tower 6 did not answer");
w.push(`${stamp(14, 12, 0, 1)} INFO watch.auth: login by vimes@watch.ankh-morpork.example with token=tk_live_9f8e7d6c5b4a39281706 from 10.0.1.17`);
w.push(`${stamp(14, 12, 44, 300)} INFO watch.patrol: patrol 42 started from Pseudopolis Yard`);
fs.writeFileSync(path.join(dir, "watch.log"), w.join("\n") + "\n");

for (const f of fs.readdirSync(dir).sort()) console.log(f, fs.statSync(path.join(dir, f)).size);
