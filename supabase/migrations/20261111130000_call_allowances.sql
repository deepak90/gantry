-- A visit's allowance of Remy's turns, and the daily spending caps, fitted to what a call actually uses.
--
-- Turns: 40 a visit, not 15. On a call each greeting is a turn, and so is each thing said to her, half sentences
-- included: one visit spent its 15 in eight minutes, and from then on Remy could only say she had reached the limit.
-- The whole site's 250 a day stays.
update public.quota_limits set per_copy = 40 where kind = 'ai_turn';

-- Spend: each time Remy is sent, the call route books $0.25 of OpenAI, $0.10 of ElevenLabs and $0.10 of LiveKit
-- (DISPATCH_SPEND in apps/web/call-hosted.ts), and the site allows 15 calls a day (quota_limits call_start). With caps
-- of $2, $1 and $1 the breaker switched calls off after the eighth. These cover the fifteen: $4, $1.50 and $1.50, and
-- $12 for the day in all. Anthropic's $5 stays.
update public.spend_limits set daily_usd_micro = 4000000 where vendor = 'openai';
update public.spend_limits set daily_usd_micro = 1500000 where vendor in ('elevenlabs', 'livekit');
update public.spend_limits set daily_usd_micro = 12000000 where vendor = 'total';
