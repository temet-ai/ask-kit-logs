export const meta = {
  purpose:
    "What a web access log (nginx, Apache or a JSON log with a status field) says: requests by status class, the paths that fail most (5xx) or are missing (4xx), the busiest and slowest paths, the clients that send most, and the buckets of time where 5xx spiked. Paths are grouped (/users/42 and /users/77 are one path). For 'is the site returning 502s', 'which endpoint fails', 'when did it start'.",
  params: {
    file: "an access log or its name; default every log found (logs that are not request logs report that)",
    since: "start of the window",
    until: "end of the window",
    path: "only requests whose path contains this text",
    top: "rows per list, default 5",
  },
  returns: "{verdict, logs, window, requests, byClass, statuses, errorRate, failing:[{path, 5xx, of, share}], notFound, busiest, slowestPaths?, slowestRequests?, clients, bucket, failingBuckets, overTime:[lines], notes?}",
  example: 'await scripts.run("requests", { file: "access.log", since: "last-1h" })',
};

export default async function ({ logs }, { file, since, until, path, top } = {}) {
  const r = await logs.requests(file || undefined, { since, until, path, top: top ? +top : undefined });
  if (r.error) return { verdict: r.error, ...r };
  if (r.verdict) return { verdict: r.verdict, ...r };
  const f = r.failing[0];
  const verdict = `${r.requests} requests, ${r.errorRate}${f ? `; most 5xx on ${f.path} (${f["5xx"]} of ${f.of})` : ""}${r.failingBuckets.length ? `; failing at ${r.failingBuckets.slice(0, 3).join(", ")}` : ""}`;
  return { verdict, ...r };
}
