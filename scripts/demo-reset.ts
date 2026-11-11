/**
 * Restores every demo project (or the one after `--project <uuid>`) to its seed state (reset_demo in supabase/migrations): no revisions,
 * sessions, proposals, approvals, payments or documents other than the seed's; the seed snapshot
 * and crane booking back in place. SQL cannot delete stored files, so reset_demo lists the files of
 * the project's folder that no remaining document references and this script removes them through
 * the Storage API. Open browsers must reload afterwards. Uses the service role key from the
 * repo-root .env.local.
 *
 *   pnpm demo:reset [--project <uuid>] [--force]
 *
 * Then it runs scripts/seed-documents.ts, which files the seed documents if missing. A payment
 * PayPal is still processing blocks the reset (the payment lock); `--force` (`pnpm demo:reset:force`)
 * abandons it first.
 *
 * The seed pays placeholder addresses (`sb-northgate@personal.example.com`) that no PayPal account
 * has: PayPal takes the money and holds it as unclaimed. With PAYPAL_SANDBOX_PAYEE_EMAIL set, every
 * reset project pays sandbox accounts instead, as `pnpm db:reset` does (scripts/gen-seed-local.ts): each
 * rental supplier its own, PAYPAL_SANDBOX_<first word of its name>_EMAIL, when there is one, else that payee.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SEED_PROJECTS } from '../packages/shared/src/seed/index.ts';
import { sandboxAccounts } from '../supabase/functions/_shared/accounts.ts';

const url = process.env.SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local (values from `supabase status -o env`).');
  process.exit(1);
}

const force = process.argv.includes('--force');
const only = process.argv.includes('--project') ? process.argv[process.argv.indexOf('--project') + 1] : undefined;
const targets = SEED_PROJECTS.filter(({ ids }) => !only || ids.project === only);
if (targets.length === 0) {
  console.error(`No demo project ${only}; known: ${SEED_PROJECTS.map(({ ids, project }) => `${ids.project} (${project.name})`).join(', ')}`);
  process.exit(1);
}
const base = url.replace(/\/$/, '');
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
/** The sandbox account that receives the demo's payments on this machine (the seed's addresses have none). */
const payee = process.env.PAYPAL_SANDBOX_PAYEE_EMAIL?.trim() ?? '';
/** The tenant's own sandbox account, if it has one: the invoices of Harbor and of its copies bill it. */
const tenant = process.env.PAYPAL_SANDBOX_TENANT_EMAIL?.trim() || payee;
for (const [name, address] of Object.entries({ PAYPAL_SANDBOX_PAYEE_EMAIL: payee, PAYPAL_SANDBOX_TENANT_EMAIL: tenant })) {
  if (address && !/^[^\s'@]+@[^\s']+\.[^\s']+$/.test(address)) {
    console.error(`${name} is not an email address.`);
    process.exit(1);
  }
}
/** Each firm's own sandbox account, PAYPAL_SANDBOX_<first word of its name>_EMAIL. */
const accounts = sandboxAccounts(process.env);

/**
 * Points a reset project's payments at sandbox accounts, as `pnpm db:reset` does: each rental supplier its own when it
 * has one, else the sandbox payee; Harbor and its copies bill the tenant.
 */
async function payTheSandboxPayee(projectId: string, name: string, billsTheTenant: boolean): Promise<void> {
  const listed = await fetch(`${base}/rest/v1/equipment_bookings?project_id=eq.${projectId}&select=id,supplier_name`, { headers });
  if (!listed.ok) {
    console.error(`Reading ${name}'s rentals failed (HTTP ${listed.status}): ${await listed.text()}`);
    process.exit(1);
  }
  const bookings = (await listed.json()) as { id: string; supplier_name: string }[];
  const patches = [
    ...bookings.map((booking) => ({ path: `/rest/v1/equipment_bookings?id=eq.${booking.id}`, body: { supplier_payout_email: accounts.of(booking.supplier_name) ?? payee } })),
    ...(billsTheTenant ? [{ path: `/rest/v1/projects?id=eq.${projectId}`, body: { client_email: tenant } }] : []),
  ];
  for (const { path, body } of patches) {
    const response = await fetch(`${base}${path}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!response.ok) {
      console.error(`Pointing ${name}'s payments at the sandbox payee failed (HTTP ${response.status}): ${await response.text()}`);
      process.exit(1);
    }
  }
}

for (const { project, ids } of targets) {
  const response = await fetch(`${base}/rest/v1/rpc/${force ? 'reset_demo_abandoning_payments' : 'reset_demo'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ p_project: ids.project }),
  }).catch((error: unknown) => {
    console.error(`Cannot reach Supabase at ${url}: ${error instanceof Error ? error.message : String(error)} (is \`pnpm db:start\` running?)`);
    process.exit(1);
  });

  if (!response.ok) {
    console.error(`reset_demo failed for ${project.name} (HTTP ${response.status}): ${await response.text()}`);
    process.exit(1);
  }
  if (payee) await payTheSandboxPayee(ids.project, project.name, project.template === 'harbor');
  else console.warn(`PAYPAL_SANDBOX_PAYEE_EMAIL is not set: ${project.name} pays the seed's placeholder addresses, which PayPal holds as unclaimed.`);

  const result = (await response.json()) as { document_objects?: unknown };
  const paths = Array.isArray(result.document_objects)
    ? result.document_objects.filter((path): path is string => typeof path === 'string')
    : [];
  for (let start = 0; start < paths.length; start += 500) {
    const removal = await fetch(`${base}/storage/v1/object/documents`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ prefixes: paths.slice(start, start + 500) }),
    });
    if (!removal.ok) {
      // The rows are already gone; a stray file is harmless and the next reset lists it again.
      console.warn(`Removing ${paths.length} document files failed (HTTP ${removal.status}): ${await removal.text()}`);
      break;
    }
  }
  console.log(`${project.name} reset to its seed state${paths.length > 0 ? `; removed ${paths.length} document file(s)` : ''}.`);
}
execFileSync(process.execPath, [fileURLToPath(new URL('./seed-documents.ts', import.meta.url))], { stdio: 'inherit' });
console.log('Reload any open browsers.');
