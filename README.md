# ask-kit-logs

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about log files on disk. A cheap model reads the logs outside your agent's
context and answers with the file, the line, the time and the count. It reads JSON lines, logfmt,
web access logs, Python logging, syslog and plain text with a time in it, as single files, gzipped
files, or rotated sets (`app.log`, `app.log.1`, `app.log.2.gz`, read as one log).

Questions it is for:

- Which errors happen most in `logs/app.log`, and which only started today?
- When did "semaphore flag stuck" first appear, and what did the log say just before?
- What happened for request `req-7f3a91c2`, across the app log and the access log?
- When did the 502s start, and on which path?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) 0.3 or later and Node.js. Nothing
else.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-logs
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-logs        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-logs --yes  # installs and enables it
```

Restart your agents so `ask` lists `logs`. Three settings, all optional:

- `WORKDIR`: the folder relative paths resolve against; by default the folder the agent runs in.
- `LOGS_DIRS`: where logs are looked for when a question names none, comma separated; by default
  `./logs`, `./log` and `/var/log`.
- `LOGS_UTC_OFFSET`: the offset of log lines that carry no zone, such as `+02:00`; by default UTC.

## What it carries

`logs.mjs` streams a log from start to end a chunk at a time, so a log of several GB is not held in
memory, and every call stops at about 100 seconds and says so. `parse.mjs` holds the format
readers, the error signature (the same error with other numbers, ids, hosts and paths is one kind)
and the masking. `api.d.ts` says what each call returns.

Scripts (each also runs with no model, `ask-kit run logs <script> key=value`):

- `overview`: which logs there are, their format, the time they span, lines and share of errors.
- `errors`: the kinds of error, most frequent first, with `new` for kinds not seen before the window.
- `first-seen`: when a text, regex or error signature first appeared, how often since, the entries before it.
- `around`: the entries around a time, a line, the first match of a regex, or every entry holding a request id.
- `timeline`: entries, warnings and errors per bucket of time, with the spikes marked.
- `requests`: a web access log by status class, failing and slowest paths, and when 5xx spiked.

The skill `incident` is the steps for "what went wrong": the burst, the kinds, when it started,
one case followed by its id. There are no roles.

## What it can change

Nothing. It opens files for reading, and `logs.mjs` has no call that writes, deletes or runs a
program. The investigator's answers go to a cloud model, so:

- Tokens, passwords, cookies, authorization headers, URLs with a password and strings shaped like
  known keys are replaced with `<redacted>`, email addresses with `<email>` and card numbers
  (digits that pass the Luhn check) with `<card>`, before a line is parsed. A search for a masked
  text finds nothing. The masking is by pattern: a secret in an unusual form can get through, and
  IP addresses and user names are not masked.
- A path named like a file of credentials (`.env`, `.npmrc`, `.netrc`, keys, `credentials`,
  anything under `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`) is refused, and folders are not
  searched for them.

## How well it works

`bench/questions.json` holds nine questions that run with no model and three for a model. The
nine run against `bench/fixture/logs/`, a made-up set of logs that `bench/fixture/build.mjs`
generates (a rotated JSON-lines set with one gzipped part, a web access log, a Python log with
tracebacks, a token and an email address planted to check the masking). On 2026-11-21 each script was run once on the fixture, and the
nine shots were run one by one with `ask-kit run` and matched their expectations. Each script was
also run on real logs: a rotated `tracing` log, a system package log, a folder of logs, and a
116 MB file of carriage-return progress output.

The three model questions have not been run and `ask-kit kit test logs` has not been run, so
there is no measure of the model's answers yet. No log over 1 GB was tried.

MIT licence. [RECIPE.md](RECIPE.md) says what it reads and runs, and how to rebuild it.
