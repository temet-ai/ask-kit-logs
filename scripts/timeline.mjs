export const meta = {
  purpose:
    "How the entries of a log are spread over time, with warnings and errors counted apart and the buckets that spike marked. For 'when did it start failing', 'was there a burst', 'how did the error rate change'. The bucket size follows the window unless given.",
  params: {
    file: "a log file, folder or log name; default every log found",
    since: "start of the window; default the start of the log",
    until: "end of the window; default the end of the log",
    bucket: 'a length: "10s", "1m", "1h", "1d"; at most 500 buckets',
    level: "count only entries at this level and above",
    grep: "count only entries matching this regular expression",
  },
  returns: "{verdict, logs, window, bucket, entries, errors, warnings, usual:{entries, errors}, spikes:[{at, entries, errors, of}], buckets:[one line per bucket], notes?}",
  example: 'await scripts.run("timeline", { file: "app.log", since: "last-6h", bucket: "5m" })',
};

export default async function ({ logs }, { file, since, until, bucket, level, grep } = {}) {
  const r = await logs.timeline(file || undefined, { since, until, bucket, level, grep });
  if (r.error) return { verdict: r.error, ...r };
  const s = r.spikes[0];
  const verdict = `${r.entries} entries, ${r.errors} errors in buckets of ${r.bucket}; ${r.spikes.length ? `${r.spikes.length} spikes, first at ${s.at} (${s.entries} entries, ${s.errors} errors, usual ${r.usual.entries} and ${r.usual.errors})` : "no spikes"}`;
  return { verdict, ...r };
}
