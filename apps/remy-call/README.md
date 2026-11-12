# @collab/remy-call: Remy on a call

Remy's LiveKit worker. It registers as agent `remy`, joins a project's call (room `project-<projectId>`, or
`project-<projectId>-<lease>` on the hosted site, one room per visit of a copy) when the call's first token asks for
her, hears each person on their own track, and says the lines the host's tab hands it (`remy.say`). Her words are
Claude's replies from the assistant service; this worker only hears and speaks.

## Who may hand her a line

- Only the call's host: whoever has been on the call longest, as every tab works it out (`src/host.ts`). A line from
  anyone else is refused, and when the host leaves, the next longest takes over.
- On the hosted worker, before any sound is made of it (`src/line-limits.ts`): at most 400 characters a line, 2,500
  characters of answers a call, 10 lines a minute, and one line waiting while one plays. Once a call's characters are
  spent she says so once, and her answers stay in the chat.
- With `REMY_LINE_SECRET`, only what the assistant service wrote (`src/line-proof.ts`): the service signs each reply
  (HMAC-SHA256 over `project|turn|text`), the host's tab hands the part it wants said with that proof, and the worker
  says that part of the reply, never the words a tab sends with it. Her fillers and notices are her own.

Every refused line is logged as `say_refused`, with why.

## Leaving

However she leaves (time up, 30 quiet seconds on the hosted worker, everyone gone, nobody came), she sets `remy.leaving=1`, leaves the room at
once, and her sessions close behind her (`src/leaving.ts`). The token route counts a Remy who is leaving, or who has
shown no `lk.agent.state` for 15 seconds, as gone, and sends her again.

## Run it

```sh
pnpm remy:call          # repo root: dev mode on this machine, keys from the root .env.local
pnpm remy:call:prod     # the same worker in production mode (`start`), as LiveKit Cloud runs it
pnpm --filter @collab/remy-call test
```

## Environment

| Variable | Use |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the call server. LiveKit Cloud sets these itself; never set them as secrets |
| `OPENAI_API_KEY` | required: her ears (realtime transcription) and her voice (`gpt-4o-mini-tts`, pace- and fry-checked) |
| `ELEVEN_LABS_API_KEY`, `ELEVEN_LABS_VOICE_REMY_KEY` | optional: her ElevenLabs voice instead of OpenAI's. The hosted worker uses them |
| `GANTRY_HOSTED` | `1` on the hosted worker (the Dockerfile sets it): turns the call limits below, and the limits on her lines, on |
| `REMY_LINE_SECRET` | optional: the secret the assistant service signs her replies with (the same value as the service's). Set, she says only signed lines. Hosted: a LiveKit secret, set after the site and the service sign |
| `REMY_CALL_MAX_S` | a call's length in seconds: a wrap-up line 30 seconds before, then she leaves and the room is deleted, ending the call for everyone. Her `remy.ends_at` attribute tells every tab when, for the time left on the call bar. Default 300 hosted, 0 (unlimited) otherwise. The hosted site also sends her with `endsAt` (ms) in the dispatch's metadata, when the call's share of the visit's minutes runs out; the call ends at whichever comes first |
| `REMY_SILENCE_S` | seconds nobody speaks before she says goodbye and leaves. Default 30 hosted, where the room goes with her and the call ends for everyone; 0 (never) otherwise, where the people may stay |

A value set for `REMY_CALL_MAX_S` or `REMY_SILENCE_S` applies on any machine; without `GANTRY_HOSTED=1` and without
them, calls run as long as people stay.

## Deploy to LiveKit Cloud

The worker builds from this folder alone: it imports nothing from the rest of the repo, and `pnpm-lock.yaml` here
pins its dependencies at the workspace's versions. After changing them, run `pnpm --filter @collab/remy-call lockfile`.

```sh
cd apps/remy-call
lk cloud auth                                    # once: link the LiveKit Cloud project
lk agent create --region us-east --secrets "OPENAI_API_KEY=$OPENAI_API_KEY"   # first time; writes livekit.toml here
lk agent deploy                                  # each later version
lk agent status                                  # what is live; `lk agent logs` follows it
```

- Pass only `OPENAI_API_KEY` and, for her ElevenLabs voice, `ELEVEN_LABS_API_KEY` and `ELEVEN_LABS_VOICE_REMY_KEY`
  (the hosted worker has all three), plus `REMY_LINE_SECRET` for signed lines. Don't point `--secrets-file` at a full
  env file: every key in it would go to the agent.
- `REMY_LINE_SECRET` must match the assistant service's; without signed lines from it she refuses every line. From this
  folder, `lk agent update-secrets --secrets-file <(grep -E '^REMY_LINE_SECRET=' <your secrets file>)` adds it to the
  others (and restarts the agent) without printing it.
- Pick the region nearest the visitors. The agent's name, `remy`, comes from the code.
- Session recording (agent observability) is a project setting in LiveKit Cloud. With it on, visitors' calls are
  recorded.

## The call's tokens on the hosted site

The site's functions `api/call/token.ts` and `api/call/room.ts` (Vercel) mint the tokens, send Remy and keep each
session's minutes with her, for signed-in members of the project; `api/call/hook.ts` takes LiveKit's webhook (see
`apps/web/call-hosted.ts`). `vercel build` builds them with the site, so they deploy with
it (`pnpm deploy:site`), and they read these from the Vercel project's Production environment:

| Variable | Use |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | check the caller's access token, membership, tab and `app_flags.live_calls`; read the copy's visit (`copy_pool.claimed_at`, which names the call's room) and its tabs' sessions; count `use_quota('call_join')` and `use_quota('call_start')`; charge each time Remy is sent with `record_spend`, where the database has it; keep the session's minutes with Remy (`remy_minutes_now`, `remy_minutes_start`, `remy_minutes_ended`); read what a call needs before anyone presses (`call_readiness`) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the same LiveKit Cloud project as the worker; the key and secret also check the webhook's signature |
| `MAX_CALLS` | how many rooms may have Remy at once (default 5) |
