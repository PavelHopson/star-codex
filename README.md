# Star Codex

Local Codex tool inspired by Claudish's explicit provider selection and request controls.
Original implementation, not a fork. No upstream source or Claude prompts/configuration
are copied. No npm dependencies, install hooks, global configuration changes or cloud
credentials. Node.js 22+; tested using Node 24 on Windows.

## Current scope

- Native Responses API HTTP/SSE gateway, exact model per named profile.
  Function/custom tools and their native Codex namespaces are passed through.
- Literal 127.0.0.1 upstream only. Use a separately authorized SSH tunnel for a remote
  StarAI endpoint; this tool never opens that tunnel or changes the server.
- Per-session request count and per-process concurrency limits; no queue, retry or
  fallback. Timeout covers body upload and the full upstream stream.
- Bounded input/output bytes and requested output tokens. Token limit is a request
  to the provider, not a hard GPU/RSS/financial cap.
- Ephemeral bearer token, no browser access, no forwarded auth/cookies/errors,
  no external media URLs or hosted tools. Unknown routes fail closed.
- Isolated Codex home under `.runtime`, read-only sandbox, approval policy on-request.
  No edits or deployment tools enabled by this wrapper. Never use as a security
  boundary against a malicious local OS user or a compromised Codex binary.
- Audit records contain counts, status and elapsed time only. No token/prompt/output
  logs. `cost: null` means NOT MEASURED, not free. Transport completion is not model
  correctness or a successful tool execution. Codex's own files may contain content;
  keep `.runtime` private and do not publish it.

The example `local-code` model name is historical, not verified available. Configure
an installed model that really supports Responses + streaming + function tools.
Chat Completions-only endpoints are NOT translated. Vision is disabled by default;
when explicitly enabled, only embedded PNG/JPEG/WebP data is accepted.

## Windows PowerShell

These checks do not contact a real model or modify a repository:

```powershell
node E:\Star\star-codex\src\cli.mjs check
node E:\Star\star-codex\src\cli.mjs demo
Set-Location E:\Star\star-codex
node --test test/*.test.mjs
```

After separately confirming a compatible local endpoint, run a read-only task.
Resolve the current installed native binary, do not use a shell shim:

```powershell
$codexBinary = (Get-Command codex.exe -ErrorAction Stop).Source
'Describe this repository. Do not change any files.' | node E:\Star\star-codex\src\cli.mjs run --profile local-code --workspace E:\Star\star-codex --codex $codexBinary
```

Failure stops the run; do not blindly retry a real model call. `check` validates
configuration only. `demo` uses a synthetic loopback fixture, not an AI model.
Multiple wrapper instances have independent limits; they do not enforce a shared GPU
budget. The launcher closes its gateway and terminates its directly owned Codex child
on Ctrl+C; it is not an OS process-tree sandbox. Existing project instructions are
still Codex inputs. A malicious project must be reviewed before opening it.
The local endpoint is a trusted operator component: loopback does not prove that
the model server itself has no cloud routing. No OS-wide network isolation is claimed.

## Next integration gates

Verify installed StarAI protocol/capabilities, then a separately authorized real
read-only task: final text, function call/result, cancellation, context compaction
and provider outage. No production routing until that evidence exists. Remote cloud
providers, monetary budget accounting, Chat Completions adapters, image conversion,
shared GPU scheduling and UI are deliberately not implemented in 0.1.

## Sources and attribution

- Claudish architecture inspiration: https://github.com/MadAppGang/claudish
  Upstream package metadata declares MIT; no source copied and no upstream LICENSE
  file was verified. A future source import must retain verified license notices.
- Native provider contract: https://developers.openai.com/codex/config-advanced/
- Configuration fields: https://developers.openai.com/codex/config-reference/

Codex CLI is an external prerequisite, not bundled. This is independent Star tooling,
not an official OpenAI product. No subscription credential reuse.
