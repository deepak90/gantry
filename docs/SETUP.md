# Setup

How to run Gantry locally: the Supabase stack, the PayPal Edge Functions, the web app with its
collaborative Bryntum Gantt, Remy's assistant service, the call with Remy, and the test suites. It
covers what is wired today and names what is not. The README's "Run it yourself" is the short version.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22.18 or newer (24 used) | runs the repo's TypeScript scripts directly (built-in type stripping) |
| pnpm | 9.15 | `corepack enable` picks the pinned version from `package.json` |
| Docker Desktop | current | runs the local Supabase stack |
| Supabase CLI | 3.0 or newer | `brew install supabase/tap/supabase` |
| Chromium for Playwright | installed by `pnpm exec playwright install chromium` | only for `pnpm test:e2e` |

Bryntum Gantt is installed from the public **trial** packages on npmjs (`@bryntum/gantt` is an alias
of `@bryntum/gantt-trial@7.3.8`). The repo `.npmrc` pins the `@bryntum` scope to npmjs so every
machine resolves the same public packages; nothing is vendored.

## 1. Install

```sh
pnpm install
```

## 2. Start the database

```sh
pnpm db:start        # supabase start: Postgres 17, Auth, PostgREST, Realtime, Storage, Studio
pnpm db:reset        # supabase db reset: migrations, then supabase/seed.sql and seed_snapshot.sql; then the seed documents
supabase status -o env   # prints API_URL and ANON_KEY for the next step
```

`db:reset` rebuilds the schema (`supabase/migrations`) and creates the two demo users and the seed
projects: Harbor Street Offices, the one project the app lists; twelve unlisted copies of it for a
hosted demo; and two projects reached only by a link, Cedar Park Clinic and Riverside Clinic (the
automated tests' fixture, with a crane rental booked 4 days before the work can use it). Then it
files the seed documents (`scripts/seed-documents.ts`, below), which needs `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local`: on a first run, do step 3 before `pnpm db:reset`, or
run it again after step 3. Run it again whenever a migration or the seed changes. Studio is at
http://127.0.0.1:54323.

## 3. Configure the environment

One gitignored file at the repo root, `.env.local`, feeds every part of the stack (Vite reads it
through `envDir`, scripts load it with `node --env-file`):

```sh
cp .env.example .env.local
```

Set the two values the browser needs:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<ANON_KEY from `supabase status -o env`>
```

A missing or malformed value shows a "Configuration needed" screen that names the variable.

The Edge Functions read the `PAYPAL_*` values from the same file (`pnpm functions:serve` passes it
with `--env-file`; the CLI skips the `SUPABASE_*` names, which the edge runtime sets itself).
`PAYPAL_MODE=mock` needs no PayPal account: payouts get deterministic PayPal-shaped answers and
succeed with a fixed mock fee. For real sandbox payouts, in the
[PayPal Developer Dashboard](https://developer.paypal.com/dashboard/):

1. Switch the **Sandbox** toggle on.
2. Under **Apps & Credentials**, **Create App** of type **Merchant**, then copy its **Client ID**
   and **Secret** into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. In the app's features, make
   sure **Payouts** is enabled.
3. Under **Testing Tools > Sandbox Accounts**, create a sandbox **Personal** account and put its
   email in `PAYPAL_SANDBOX_PAYEE_EMAIL`; payouts to any other address stay unclaimed. The value
   is written into the seeded supplier booking by `pnpm db:reset` (through the generated,
   gitignored `supabase/seed_local.sql`).
4. Set `PAYPAL_MODE=live` and restart `pnpm functions:serve`. Live mode calls
   `api-m.sandbox.paypal.com` only; there is no production mode.
5. Optional: webhooks. PayPal can only call a public URL, so expose the local `paypal-webhook`
   function through a tunnel (for example `ngrok http 54321` or
   `cloudflared tunnel --url http://127.0.0.1:54321`; either exposes the whole local API while it
   runs, so stop it afterwards), add a
   webhook in the app with the URL `<tunnel>/functions/v1/paypal-webhook` subscribed to the
   `PAYMENT.PAYOUTSBATCH.*` and `PAYMENT.PAYOUTS-ITEM.*` events, and put its id in
   `PAYPAL_WEBHOOK_ID`. Without it nothing is lost: the browser polls `paypal-reconcile` while a
   payout is in flight, and polling is the source of truth.

## 4. Run

```sh
pnpm functions:serve # Edge Functions (PayPal) with .env.local; keep it running in its own terminal
pnpm dev             # Vite on http://localhost:5173 (strict port)
pnpm agent:dev       # the assistant service (apps/agent); optional, see "The assistant" below
pnpm demo:reset      # any time: back to the seed state (open browsers must reload)
```

Demo logins (created by `supabase/seed.sql`; the login screen has buttons that fill them in):

| Account | Password | Person | Sees costs |
|---|---|---|---|
| `cm@demo.local` | `demo-cm-2026` | Deepak Jayaram | yes, and approves up to $250,000 |
| `pm@demo.local` | `demo-pm-2026` | Chris Hale | yes, and approves up to $250,000 |

The demo gives both people the same rights. The permission model (roles, cost visibility and
approval limits) stays in the schema and its tests; the simulated teammates of `pnpm crowd` are
members who can't see costs.

What you get after signing in: a header with the project name and one quiet line (handover date,
progress, how many things need a look; click the name for the overview card), the steps of the
work on this project, the other people in the plan, the sync badge (**Synced** / **N pending** /
**Sync error** with Retry / **Out of sync** with Reload) and your menu. Below it a toolbar (search
tasks or crews, **All / In progress / Attention** filters, the **View** menu with grouping, bar
colors, the crew workload and the crew schedule, Undo and Redo, **On-time odds**, zoom, and **Site view**
for the 3D view) over the Gantt, with the side panel's tabs beside it (Task, Watch, Remy, Crews,
Library, Documents, History, Rentals). The column picker at the end of the grid header chooses
columns; a header's menu edits one. Edit anything (drag a bar, double-click a cell, right-click for
the task menu, select cells and use the fill handle or Delete): every change goes through the
`submit_revision` RPC and is broadcast to every open browser.

To see the collaboration, sign in as the other account in a second browser profile or a private
window (the two tabs need separate storage) and edit in either one. Each of you appears as an
avatar in the other's header; move the pointer over the plan to see it arrive on the other screen,
and click the other person's avatar to follow their view (Escape or a scroll of your own stops).

### Changing a rental and paying for it

This walkthrough uses Riverside Clinic, which a link opens:
http://localhost:5173/?project=00000000-0000-4000-8000-000000000001. On Harbor Street Offices the same
steps work on *Erect steel and metal deck*, with the crane on rent from Wed, Nov 25 to Wed, Dec 23, 2026.

On the crane's task (Riverside: *Erect structural steel frame*) open the **Equipment** tab of the side panel:

1. **The rental**: the crane is on rent from Mon, Dec 7 to Thu, Dec 17, 11 days at $600 a day, $6,600, not paid yet. A
   rental is paid for every calendar day, weekends too. The work runs Fri, Dec 11 to Thu, Dec 17, so 4 of those days ($2,400)
   have no work planned; the Sunday inside the work is paid too, and no dates would take it away.
2. **New dates**: type them there, in the Equipment cell, or ask the assistant ("a day either side of the work"). On rent
   Thu, Dec 10 to Fri, Dec 18 is 9 days, $5,400, and the facts say so as you type. That is the whole change: one revision for
   everyone, which Undo takes back. A working day of cover either side is shown as cover, and no rule flags it.
3. **Pay**: **Review payment** shows the amount, the firm and PayPal's fee; **Send payout** sends it. While PayPal processes it the dates are
   locked for everyone, and the side panel, the bar and **Rentals** follow it (processing, paid or failed) with PayPal's fee.
   A PDF receipt is filed on the task.

Pressing Pay writes what the database needs behind it, each step enforced there: a proposal for the dates as they stand, its
check on the scheduling engine (`record_evaluation`, which re-derives every money line), the approvals (`approve_fix`, within
the person's limit) and the payment (`authorize_payment`, `paypal-execute-payout`). `pnpm demo:reset` starts over.

### Project documents

Every project has a file repository: supplier quotes and invoices, payment receipts, site photos,
drawings, reports and other files, each optionally linked to a task. The files live in the private
Storage bucket `documents` at `{project_id}/{uuid}/{file name}` (PDF, PNG, JPEG or plain text, 5 MiB
per file; at most 20 files in a hosted copy's folder) and each one is described by a
`project_documents` row with its kind, size, task and, for generated documents and plain-text
uploads (up to 200 KiB), its plain text for the AI agent.

- **Who sees what**: every member sees the project's documents, except quotes, invoices and
  receipts, which are cost-sensitive and shown only to members who can view costs (the cost
  manager). RLS applies the same rule to the files themselves, so the project manager cannot open
  them either, not even a quote they uploaded.
- **Upload and delete** (`apps/web/src/documents/api.ts`): the browser uploads into the project's
  folder and registers the file with `register_document`; `delete_document` removes a document
  (its uploader or the cost manager) before its file is removed. Payment receipts cannot be
  uploaded or deleted.
- **Payment receipts**: when a payout succeeds (whether `paypal-execute-payout`,
  `paypal-reconcile` or `paypal-webhook` sees it first), the Edge Function files a one-page PDF
  "Payment receipt" for the crane task: amounts, PayPal fee and references, the rental it pays for
  (billable days × day rate) and its dates,
  who approved the dates and the payment, and "PayPal sandbox — no real money moved". Once per
  payment; if filing fails, the next status check of the payout files it. Mock mode files receipts
  too. PayPal Payouts itself issues no invoice: a supplier's invoice is a document the supplier
  sends, uploaded as kind **Invoice**.
- **Seed documents**: `scripts/seed-documents.ts` (run by `pnpm db:reset` and `pnpm demo:reset`) files
  the supplier's quote for the crane booking, a one-page PDF from the fictitious Northgate Equipment
  Rental: the crane at $600.00 a day for 11 days from Mon, Dec 7, 2026 ($6,600.00), not
  invoiced yet (nothing is due until the rental dates are confirmed, then it is paid through PayPal),
  with dates that can be moved or shortened free of charge before delivery. It needs
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` and does nothing when the same
  quote is already there (a quote filed with older wording is replaced). `pnpm demo:reset` removes every other document and,
  through the Storage API, their files.

### The assistant

`apps/agent` is a Node service (`pnpm agent:dev`) that joins every project as the AI assistant. It
reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` from `.env.local`; the
Anthropic key never reaches a browser. `AGENT_MODE=mock` runs a scripted stand-in model that costs
nothing; with a key and no `AGENT_MODE` it uses Claude.

- It answers when asked. With `AGENT_PROACTIVE=issues` it also looks for an issue worth fixing when
  two people are in the plan (for example a crane paid but idle) and, once per issue, says so in the
  assistant thread with a card and an offer to prepare the fix. A "Not now" snoozes the issue for 30
  minutes.
- People write to it in the thread (`post_agent_message`); it answers in the same thread, streaming
  its words and cards on the private topic `project:<id>:agent`, and stores each reply as an
  `agent_messages` row.
- To change a rental it works out the dates with `rental_options` (on the machine's calendar, priced by the day), drafts them
  with `draft_plan_edit` and shows the change; a person applies it. It never approves or pays.
- Only one instance answers: a second `pnpm agent:dev` stands by until the first stops.

`pnpm --filter @collab/agent smoke` posts one question to the
running service as the cost manager and prints the streamed reply (it writes two thread rows;
`pnpm demo:reset` clears the thread). Details: `apps/agent/README.md`.

### The call with Remy

Remy joins a LiveKit call as a participant: each person is heard on their own audio track, and she
answers only lines addressed to her by name (or a follow-up within 8 seconds of her answer). Her
call worker (`apps/remy-call`) hears and speaks; the thinking is the assistant service above, so
`pnpm agent:dev` must be running. Locally the call runs on the Vite dev server, whose routes hand out
the call's tokens.

1. Install LiveKit's server (`brew install livekit` on macOS, `curl -sSL https://get.livekit.io | bash`
   on Linux) and run it in its own terminal: `livekit-server --dev`. It listens on
   `ws://127.0.0.1:7880` with the key `devkey` and the secret `secret`.
2. In `.env.local`: `LIVEKIT_URL=ws://127.0.0.1:7880`, `LIVEKIT_API_KEY=devkey`,
   `LIVEKIT_API_SECRET=secret` and `OPENAI_API_KEY` (her transcription, and her voice by default).
   Optional: set both `ELEVEN_LABS_API_KEY` and `ELEVEN_LABS_VOICE_REMY_KEY` to give her an
   ElevenLabs voice instead of OpenAI's. The `REMY_*` settings in `.env.example` are optional.
3. Run `pnpm remy:call` in its own terminal, and restart `pnpm dev` so the dev server reads the
   LiveKit values (its token route keeps the secret; the browser gets a short-lived token).
4. Open http://localhost:5173/?project=00000000-0000-4000-8000-000000000002&call in two browser
   profiles, signed in as Deepak and as Chris, and allow the microphone.
5. Press **Call Remy** in one; the other sees **Join**. Say "Remy, how's the crane rental looking?"

On one computer both microphones hear you: mute one tab from the call bar (or use two computers),
or Remy hears every line twice. "Call server off" on the header button means `livekit-server` isn't
running.

### The hosted build and deploy

`VITE_GANTRY_HOSTED=1` builds the hosted version of the web app: the landing page at `/`, the app at
`/app`, the Privacy, Terms and Credits pages, and Vercel Web Analytics and Speed Insights (no cookies;
each page is recorded by its route alone). A local build without it keeps the app at `/` and the
landing page at `/landing.html`, and loads no analytics.

In the hosted app there is no sign-in screen: a visitor passes Cloudflare Turnstile
(`VITE_TURNSTILE_SITE_KEY`), is signed in anonymously and claims one of the twelve copies of Harbor
(`claim_copy`); an invite link (`/app?join=<token>`) joins a copy (`join_copy`), and so does its
6-digit code (`join_copy_by_code`). The call is offered when `app_flags.live_calls` is on and asks the
site's own `/api/call/token` and `/api/call/room` (Vercel functions in `api/call/`, built and deployed
with the site; `apps/remy-call/README.md` lists what they read); `VITE_LIVEKIT_URL` names the call
server. A progress payment goes out through the `paypal-progress-payout` function as one Payouts
batch. Touch to talk, the walkthroughs and the dev server's crew payment routes (PayPal's own button)
are not in a hosted build.

```sh
pnpm deploy:site --check   # hosted build and secret scan only: nothing is uploaded
pnpm deploy:site           # the same, then Vercel's own build, the scan again, and an upload of the prebuilt output
```

The scan stops on any hit in the built files: API keys (Anthropic, OpenAI, ElevenLabs, LiveKit,
PayPal), Supabase service-role keys, private keys, paths from this machine, the demo passwords, and
the value of every secret in the repo's env files. Only `.vercel/output` is uploaded.

Once, before the first deploy: `npx vercel@latest login`, then `npx vercel@latest link` in the repo
root (`vercel.json` sets the install and build commands and the output). In the Vercel project's
Production environment variables, set `VITE_GANTRY_HOSTED=1` and the app's other `VITE_` values;
the deploy stops without `VITE_GANTRY_HOSTED=1`. Turn on Analytics and Speed Insights in the
project, and fill the placeholders in `apps/web/src/site/site-config.ts` (the deploy names any left).

## 5. Tests

| Command | What it runs |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` for `packages/shared`, `apps/web`, `apps/agent`, `apps/remy-call`, `apps/clip-studio`, `supabase/functions`, `tests/e2e` and `tests/clips` |
| `pnpm test` | Vitest: shared money, date, schema, rental, progress-payment, watch-rule and seed tests; the web tests (Gantt project model, revision sync against the headless engine, presence and follow, library drops, pay holds and late-payment branches, the odds, payments, the call's captions and protocol); the Edge Function logic with a fake PayPal; the assistant service (`apps/agent`: tools, grounding, plan edits, audiences, watch rules, stream batching, the Supabase adapters with fakes, and whole conversations with the scripted model); Remy's call worker (`apps/remy-call`: addressing, turn taking, barge-in, voice pacing, fillers, the voices with fakes) |
| `pnpm test:db` | pgTAP suite in `supabase/tests` (RLS, `load_project`, `submit_revision`, phantom ids, `save_snapshot`, Realtime, commercial tables, the proposal workflow RPCs, payout bookkeeping and `reset_demo`, project documents and receipts, conversations, the watch list, the payment lock, rental dates, payment approvals, the pool of copies, session codes and names, payment caps); needs the running stack and a freshly reset database (`pnpm db:reset`) |
| `pnpm test:e2e` | Playwright, mostly two Chromium contexts signed in as the two demo users, in ten specs: `presence`, `collab`, `realtime`, `cells`, `rental-editor`, `rental-pay`, `library`, `demos`, `assistant` and `bryntum-plain` (Bryntum's own behavior, see `docs/bryntum-workarounds.md`). With `PAYPAL_MODE=live` and the functions served, the payment specs send real sandbox payouts; `E2E_PAYOUT=succeeded` requires a payout to reach Paid. Needs the stack and `.env.local`; starts the dev server itself (or reuses one on 5173). Screenshots go to `test-results/screenshots` (`E2E_SCREENSHOT_DIR` overrides) |
| `pnpm seed:snapshot` | Regenerates `supabase/seed_snapshot.sql` from `packages/shared/src/seed`; `pnpm test` fails while the file is stale |

The headless scheduling engine runs under Vitest with jsdom (`apps/web/test/setup.ts` shims
`matchMedia`), so engine-backed tests live under `apps/web/test`.

## What is not wired yet

- The crew payment routes with PayPal's own button (`apps/web/paypal-dev.ts`) run only on the Vite
  dev server; the hosted site pays the crews as one
  Payouts batch through the `paypal-progress-payout` function.
- `save_snapshot` is not called yet, so every browser load replays all revisions since the seed snapshot.
- Supplier payout email in the committed seed (`sb-northgate@personal.example.com`) is a
  placeholder; `PAYPAL_SANDBOX_PAYEE_EMAIL` replaces it locally.

## Troubleshooting

- **`Invalid login credentials` right after `pnpm db:reset`**: GoTrue occasionally rejects the
  freshly seeded users for a minute after its container restarts. Retry, or `supabase stop &&
  supabase start`.
- **Port 5173 in use**: Vite is configured with `strictPort`; stop the other process or change
  `apps/web/vite.config.ts`.
- **"Could not open the project … not a member"**: the signed-in user has no `project_members` row.
  The seed adds both demo users; `pnpm db:reset` restores it.
- **Sync badge stays on `N pending`**: the browser cannot reach `submit_revision` (stack down or
  offline). Edits are kept in an outbox and retried; the server deduplicates resubmissions.
- **Console warning "Using the 'project' prop with inner store configurations is not recommended"**:
  a false positive of the Bryntum React wrapper for any `ProjectModel` instance passed as `project`;
  harmless.
- **Realtime**: on a fresh stack the very first broadcast can be dropped before the day's
  `realtime.messages` partition exists; the next revision carries a higher `revision_no`, the gap is
  detected and the missing rows are fetched over REST. A connected client also re-reads the log
  every 30 s and when its tab becomes visible again, so a lost broadcast is caught up without
  waiting for another change.
- **Sync badge shows `Out of sync` with Reload**: the scheduling engine refused a revision and the
  client stopped applying anything after it. Reload boots a fresh client from `load_project`.
- **"The payment service is not reachable"** in the Payment section: the Edge Functions are not
  served. Run `pnpm functions:serve` and press the payout button again; the authorized operation is
  reused, so it is never paid twice.
- **"PayPal is not configured"**: `PAYPAL_MODE=live` without `PAYPAL_CLIENT_ID` /
  `PAYPAL_CLIENT_SECRET`, or credentials PayPal refuses. Fix `.env.local` (or set `PAYPAL_MODE=mock`)
  and restart `pnpm functions:serve`; nothing was sent.
- **Payout stays "Pending at PayPal"** with an *unclaimed* message: the payee email is not one of
  your sandbox Personal accounts. Set `PAYPAL_SANDBOX_PAYEE_EMAIL`, run `pnpm db:reset`, and pay
  again.
- **"This browser … has not received revision N yet"** when paying: the browser is behind the
  project; check the sync badge (Reload if it says Out of sync) and pay again.
