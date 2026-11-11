/**
 * Who reads a thread decides whether amounts may be shown: the audience line, the streaming mask that
 * never lets digits of an amount through (even split over two pieces), and cards without money.
 */
import { describe, expect, it } from 'vitest';
import { carriesMoney, describeAudience, moneyAllowed, redactAmounts, streamRedactor, withoutMoney } from '../src/agent/audience';
import { cleanTitle } from '../src/agent/titles';
import type { PlanMember } from '../src/plan/snapshot';

// One role for everyone; what counts is seeing costs. Sam is like the crowd's simulated teammates: a member who cannot see costs.
const chris: PlanMember = { userId: 'c', name: 'Chris', role: 'cm', roleLabel: 'Member', canViewCosts: true, approvalLimitMinor: 25_000_000 };
const priya: PlanMember = { userId: 'p', name: 'Priya', role: 'cm', roleLabel: 'Member', canViewCosts: true, approvalLimitMinor: 25_000_000 };
const sam: PlanMember = { userId: 's', name: 'Sam', role: 'pm', roleLabel: 'Member', canViewCosts: false, approvalLimitMinor: 0 };

describe('the audience', () => {
  it('allows amounts when everyone reading may see costs, or when someone who does shared them', () => {
    expect(moneyAllowed({ visibility: 'private', people: [chris] })).toBe(true);
    expect(moneyAllowed({ visibility: 'project', people: [chris, priya] })).toBe(true);
    expect(moneyAllowed({ visibility: 'private', people: [chris, sam] })).toBe(false);
    expect(moneyAllowed(null)).toBe(true);
    // Chris chose to share the costs here: amounts for everyone in it, and the model is told who shared them.
    expect(moneyAllowed({ visibility: 'private', people: [chris, sam], costsSharedBy: chris })).toBe(true);
    expect(describeAudience({ visibility: 'private', people: [chris, sam], costsSharedBy: chris })).toBe(
      '\n<audience thread="private" money="shared" shared_by="Chris">Chris (sees costs); Sam (no cost access)</audience>',
    );
    expect(describeAudience({ visibility: 'project', people: [chris, priya] })).toBe(
      '\n<audience thread="shared with the project" money="allowed">Chris (sees costs); Priya (sees costs)</audience>',
    );
  });

  it('still withholds amounts from a project with a member who cannot see costs, whatever the roles', () => {
    // Everyone has one role now; a member without cost access (a site teammate) still keeps the General thread free of amounts.
    expect(moneyAllowed({ visibility: 'project', people: [priya, chris, sam] })).toBe(false);
    expect(describeAudience({ visibility: 'project', people: [priya, chris, sam] })).toBe(
      '\n<audience thread="shared with the project" money="withheld">Priya (sees costs); Chris (sees costs); Sam (no cost access)</audience>',
    );
  });

  it('masks amounts in words', () => {
    expect(redactAmounts('Idle days cost $2,400; the fix is $1,200.50 (USD 900, or 300 dollars).')).toBe(
      'Idle days cost [amount withheld]; the fix is [amount withheld] ([amount withheld], or [amount withheld]).',
    );
    expect(redactAmounts('4 days from Dec 7 to Dec 11')).toBe('4 days from Dec 7 to Dec 11');
  });

  it('never streams the digits of an amount, even split across pieces', () => {
    const mask = streamRedactor();
    const shown = ['The crane costs $', '2,', '400 for ', '4 idle days', ' on Dec 7.'].map((piece) => mask.push(piece)).join('') + mask.end();
    expect(shown).toBe('The crane costs [amount withheld] for 4 idle days on Dec 7.');
  });

  it('takes the money out of a card: null where it may be, gone where it may be left out, masked in text', () => {
    const card = { headline: 'Crane idle 4 days', money: { label: 'Idle days', amount: '2400.00' }, facts: [{ label: 'Cost', value: '$2,400' }], issue_id: 'x' };
    expect(carriesMoney(card)).toBe(true);
    expect(withoutMoney(card, 'null')).toEqual({ headline: 'Crane idle 4 days', money: null, facts: [{ label: 'Cost', value: '[amount withheld]' }], issue_id: 'x' });
    expect(withoutMoney(card, 'drop')).toEqual({ headline: 'Crane idle 4 days', facts: [{ label: 'Cost', value: '[amount withheld]' }], issue_id: 'x' });
    expect(carriesMoney(withoutMoney(card, 'null'))).toBe(false);
  });
});

describe('thread titles', () => {
  it('keeps a short subject line and nothing else', () => {
    expect(cleanTitle('"Crane rental before steel erection."')).toBe('Crane rental before steel erection');
    expect(cleanTitle('Title: idle crane days\nmore text')).toBe('Idle crane days');
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('This is far too long to be the short title of a conversation thread')).toBeNull();
  });
});
