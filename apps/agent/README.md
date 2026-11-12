# @collab/agent: the project assistant

A Node service that joins every project as Remy, the AI assistant on Claude. She answers people in
the chat and on calls, reads the plan, works out dates and money with tools, and drafts plan changes,
library drops and invoices through the browser of the person who asked. She streams her words and
cards while she writes them, and every reply is stored. **She never approves, sends or pays**: there
is no tool for it, and the database refuses it anyway. She does read PayPal itself:
`check_with_paypal` asks PayPal where this project's invoices and payouts stand, read only (below).

The contract it speaks is `packages/shared/src/agent.ts` (cards, thread rows, commands, stream
events); the tables, RPCs and topic come from `supabase/migrations/20261022040000_assistant.sql`.

## Run it

```sh
pnpm agent:dev                                  # repo root; same as pnpm --filter @collab/agent dev
AGENT_MODE=mock pnpm agent:dev                  # scripted stand-in model: no key, no cost
pnpm --filter @collab/agent smoke ["question"]  # against the running stack and service, as Deepak (cm@demo.local)
pnpm --filter @collab/agent test                # 363 Vitest tests
pnpm --filter @collab/agent typecheck
```

Environment (repo-root `.env.local`; nothing is ever logged but which keys are set):

| Key | Use |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | the stack, service role (reads; writes only `agent_messages` replies and `agent_commands`) |
| `ANTHROPIC_API_KEY` | Claude; needed for `live` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE` | the sandbox REST app the Edge Functions use; with `PAYPAL_MODE=live`, `check_with_paypal` reads PayPal, read only. Otherwise it says PayPal isn't connected here. `PAYPAL_ENV` must be `sandbox` or unset |
| `AGENT_MODE` | `live` / `replay` / `mock`; empty = live with a key, else mock |
| `AGENT_PROJECT_IDS` | optional comma-separated project ids; empty = every project |
| `AGENT_MODEL_ANALYSIS`, `AGENT_MODEL_CHAT` | optional model overrides (below) |
| `AGENT_PROACTIVE` | `off` (default): she answers when asked; `issues`: she also raises a problem she notices |
| `AGENT_OPENING_DELAY_MS` | with `AGENT_PROACTIVE=issues`, the wait before an opening once the meeting can start (default 2000) |
| `AGENT_RECORDINGS_DIR` | where live runs are recorded for replay (default `apps/agent/recordings`) |
| `GANTRY_HOSTED=1` | the hosted site (below); unset, nothing of it runs |
| `GANTRY_PLAN_DATE` | optional `YYYY-MM-DD`: the plan's today, pinned (`src/plan/today.ts`); the watch rules and the watch list count from it, app events carry it and the system prompt names it; unset, the server's own day |
| `PORT` | the hosted health check's port (default 8080) |

Only one instance answers: instances announce themselves with presence on the private topic
`agent-service` and the earliest leads; a second `pnpm agent:dev` logs "standing by" and takes over
when the first stops.

## On the hosted site (Fly.io)

Every visitor works in their own copy of the Harbor project. One instance of the service answers in all twelve
copies, on Fly.io, built from the repo root with `apps/agent/Dockerfile`. Its configuration is environment only:

| Variable | Set in | Value |
|---|---|---|
| `GANTRY_HOSTED` | `fly.toml` (and the image) | `1` |
| `GANTRY_PLAN_DATE` | `fly.toml` | `2026-11-10`, the date the hosted site's pages are pinned to |
| `AGENT_PROJECT_IDS` | `fly.toml` | the copies, `00000000-0000-4000-8000-000000010001` to `…010012` |
| `AGENT_MODEL_ANALYSIS` | `fly.toml` | `claude-sonnet-5-5` (replies are on it already) |
| `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `fly secrets set` | the hosted project's |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MODE` | `fly secrets import` (below) | the sandbox REST app the hosted functions use, and `live`; unset, `check_with_paypal` says PayPal isn't connected |
| `REMY_LINE_SECRET` | `fly secrets import` (below) | the secret shared with Remy's call worker: the service signs every reply it streams and stores (`src/realtime/line-signature.ts`), and her voice says only what it signed. Unset, nothing is signed |

With `GANTRY_HOSTED=1` (`src/hosted.ts`), before a turn calls Claude the service checks `app_flags.live_ai`, then
spends one `use_quota('ai_turn', project)` (40 a copy, 500 a day). If either says no, the turn is one plain reply
("I've reached today's limit for this session. The rest of the app still works.") with no model call, said aloud on a
call; an opening the app would start on its own stays quiet instead. A message over 600 characters gets a polite
refusal and spends nothing. The system prompt adds two rules: decline anything that isn't about the project's plan,
its payments or the app, and use `calculate` only on figures the tools returned, never on factorials, matrices or
numbers over 15 digits. `/healthz` answers 200 while the service runs; if it can't start, it exits and Fly starts it
again.

A turn that runs is held to the hosted turn limits (`HOSTED_TURN_LIMITS` in `src/hosted.ts`; elsewhere they stay as
they were): at most 5 model calls, 4,000 output tokens a call for a written turn, 3,000 for a spoken one (a spoken call
cut off mid tool call before she has said anything runs again once with 4,000; after words, the turn ends with the
apology, so nobody takes a draft that wasn't made as made) and 4,000 for one the app started, every tool result handed back to
the model cut at 8,000 characters with a note saying so, and the system prompt cached for an hour. After each turn,
and each thread title, the service prices the tokens the API reported (`src/llm/pricing.ts`, Sonnet 5.5 at $2 in, $10
out, $0.10 cache reads, $2.50 or $4 cache writes a million tokens) and calls `record_spend('anthropic', …)`
(`supabase/migrations/20261111060000_spend_breaker.sql`). Once a day's budget is spent (Anthropic $15, OpenAI $7.50,
ElevenLabs $3, LiveKit $3, $28.50 in all, UTC days; rows in `spend_limits`, set in
`supabase/migrations/20261111170000_calls_for_judging.sql` and `20261111180000_calls_hardening.sql`), the breaker turns `live_ai` (or `live_calls`)
off, so the next turns get the limit line; at 00:05 UTC pg_cron runs `reset_spend_breaker()`, which turns back on only
what the breaker turned off.

On every site, `calculate` works out plain arithmetic only (`src/plan/calc.ts`): number literals and named values up
to a trillion, `+ - * / ^ %`, brackets, and `round abs min max sum mean median sqrt log`, checked on the parsed tree
before anything is worked out, within 200 ms, and refused at 16 digits or more. Every turn someone is owed ends with
an answer: when the model's answer came back as a hidden note between tool calls (the opener, then nothing), it is
asked once more, and otherwise the turn ends with "I couldn’t finish that." A copy claimed by a new visitor
(`copy_pool.claimed_at` changed) starts with no memory of the last visitor's conversations.

Deploy, from the repo root (the spend breaker's migration goes to the hosted database first, with the others:
`supabase db push --remote`, as in `supabase/README.md`):

```sh
fly apps create gantry-agent       # once; with another name, add --app <name> to the commands below
fly secrets set --app gantry-agent ANTHROPIC_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…
# PayPal for check_with_paypal, read only: the sandbox REST app's key, staged for the next deploy.
{ grep -E '^PAYPAL_CLIENT_(ID|SECRET)=' .env.local; echo 'PAYPAL_MODE=live'; } | fly secrets import --app gantry-agent --stage
# The secret shared with Remy's call worker (set the same value there), from your own secrets file.
grep -E '^REMY_LINE_SECRET=' <your secrets file> | fly secrets import --app gantry-agent --stage
fly deploy . --config apps/agent/fly.toml --dockerfile apps/agent/Dockerfile --ha=false
fly status --app gantry-agent      # one machine, always on; `fly logs --app gantry-agent` follows it
```

One machine, 1 GB, never stopped by traffic (auto-stop off). Pick `primary_region` in `fly.toml` near the Supabase
project.

## How it works

```
 Browser (Chris)          Browser (Deepak)              Postgres + Realtime (local stack)
 post_agent_message ──────────────────────────────────► agent_messages ──trigger──► 'message' {id}
 claims + runs commands ◄─ 'command' {id,status} ◄──── agent_commands ◄──insert── agent service
 workflow buttons ────────────────────────────────────► proposals/approvals/... ─► 'change' on :workflow
 presence (who is here) ─────────────────────────────► project:{id}:presence
 renders 'stream' events ◄──────────── project:{id}:agent ◄─ 'stream' ── agent service
                                                                         │ one ProjectAgent per project
                                                                         │ gate -> AgentBrain -> Claude
                                                                         ▼
                                                              Anthropic Messages API (stream)
```

Per project (`src/project-agent.ts`):

- **Listens** (service role, private channels, `src/realtime/transport.ts`; a closed channel is
  joined again with 1/2/5/10 s backoff): `:presence` listen-only (never tracks; peers parsed like
  `apps/web/src/presence/peers.ts`, 1.5 s debounce), `:workflow` (`change` → re-read, diff,
  300 ms debounce), `:revisions` (`revision` → re-read the plan, 4 s debounce), `:agent` (`message`
  {id} → load the row; `command` {id,status} → wake the command waiter).
- **Triggers** (`src/agent/proactive.ts`): by default only a person's message, or progress on a change
  people put on the table, wakes her. With `AGENT_PROACTIVE=issues` she also raises a problem when a
  meeting starts or the plan changes; the gate decides in code, before any model call: one open issue
  at a time, each raised once, "Not now" snoozes it 30 min, nobody present means nothing. The agent's
  own bookkeeping never triggers a turn.
- **Thinks** (`src/agent/brain.ts`): one append-only thread per project, one streaming tool loop,
  at most 10 model calls a turn (5 on the hosted site), one turn at a time (others queue). On start it reads the last 12
  thread rows and gives them to the model once.
- **Speaks** (`src/realtime/stream.ts`): contract `stream` events, validated before sending; text
  batched to at most 10 events/s, card drafts to at most 5/s per card; tool events and `turn_end`
  flush first so order holds. When the turn ends the reply is stored (`agent_messages`: role
  assistant, author null, channel `app` for app-started turns else the person's channel,
  `turn_id`, text, the grounded cards) and `turn_end` carries its id (null when it stayed quiet).
- **Acts** (`src/agent/commands.ts`, `src/agent/edits.ts`): a plan change, a library drop or an
  invoice draft goes out as an `agent_commands` row for the browser of the person who asked, which
  runs it on the same scheduling engine people edit with. She waits for the `command` event (and
  polls), cancels a command nobody claimed after 30 s and tells the model why, then hands the model
  what the browser reported.

### Tools

The main [README](../../README.md) lists her tools. They're defined in `src/agent/tools.ts` and the
`*-tools.ts` files beside it.

**Grounding** (`src/agent/grounding.ts`): a card is stored and shown only if its money and dates
came from a tool (issue cards from that issue, fix cards from that check, every `$` amount in card
text from a tool result); otherwise the model gets the reason and fixes it in the same turn. `$`
amounts in the spoken reply are checked too and logged as warnings.

### Speaking first

The model talks through the `reply` tool, called first, and its text is streamed while the tool input
is still being written (on these models plain text written before a tool call comes back as a hidden
progress block, so a tool is the reliable way to say something first). A response that only replies
and draws cards ends the turn without another model call.

### Models

| Job | Model | Effort |
|---|---|---|
| Analysis (where a dropped piece belongs, alternatives when a watch rule fires, issues without a pre-check) | `claude-opus-5-5` (`AGENT_MODEL_ANALYSIS`) | medium |
| Replies (text and voice), progress, openings with a pre-checked issue | `claude-sonnet-5-5` (`AGENT_MODEL_CHAT`) | low |

All requests: adaptive thinking, top-level and system prompt caching, `fallbacks: "default"`
(server-side fallback, beta `server-side-fallback-2026-07-01`), `eager_input_streaming` on every tool,
tool list byte-identical on every request. SDK `@anthropic-ai/sdk` 0.132.1 (API version 2023-06-01).

## For the browser

- `stream` events follow `AgentStreamEvent`. `turn_start.speaker_id` is the person answered (null
  for app-started turns). `text_delta.seq` counts from 0 per turn; a second `reply` in the same turn
  (after a command) starts with a `" "` delta.
- Card drafts: `ui_partial.card_id` is the model's tool-use id; the final, grounded card is sent once
  more as a `ui_partial` with the same id and stored with the reply under that id. A `tool` event
  with `state: 'error'` and the same `tool_id` means the draft was withdrawn (it failed grounding);
  drop it. `reply` never appears as a `tool` event.
- The stored reply arrives as `message` {id} (database trigger) and as `turn_end.message_id`; its
  `turn_id` equals the stream's `turn_id`, so the draft can be swapped for the row.
- Person messages: `post_agent_message` leaves `turn_id` null; the agent starts a new turn id.
  Action `not_now` snoozes a raised issue and gets no reply turn; `choice` is answered from its text.
- Commands: the browser of the person who asked claims the `agent_commands` row, runs it and
  completes it with its result, or `{ message }` on failure (shown to people as the reason). A
  command still `pending` after 30 s is withdrawn by the agent (`cancelled`).
- Money: the agent withholds amounts from any thread a member who cannot see costs reads (unless
  someone who sees them shared the costs there): masked in the streamed and stored reply, cards
  without amounts, progress lines written without them (`src/agent/audience.ts`). The app still
  masks `$` amounts in assistant text and cards for members who cannot view costs, as the editor does.

## What it cannot do

Approve, send or pay (by design); answer messages posted while the service was down (no backlog);
remember a conversation across restarts beyond the last thread rows it reads on start.

## Files

| Path | Role |
|---|---|
| `src/main.ts`, `src/service.ts`, `src/project-agent.ts` | entry, one agent per project, wiring |
| `src/env.ts`, `src/log.ts` | configuration from `.env.local`; logs without secrets |
| `src/plan/` | plan from rows (snapshot + revisions), quotes from documents, issue finders, what-if, formatting |
| `src/workflow/` | workflow views (the approval chain, next step) and the progress diff |
| `src/data/` | `ProjectStore` and its Supabase implementation |
| `src/agent/` | brain (loop), tools, commands, gate, grounding, prompts |
| `src/paypal/` | reading PayPal for `check_with_paypal`: the Agent Toolkit for invoices, the shared client for payouts and orders, and the read-only allowlist every request passes first |
| `src/realtime/` | channels with rejoin, presence parsing, stream batching, the single-leader lock |
| `src/llm/` | live (recording), replay and mock clients; the scripted model; SSE |
| `src/dev/` | in-memory database, Realtime and browsers for the tests; the smoke test and the store check |
| `test/` | plan, workflow, gate and grounding, commands and streaming, adapters, configuration, end to end |
