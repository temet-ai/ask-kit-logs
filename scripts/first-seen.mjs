export const meta = {
  purpose:
    "When an error or a text first appeared in a log, how many times since, per hour or per day, when it last appeared, and the entries just before the first one. Give one of `text` (literal, any case), `regex`, or `signature` (as the errors script prints it, or a part of it). For 'when did this error start', 'is it new', 'has it happened before'.",
  params: {
    file: "a log file, folder or log name; default every log found. A rotated set is one log",
    text: "a literal text to look for, any case",
    regex: "a regular expression",
    signature: "an error signature from the errors script, or a part of one",
    since: "limit the search to a window starting here",
    until: "and ending here",
    before: "entries kept from just before the first one, default 5",
  },
  returns: "{verdict, logs, what, count, first:{time, level, message, fields, line, file}, signature, last, before:[entries], over, counts:[lines of time and count], perLog?, notes?}",
  example: 'await scripts.run("first-seen", { file: "app.log", text: "semaphore flag" })',
};

export default async function ({ logs }, { file, text, regex, signature, since, until, before } = {}) {
  const r = await logs.firstSeen(file || undefined, { text, regex, signature, since, until, before: before == null ? undefined : +before });
  if (r.error) return { verdict: r.error, ...r };
  if (!r.count) return { verdict: r.verdict, ...r };
  const verdict = `${r.what} first appears ${r.first.time ?? "(untimed)"} at ${r.first.file}:${r.first.line}; ${r.count} ${r.count === 1 ? "time" : "times"}${r.last ? `, last ${r.last.time}` : ""}`;
  return { verdict, ...r };
}
