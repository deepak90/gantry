/**
 * The enums in src/schemas.ts and src/documents.ts are the vocabularies of Postgres check
 * constraints. Both sides are hand-written, so this test reads every `check (<column> in (...))`
 * list out of the migrations and asserts it equals the zod options; a change on one side without
 * the other fails here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ActorKind,
  ApprovalScope,
  ApprovalStatus,
  CommandStatus,
  DecisionNoteKind,
  MemberRoleSchema,
  PaymentStatus,
  ProposalState,
  PublicationStatus,
  ReviewKind,
  SupplierConfirmationStatus,
} from '../src/schemas';
import { DocumentCreatedVia, DocumentKind } from '../src/documents';
import { AGENT_COMMAND_OPEN_AFTER_MS, AgentChannel, AgentEditDecision, AgentMessageRole } from '../src/agent';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

/** table, column, and the zod enum that must list exactly the column's accepted values. */
const VOCABULARIES: ReadonlyArray<readonly [table: string, column: string, schema: z.ZodEnum<Record<string, string>>]> = [
  ['project_members', 'role', MemberRoleSchema],
  ['proposals', 'state', ProposalState],
  ['proposal_versions', 'created_via', ActorKind],
  ['reviews', 'kind', ReviewKind],
  ['approvals', 'scope', ApprovalScope],
  ['approvals', 'status', ApprovalStatus],
  ['payment_authorizations', 'status', PaymentStatus],
  ['decision_notes', 'kind', DecisionNoteKind],
  ['agent_commands', 'status', CommandStatus],
  ['supplier_confirmations', 'status', SupplierConfirmationStatus],
  ['publications', 'status', PublicationStatus],
  ['project_documents', 'kind', DocumentKind],
  ['project_documents', 'created_via', DocumentCreatedVia],
  ['agent_messages', 'role', AgentMessageRole],
  ['agent_messages', 'channel', AgentChannel],
  ['agent_edit_decisions', 'decision', AgentEditDecision],
];

function readMigrations(): string {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files.map((file) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')).join('\n');
}

/** `create table public.<name> (...)` bodies, by table name, with `--` comments removed. */
function tableBodies(sql: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const withoutComments = sql.replace(/--[^\n]*/g, '');
  const header = /create table (?:if not exists )?public\.(\w+)\s*\(/g;
  for (let match = header.exec(withoutComments); match !== null; match = header.exec(withoutComments)) {
    let depth = 1;
    let index = header.lastIndex;
    while (index < withoutComments.length && depth > 0) {
      const char = withoutComments[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    bodies.set(match[1]!, withoutComments.slice(header.lastIndex, index - 1));
  }
  return bodies;
}

/** The quoted values of `<column> text ... check (<column> in ('a', 'b'))`, which may span lines. */
function checkedValues(body: string, column: string): string[] | undefined {
  const pattern = new RegExp(`\\b${column}\\s+text\\b[^,]*?\\bcheck\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)\\s*\\)`, 's');
  const match = pattern.exec(body);
  if (!match) return undefined;
  return [...match[1]!.matchAll(/'([^']*)'/g)].map((value) => value[1]!);
}

describe('Postgres check constraints and the shared zod enums', () => {
  const bodies = tableBodies(readMigrations());

  it.each(VOCABULARIES)('%s.%s lists exactly the zod options', (table, column, schema) => {
    const body = bodies.get(table);
    expect(body, `create table public.${table} not found in the migrations`).toBeDefined();
    const values = checkedValues(body!, column);
    expect(values, `no check (${column} in (...)) constraint on public.${table}`).toBeDefined();
    expect(values).toEqual(schema.options);
  });

  it('claim_agent_command opens a command to every member after AGENT_COMMAND_OPEN_AFTER_MS', () => {
    const sql = readMigrations();
    const claim = /create or replace function public\.claim_agent_command[\s\S]*?\$\$;/.exec(sql)?.[0];
    expect(claim, 'claim_agent_command not found in the migrations').toBeDefined();
    const intervals = [...claim!.matchAll(/interval '(\d+) seconds'/g)].map((match) => Number(match[1]) * 1000);
    expect(intervals.length).toBeGreaterThan(0);
    expect(new Set(intervals)).toEqual(new Set([AGENT_COMMAND_OPEN_AFTER_MS]));
  });

  it('the parser sees constraints that continue on the next line', () => {
    const body = `
      id uuid primary key,
      status text not null default 'pending'
                  check (status in ('pending', 'running')),
      kind text not null check (kind in ('a', 'b')),
      note text`;
    expect(checkedValues(body, 'status')).toEqual(['pending', 'running']);
    expect(checkedValues(body, 'kind')).toEqual(['a', 'b']);
    expect(checkedValues(body, 'note')).toBeUndefined();
  });
});
