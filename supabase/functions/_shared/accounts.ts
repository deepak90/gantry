/**
 * Who a sandbox payment goes to. Every party the demo pays or bills has a PayPal sandbox account of its own, named in
 * the environment by the first word of its name: PAYPAL_SANDBOX_GRANITE_EMAIL for Granite Ridge Concrete,
 * PAYPAL_SANDBOX_NORTHGATE_EMAIL for Northgate Equipment Rental, PAYPAL_SANDBOX_TENANT_EMAIL for the tenant. The
 * screen says who was paid, so a payment never goes to an account that is set up for anyone else.
 *
 * PAYPAL_SANDBOX_PAYEE_EMAIL is this machine's catch-all payee for the seed (scripts/gen-seed-local.ts), not a party.
 */

const ACCOUNT_NAME = /^PAYPAL_SANDBOX_([A-Z0-9]+)_EMAIL$/;
const CATCH_ALL = 'PAYEE';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A party's word: the first word of its name in capitals, letters and digits only ("Granite Ridge Concrete" is GRANITE). */
export function partyWord(name: string): string {
  return (name.trim().split(/\s+/)[0] ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export interface SandboxAccounts {
  /** The party's own account, or null when it has none set up. */
  of(name: string): string | null;
  /** The word of another party whose account this address is too; null when it is nobody else's. */
  alsoOf(name: string, address: string): string | null;
}

/** The accounts set up in an environment (the function's own, or the dev server's .env.local). */
export function sandboxAccounts(env: Readonly<Record<string, string | undefined>>): SandboxAccounts {
  const byWord = new Map<string, string>();
  for (const [key, raw] of Object.entries(env)) {
    const word = ACCOUNT_NAME.exec(key)?.[1];
    const address = raw?.trim() ?? '';
    if (word && word !== CATCH_ALL && EMAIL.test(address)) byWord.set(word, address);
  }
  return {
    of(name) {
      const word = partyWord(name);
      return (word && byWord.get(word)) || null;
    },
    alsoOf(name, address) {
      const own = partyWord(name);
      const wanted = address.trim().toLowerCase();
      for (const [word, other] of byWord) if (word !== own && other.toLowerCase() === wanted) return word;
      return null;
    },
  };
}

/**
 * Each firm's own account, or why the payment can't go: a firm with none, two firms of the payment sharing one, or a
 * firm whose account is set up for another party as well.
 */
export function firmAccounts(firms: readonly string[], accounts: SandboxAccounts): { ok: true; accounts: Map<string, string> } | { ok: false; error: string } {
  const found: [string, string][] = [];
  for (const firm of firms) {
    const email = accounts.of(firm);
    if (!email) return { ok: false, error: `${firm} has no PayPal account set up, so it can't be paid.` };
    found.push([firm, email]);
  }
  for (const [index, [firm, email]] of found.entries()) {
    const shared = found.slice(0, index).find(([, other]) => other.toLowerCase() === email.toLowerCase());
    if (shared) return { ok: false, error: `${firm} and ${shared[0]} point at the same PayPal account, so the payment can't be sent.` };
  }
  for (const [firm, email] of found) {
    if (accounts.alsoOf(firm, email)) return { ok: false, error: `${firm}'s PayPal account is set up for another party too, so the payment can't be sent.` };
  }
  return { ok: true, accounts: new Map(found) };
}

/**
 * Why a rental's payout can't go to the address it was approved for: the address is another party's account (a crew,
 * the tenant). Null when it may go. The payout's address is fixed when the rental is approved (the booking's), so the
 * check is made on that address rather than by looking the firm up.
 */
export function rentalPayeeRefusal(accounts: SandboxAccounts, supplier: string, address: string): string | null {
  return accounts.alsoOf(supplier, address) ? `${supplier} is set up to be paid into another party's PayPal account, so the payout can't be sent.` : null;
}
