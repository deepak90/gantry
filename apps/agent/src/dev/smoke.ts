/**
 * End-to-end smoke test against the running local stack and a running agent service, the way a
 * browser talks to it: signs in as Deepak (cm@demo.local, seed password), listens on the private
 * agent topic as that member, posts one question with `post_agent_message`, prints the streamed events
 * until `turn_end`, then reads the stored reply through RLS. It writes two thread rows (the question
 * and the reply); `pnpm demo:reset` clears the thread.
 *
 *   pnpm --filter @collab/agent dev        (in another terminal; AGENT_MODE=mock costs nothing)
 *   pnpm --filter @collab/agent smoke ["question"]
 */
import { createClient } from '@supabase/supabase-js';
import { AGENT_EVENTS, AgentStreamEvent, agentTopic } from '@collab/shared';
import { SEED_IDS, SEED_MEMBERS } from '@collab/shared/seed';
import { loadEnv } from '../env';

loadEnv();
const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const anon = process.env.VITE_SUPABASE_ANON_KEY;
if (!anon) throw new Error('VITE_SUPABASE_ANON_KEY is missing in .env.local');
const cm = SEED_MEMBERS.find((member) => member.email === 'cm@demo.local')!;
const question = process.argv[2] ?? 'Who has to approve a fix, and who pays the supplier?';

const client = createClient(url, anon, { auth: { persistSession: false } });
const { data: auth, error: signInError } = await client.auth.signInWithPassword({ email: cm.email, password: cm.password });
if (signInError || !auth.session) throw new Error(`sign-in failed: ${signInError?.message ?? 'no session'}`);
await client.realtime.setAuth(auth.session.access_token);

const started = Date.now();
const done = new Promise<{ messageId: string | null; error?: string }>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no turn_end within 60 s: is the agent service running?')), 60_000);
  const channel = client.channel(agentTopic(SEED_IDS.project), { config: { private: true } });
  channel.on('broadcast', { event: AGENT_EVENTS.stream }, ({ payload }) => {
    const parsed = AgentStreamEvent.safeParse(payload);
    const at = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    if (!parsed.success) {
      console.log(`${at} INVALID stream event`, payload);
      return;
    }
    const event = parsed.data;
    if (event.type === 'text_delta') process.stdout.write(`${at} text #${event.seq}: ${JSON.stringify(event.text)}\n`);
    else if (event.type === 'ui_partial') console.log(`${at} card draft ${event.component}`);
    else console.log(`${at} ${event.type}${'state' in event ? ` ${event.name} ${event.state}` : ''}${'kind' in event ? ` ${event.kind}` : ''}`);
    if (event.type === 'turn_end') {
      clearTimeout(timer);
      resolve({ messageId: event.message_id, ...(event.error ? { error: event.error } : {}) });
    }
  });
  channel.on('broadcast', { event: AGENT_EVENTS.message }, ({ payload }) => console.log(`${((Date.now() - started) / 1000).toFixed(1)}s message`, payload));
  channel.subscribe(async (status) => {
    if (status !== 'SUBSCRIBED') return;
    const { error } = await client.rpc('post_agent_message', { p_project: SEED_IDS.project, p_text: question, p_channel: 'text' });
    if (error) reject(new Error(`post_agent_message failed: ${error.message}`));
    else console.log(`posted as ${cm.display_name}: ${question}`);
  });
});

const { messageId, error } = await done;
if (error) console.log(`turn_end error: ${error}`);
if (messageId) {
  const { data, error: readError } = await client.from('agent_messages').select('role, channel, text, cards').eq('id', messageId).single();
  if (readError) throw new Error(readError.message);
  console.log('stored reply:', JSON.stringify({ ...data, cards: (data.cards as { component: string }[]).map((card) => card.component) }));
}
await client.removeAllChannels();
process.exit(0);
