export const meta = {
  purpose:
    "Which log files there are, and what each holds: size, format, the time it starts and ends, how many lines, and the share of errors. A rotated set (app.log, app.log.1, app.log.2.gz) is one log. Start here when the question does not name a log, or to see whether a log is current.",
  params: { dir: "a folder or a log file; default the folders in LOGS_DIRS (./logs, ./log and /var/log)", max: "logs listed, default 40" },
  returns: "{verdict, dirs?, count, logs:[{log, parts?, size, format, first, last, lines, entries, errors, warnings, errorShare}], leftOut?, notes?}",
  example: 'await scripts.run("overview", { dir: "var/log/clacks" })',
};

export default async function ({ logs }, { dir, max } = {}) {
  const r = await logs.overview(dir || undefined, max ? { max: +max } : {});
  if (r.error) return { verdict: r.error, ...r };
  const worst = [...r.logs].filter((l) => l.errors).sort((a, b) => b.errors - a.errors)[0];
  const verdict = r.count
    ? `${r.count} ${r.count === 1 ? "log" : "logs"}${worst ? `; most errors in ${worst.log} (${worst.errors}, ${worst.errorShare} of its entries)` : "; no errors counted"}`
    : "no log files found";
  return { verdict, ...r };
}
