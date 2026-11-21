// Every call reads and nothing writes. A "file" argument is a path (absolute or relative to WORKDIR), a folder,
// the name of a log ("clacks" or "clacks.log"), or several of these separated by commas or in an array. With no
// file, every log found in LOGS_DIRS is read. A rotated set (app.log, app.log.1, app.log.2.gz) is ONE log, read
// oldest part first; name any part and the whole set is read. Gzip files are read through zlib. A log of several
// GB is streamed, not loaded, and every call stops at about 100 s and says so in `notes`.
//
// Formats read: JSON lines (pino, bunyan, winston, Go, structured cloud logs), logfmt, web access logs (combined,
// common), Python logging, syslog, journal exports, npm and plain text with an ISO or other time. A line with no
// time belongs to the entry above it (a stack trace). Levels in any spelling or number.
//
// Credentials (tokens, passwords, cookies, auth headers, URLs with a password, key shapes), email addresses and
// card numbers are replaced with <redacted>, <email> and <card> before a line is parsed, so no result shows them.
// IP addresses and user names are not masked. A search for a masked text finds nothing.
//
// Times in results are ISO, in UTC. A time argument ("since", "until", at.time) is an ISO time or date, a time
// of day ("21:14", on the day the log ends), "2h" or "3d" (before now), "today", "yesterday", or relative to the
// log itself: "last", "last-1h", "first", "first+10m". For a saved log that is not being written now, count from
// its end ("last-1h"), not from now.
//
// Every call returns {error} instead of throwing when a file is missing, a folder holds no logs or the file is
// named like a file of credentials (.env, keys, .netrc); wrong arguments throw with the reason.

type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
type Time = string | number;

interface Entry {
  time: string | null;          // null when the line has no time and no earlier line had one
  level: Level | null;          // null when the line has no level
  message: string;              // clipped to 400 chars; a stack trace follows on further lines (middle folded)
  fields?: Record<string, unknown>; // the other fields of a JSON or logfmt entry, at most 10, text clipped
  line: number;                 // line number in `file`
  file: string;
}
interface LogRef { log: string; parts?: string[]; format?: string }
interface Window { since: string | null; until: string | null }
interface Filter {
  since?: Time; until?: Time;
  level?: Level;                // lowest level; for an entry with no level, error words decide ("failed", "exception")
  grep?: string | RegExp;       // regular expression on the line and its stack trace (case-insensitive)
  where?: Record<string, unknown>; // field conditions on JSON or logfmt entries: {status: 502}, {status: {gte: 500}}, {path: {contains: "/clacks"}}; operators eq ne gt gte lt lte contains re
  timeoutMs?: number;
}

declare const logs: {
  // The log files in a folder (default LOGS_DIRS), newest written first. A rotated set is one row.
  files(dir?: string, o?: { max?: number }): Promise<{ dirs: string[]; count: number; logs: { log: string; parts?: string[]; size: string; bytes: number; modified: string; format: string; first: string | null; last: string | null; error?: string }[]; leftOut?: number } | { error: string }>;

  // The same with the number of lines, the share of errors and warnings, read from each log (budgetMB 512 in all).
  // dir may be a folder or one log.
  overview(dir?: string, o?: { max?: number; budgetMB?: number }): Promise<{ dirs?: string[]; count: number; logs: { log: string; parts?: number; size: string; format: string; first: string | null; last: string | null; lines: number | null; entries?: number; errors?: number; warnings?: number; errorShare?: string; counted?: false; error?: string }[]; leftOut?: number; notes?: string[] } | { error: string }>;

  // The kinds of error, most frequent first. Entries that differ only in numbers, ids, hosts, paths, times and
  // quoted text share a `signature` ("connection refused to tower <n> at <ip>"). Default level: error and above;
  // level: "warn" adds warnings. With since, `new` marks the kinds that appear nowhere before the window (only
  // when the log holds something before it). top default 10, at most 50. The place to start for "which errors".
  errors(file?: string | string[], o?: Filter & { top?: number }): Promise<{ logs: LogRef[]; window: Window; entries: number; errors: number; kinds: number; new?: number; newSignatures?: string[]; top: { signature: string; count: number; first: string | null; last: string | null; levels: string; new?: boolean; example: Entry }[]; leftOut?: number; notes?: string[]; lines: number; bytes: number } | { error: string }>;

  // When a text or signature first appeared: that entry, the entries just before it, the count, the last time and
  // the counts per hour (per day over 36 hours). Exactly one of text (literal), regex, signature. A signature
  // is the text errors printed, or a part of it. Searches the whole log unless since/until are given.
  firstSeen(file?: string | string[], o: { text?: string; regex?: string; signature?: string; since?: Time; until?: Time; before?: number }): Promise<{ logs: LogRef[]; window: Window; what: string; count: number; first: Entry; signature: string; last: { time: string | null; file: string; line: number } | null; before: Entry[]; over: "per hour" | "per day"; counts: string[]; perLog?: { log: string; count: number; first: string | null }[]; notes?: string[] } | { logs: LogRef[]; count: 0; verdict: string; notes?: string[] } | { error: string }>;

  // The entries around a point. at is exactly one of: {time}, {line} (one file), {grep} (first match, at.nth for
  // a later one), {id} (every entry holding this literal text, such as a request id; default no context).
  // before/after default 10 entries (0 for id), limit 60. With several logs, entries are merged by time; for grep,
  // logs that do not hold the text show what they said at that moment. The anchor entries carry hit: true.
  around(file: string | string[] | undefined, at: { time?: Time; line?: number; grep?: string; id?: string; nth?: number }, o?: { before?: number; after?: number; limit?: number; clip?: number; trace?: number; fields?: boolean | string[] }): Promise<{ logs: LogRef[]; anchor: { time?: string; line?: number; file?: string }; matches?: number; entries: (Entry & { hit?: true })[]; leftOut?: number; notes?: string[] } | { logs: LogRef[]; matches: 0; entries: []; verdict: string } | { error: string }>;

  // Entries per bucket of time with warnings and errors apart. spikes: buckets at 3 times the median and 5 or more
  // above it. bucket "10s", "1m", "1h", "1d" (default follows the window, 500 at most). buckets are text lines.
  timeline(file?: string | string[], o?: Filter & { bucket?: string }): Promise<{ logs: LogRef[]; window: Window; bucket: string; entries: number; errors: number; warnings: number; usual: { entries: number; errors: number }; spikes: { at: string; entries: number; errors: number; of: string }[]; buckets: string[]; notes?: string[] } | { error: string }>;

  // A web access log, or any log whose entries have a status field: counts by status class, the paths with most
  // 5xx and 4xx, the busiest and slowest paths (with a request time field), clients, the 5xx rate over time.
  // Paths are grouped: /users/42 and /users/77 are one path. path keeps requests whose path contains the text.
  requests(file?: string | string[], o?: { since?: Time; until?: Time; path?: string; grep?: string; top?: number }): Promise<{ logs: LogRef[]; window: Window; requests: number; byClass: Record<string, number>; statuses: string[]; errorRate: string; failing: { path: string; "5xx": number; of: number; share: string }[]; notFound: { path: string; "4xx": number; of: number }[]; busiest: { path: string; requests: number }[]; slowestPaths?: { path: string; meanSeconds: number; maxSeconds: number; requests: number }[]; slowestRequests?: unknown[]; clients: string[]; bucket: string | null; failingBuckets: string[]; overTime: string[]; notRequests?: number; notes?: string[] } | { requests: 0; verdict: string } | { error: string }>;

  // Two logs, or two windows of one log, compared by signature: kinds only in a, only in b, and those whose count
  // changed most. a and b are each a file or {file?, since?, until?}; with {since, until} and o.file, the same log.
  // Default warnings and above; all: true compares every entry; top default 8.
  compare(a: string | { file?: string; since?: Time; until?: Time }, b: string | { file?: string; since?: Time; until?: Time }, o?: { file?: string; all?: boolean; level?: Level; top?: number }): Promise<{ what: string; a: unknown; b: unknown; onlyInA: unknown[]; onlyInB: unknown[]; changed: { signature: string; a: number; b: number; change: number }[]; unchanged: number; counts: Record<string, number>; leftOut?: unknown; notes?: string[] } | { error: string }>;

  // The entries that pass the filters, as Entry, in time order: the first `limit` (default 50, at most 500), or the
  // latest with last: true. fields: true (default), false or a list of names. clip, trace: message length and stack lines.
  scan(file?: string | string[], o?: Filter & { limit?: number; last?: boolean; count?: boolean; fields?: boolean | string[]; clip?: number; trace?: number }): Promise<{ logs: LogRef[]; window: Window; scanned: number; matched: number; entries: Entry[]; leftOut?: number; kept?: string; notes?: string[] } | { error: string }>;

  // fn(entry) for every entry that passes the filters, for a count or a sum of your own. entry is
  // {t (epoch ms), time, level, message, fields (all of them), line, file, trace}. Return false to stop.
  each(file: string | string[] | undefined, o: Filter, fn: (e: { t: number | null; time: string | null; level: Level | null; message: string; fields: Record<string, unknown>; line: number; file: string; trace: string[] | null }) => unknown): Promise<{ scanned: number; matched: number; notes?: string[] } | { error: string }>;

  // The last n entries (default 20, at most 200) of ONE log, read from its end.
  tail(file: string, n?: number, o?: { clip?: number; trace?: number; fields?: boolean | string[] }): Promise<{ log: string; format: string; entries: Entry[]; notes?: string[] } | { error: string }>;

  // The signature of a text, as errors and compare group by it.
  signature(text: string): string;

  // The settings in use: {workdir, dirs (where logs are looked for with no file), utcOffsetMinutes}.
  where(): { workdir: string; dirs: string[]; utcOffsetMinutes: number };
};
