/**
 * Checks the Supabase adapter against the real tables (local stack): reads the plan, the workflow
 * and the thread, files one command and withdraws it again, then deletes that command row; then adds
 * a watch rule, opens a run for it (twice: the second is refused as already open), opens a thread,
 * ties the run to it and closes the run, and removes the rule and the thread again. Use it after a
 * migration changes the assistant's tables: pnpm --filter @collab/agent check-store
 */
import { createClient } from '@supabase/supabase-js';
import { ProposeFixArgs } from '@collab/shared';
import { SEED_IDS } from '@collab/shared/seed';
import { SupabaseStore } from '../data/supabase-store';
import { loadEnv, readConfig } from '../env';
import { createLogger } from '../log';
import { planFromRows } from '../plan/rows';
import { rentalChoices } from '../plan/whatif';

loadEnv();
const config = readConfig();
const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } });
const store = new SupabaseStore(supabase, createLogger('check'));
const [projectId] = await store.listProjects();
if (!projectId) throw new Error('no project');
const rows = await store.loadPlanRows(projectId);
const workflow = await store.loadWorkflow(projectId);
const plan = planFromRows(rows);
console.log(`plan: ${plan.projectName}, revision ${plan.revision}, ${plan.tasks.length} tasks, ${plan.members.map((m) => m.name).join(' + ')}, bookings ${plan.bookings.length}`);
console.log(`workflow: ${workflow.proposals.length} proposal(s), ${workflow.versions.length} version(s), ${workflow.approvals.length} approval(s), ${workflow.payments.length} payment(s), ${workflow.documents.length} document(s)`);
console.log(`thread: ${(await store.recentMessages(projectId, 5)).length} recent message(s)`);
const check = rentalChoices(plan);
const inputs = { new_start: check.now.first_day, new_end: plan.bookings[0]!.billableEnd };
const id = await store.insertCommand({ project_id: projectId, type: 'propose_fix', args: ProposeFixArgs.parse({ booking_id: check.booking_id, inputs: inputs, reason: 'adapter check' }), requested_by: SEED_IDS.pmUser, required_revision: plan.revision });
const row = await store.getCommand(id);
console.log(`command filed: status ${row?.status}, requested_by ${row?.requested_by === SEED_IDS.pmUser ? 'pm' : row?.requested_by}`);
console.log(`withdrawn: ${await store.cancelCommandIfPending(id)}, now ${(await store.getCommand(id))?.status}`);
const { error } = await supabase.from('agent_commands').delete().eq('id', id);
console.log(`check row removed: ${error ? error.message : 'yes'}`);

const added = await supabase
  .from('watch_rules')
  .insert({ project_id: projectId, name: 'adapter check', scope: { kind: 'plan' }, condition: { kind: 'idle_rental' }, action: { kind: 'ask_assistant' }, created_by: SEED_IDS.cmUser })
  .select('id')
  .single();
if (added.error) throw new Error(added.error.message);
const ruleId = (added.data as { id: string }).id;
const watch = await store.loadWatch(projectId);
console.log(`watch: ${watch.rules.length} rule(s) (check rule action ${watch.rules.find((r) => r.id === ruleId)?.action.kind}), ${watch.open.length} open run(s)`);
const newRun = { project_id: projectId, rule_id: ruleId, situation: `${ruleId}:15`, fingerprint: `${ruleId}:15:4`, severity: 'high' as const, title: 'Crane booked 4 days', detail: 'adapter check', task_ids: [15], revision: plan.revision };
const opened = await store.insertWatchRun(newRun);
const again = await store.insertWatchRun(newRun);
console.log(`run opened: ${opened ? `yes, tasks ${opened.task_ids.join(',')}` : 'no'}; opened again: ${again ? 'yes (wrong)' : 'no, already open'}`);
const thread = await store.createThread({ project_id: projectId, title: 'adapter check', created_by: SEED_IDS.cmUser, visibility: 'private' });
console.log(`thread: ${thread.visibility}, titled by ${thread.title_source}`);
await store.setWatchRunThread([opened!.id], thread.id);
await store.resolveWatchRuns([opened!.id]);
const after = await supabase.from('watch_runs').select('thread_id, resolved_at').eq('id', opened!.id).single();
console.log(`run tied to the thread: ${(after.data as { thread_id: string | null } | null)?.thread_id === thread.id}, closed: ${Boolean((after.data as { resolved_at: string | null } | null)?.resolved_at)}`);
await supabase.from('watch_rules').delete().eq('id', ruleId);
await supabase.from('agent_threads').delete().eq('id', thread.id);
console.log('watch check rows removed');
process.exit(0);
