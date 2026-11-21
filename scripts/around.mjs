export const meta = {
  purpose:
    "What the log said around a moment: a time, a line number, the first entry matching a regex, or every entry holding a text such as a request id. With several logs, the entries of all of them are merged in time order. For 'what happened at 21:14', 'what led up to this error', 'everything for request req-7f3a91c2'.",
  params: {
    file: "a log file, folder or log name; default every log found. A line number needs one file",
    time: 'the moment: an ISO time, "21:14" (on the day the log ends), "last-5m"',
    line: "a line number in one file",
    grep: "a regular expression: the first entry matching it (nth: for a later one)",
    id: "a literal text, such as a request id: every entry holding it, no context",
    nth: "with grep, which match, default 1",
    before: "entries kept before the anchor, default 10 (0 for id)",
    after: "entries kept after it, default 10 (0 for id)",
    limit: "entries returned, default 60",
  },
  returns: "{verdict, logs, anchor, matches?, entries:[{time, level, message, fields, line, file, hit?}], leftOut?, notes?}. Credentials, email addresses and card numbers are masked.",
  example: 'await scripts.run("around", { file: "app.log", id: "req-7f3a91c2" })',
};

export default async function ({ logs }, { file, time, line, grep, id, nth, before, after, limit } = {}) {
  const at = {};
  if (time != null) at.time = time;
  if (line != null) at.line = +line;
  if (grep != null) at.grep = grep;
  if (id != null) at.id = id;
  if (nth != null) at.nth = +nth;
  const o = {};
  if (before != null) o.before = +before;
  if (after != null) o.after = +after;
  if (limit != null) o.limit = +limit;
  const r = await logs.around(file || undefined, at, o);
  if (r.error) return { verdict: r.error, ...r };
  if (r.verdict) return { verdict: r.verdict, ...r };
  const hit = r.entries.filter((e) => e.hit).length;
  const first = r.entries[0];
  const last = r.entries.at(-1);
  const verdict = `${r.entries.length} entries${first?.time ? ` from ${first.time} to ${last.time}` : ""}${r.matches != null ? `; ${r.matches} hold the text` : ""}${hit ? `; ${hit} marked hit` : ""}`;
  return { verdict, ...r };
}
