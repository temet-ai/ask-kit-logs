export const meta = {
  purpose:
    "The kinds of error in a log, most frequent first, and which kinds are new. The same error with different numbers, ids, hosts and paths counts as one kind (the signature). With `since`, a kind is new when it does not appear anywhere before the window. For 'which errors happen most', 'what is new since the deploy', 'what broke today'.",
  params: {
    file: "a log file, a folder, or the name of a log (clacks, clacks.log); several separated by commas; default every log found in LOGS_DIRS. A rotated set is read as one log",
    since: 'start of the window: an ISO time, "2h", "3d", "today", "yesterday", "21:14", or relative to the log: "last-1h"; default the whole log',
    until: "end of the window, same forms",
    level: "lowest level counted: warn, error (default) or fatal",
    grep: "only entries matching this regular expression",
    top: "kinds listed, default 10",
  },
  returns: "{verdict, logs, window, entries, errors, kinds, new?, newSignatures?, top:[{signature, count, first, last, levels, new?, example:{time, level, message, fields, line, file}}], leftOut?, notes?}",
  example: 'await scripts.run("errors", { file: "app.log", since: "last-24h" })',
};

export default async function ({ logs }, { file, since, until, level, grep, top } = {}) {
  const r = await logs.errors(file || undefined, { since, until, level, grep, top: top ? +top : undefined });
  if (r.error) return { verdict: r.error, ...r };
  const lead = r.top[0];
  const verdict = r.errors
    ? `${r.errors} errors of ${r.kinds} kinds${r.window.since || r.window.until ? ` in the window` : ""}; most often "${lead.signature}" (${lead.count}, first ${lead.first ?? "untimed"})` +
      (r.new != null ? `; ${r.new} kinds new in the window${r.new ? `: ${r.newSignatures.slice(0, 3).map((s) => `"${s}"`).join(", ")}` : ""}` : "")
    : "no errors in the window";
  return { verdict, ...r };
}
