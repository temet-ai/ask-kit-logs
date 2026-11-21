# Recipe: the logs kit

## What it answers

Which errors a log has and which are new, when an error first appeared and how often since, what
the log said around a time, a line or a request id, when a burst of errors started, what a web
access log says (5xx by path, slowest paths), how two logs or two windows of a log differ. It does
not act: nothing in it writes.

## What it needs

- ask-kit 0.3 or later (`min_ask_kit = "0.3.0"`) and Node.js. No program, no package, no token.
- Settings, all optional: `WORKDIR` (detected: the folder the agent runs in), `LOGS_DIRS` (where to
  look when no log is named; default `./logs`, `./log`, `/var/log`), `LOGS_UTC_OFFSET` (for lines
  without a zone).

## What it reads and runs

It reads the log files that a question names, or finds, and nothing else. Finding means walking the
search folders three levels deep (at most 20000 entries; `node_modules`, `.git`-style dot folders,
`target`, `vendor`, `dist`, `build` and `journal` are skipped) for names that look like logs
(`*.log`, `*.out`, `*.err`, `*.jsonl`, `*.ndjson`, `*.log.1`, `*.log.2.gz`, `syslog`, `messages`).
A file is streamed in 1 MB chunks, gzip through zlib, UTF-8 or UTF-16 with a byte-order mark. Lines
over 64 KB are cut. The head of a file (64 KB) gives its format and first time; its last 256 KB gives
its last time. It runs no program, and spawns no process.

Refused: a path named like a file of credentials (`.env*`, `.npmrc`, `.netrc`, `.pgpass`,
`.git-credentials`, `.htpasswd`, `shadow`, `sudoers`, private keys and certificates, `credentials`,
`secrets`, shell histories, anything under `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`).

Masked before a line is parsed, because answers go to a cloud model: values of keys that look like a
password, token, secret, api key, access key, cookie, session id, signature or authorization header;
`Bearer` and `Basic` credentials; the password in `scheme://user:password@host`; private key blocks;
JWTs, GitHub, OpenAI-style, AWS and Slack key shapes (`<redacted>`); email addresses (`<email>`);
card numbers that pass the Luhn check (`<card>`). JSON lines are parsed first, so a field named like a
credential is replaced as a whole. Not masked: IP addresses, user names, free text.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.logs`, name `logs`, `says`, `keywords`, `route_hint`,
`cite`, the settings above, one `[[sources]]` of kind `module`, name `logs`, module `logs.mjs`, api
`api.d.ts`, `instructions = "instructions.md"`, `scripts = "scripts"`, and two reading `[[actions]]`:
`errors` for "which errors happen most in <file>" and `overview` for "what log files are there").

`parse.mjs` has no file access. `detect(lines, ctx)` picks a format from the first 200 non-blank
lines and returns a parser per line: JSON lines (time, level and message keys of pino, bunyan,
winston, Go, cloud logs; numeric levels), logfmt, combined and common access logs, Python logging,
syslog and RFC 5424, npm, and a fallback of any line that starts with or holds a time and a level
word. `signature(text)` replaces times, UUIDs, quoted strings, emails, IPs, paths, hex, durations,
sizes, ids and numbers (keeping status and exit codes) so the same error reads as one text.
`redact` and `redactValue` do the masking.

`logs.mjs` exports `make({settings, push})` returning the `logs` global: `files`, `overview`, `scan`,
`each`, `tail`, `around`, `errors`, `timeline`, `firstSeen`, `requests`, `compare`, `signature`,
`where`. A rotated set is grouped by file name (a trailing `.1`, a date, `.gz` removed) and read
oldest part first. Times are UTC; a time argument takes an ISO time, a date, a time of day, `2h`,
`today`, `last-1h` and `first+10m`. Every read has a time limit of about 100 seconds and says so when
it stops.

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and
`export default async function ({logs}, params)`, each returning a `verdict` first): `overview`,
`errors`, `first-seen`, `around`, `timeline`, `requests`. `skills/incident.md` is the playbook for
"what went wrong".

`bench/fixture/build.mjs` writes `bench/fixture/logs/` from a seeded generator: `clacks.log`,
`.1` and `.2.gz` (JSON lines, 8 to 10 November 2026, with the error `semaphore flag stuck` first at
14:02:11 on the 10th in request `req-7f3a91c2`, a bearer token in one entry and an email in
another), `gate.access.log` (a combined log with 502s on `POST /clacks/relay/<n>` between 14:00 and
14:20) and `watch.log` (Python logging with two tracebacks, an email and a token). `bench/questions.json`
has nine shots (`do`) with expectations checked against their output, and three questions (`q`) for a
model.

## Results

On 2026-11-21 the nine shots were run one by one with `ask-kit run logs <script>` and matched their
expectations. `ask-kit kit test logs` and the model questions have not been run.
