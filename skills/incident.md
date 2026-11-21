Find what went wrong in a log, and what changed just before

1. Read the logs: `await scripts.run("overview", { dir })` for a folder, or `logs.where()` for
   where the kit looks. Take the log the question names; note its first and last time. If the
   question gives a moment ("around 14:00", "since the deploy") and the log ends before it, say so
   and use the end of the log.
2. Find the burst: `await scripts.run("timeline", { file, level: "error" })`. `spikes` lists the
   buckets above the usual rate. If there are none, the problem is not a burst: go to step 3 with
   the whole log.
3. Find the kinds: `await scripts.run("errors", { file, since, until })` with the window around
   the burst (`since` a little before the first spike). `top` has each kind with its count; `new`
   marks those not seen before the window. Write down the kind with the earliest `first` among
   the new ones.
4. Find when it started: `await scripts.run("first-seen", { file, signature })` with the
   signature from step 3. `first` is the first entry and `before` the entries just ahead of it:
   read them for what changed (a restart, a deploy line, a warning that is not usual).
5. Follow one case: take a request id, user or job id from `first.fields` or the message and run
   `await scripts.run("around", { file, id })`. For a log of another service, repeat with that
   service's file: the same id often appears in both. Several files in `file` (comma separated)
   merge their entries in time order.
6. For a web access log, `await scripts.run("requests", { file, since, until })` gives the paths
   that fail and the buckets where 5xx spiked. Compare the time with the error log's burst.
7. When the question is "what is different from yesterday", use
   `await logs.compare({ file, since: "...", until: "..." }, { file, since: "...", until: "..." })`
   (two windows) and report `onlyInB` and `changed` first.

The answer: the time the problem started (from `first-seen`, not from the first spike), the
signature and its count, the entries just before it, one example with its line, and whether it is
still happening (its `last`, against the end of the log). Say which of these the logs could not
answer.
