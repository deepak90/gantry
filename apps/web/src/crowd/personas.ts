/**
 * Who each simulated person is: what part of a construction plan they look after (matched by words in
 * task and phase names, so any project works), what they care about, which kinds of edits they make,
 * and the canned intents and notes they fall back on when no language model wrote better ones.
 * Templates fill in `{task}` (the task's name), `{crew}` (the crew on it), `{day}` and `{day2}`.
 */
import { CROWD_PEOPLE, type CrowdPerson } from '@collab/shared';

export const ACTION_KINDS = ['rename', 'note', 'progress', 'move', 'resize', 'crew'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface CannedIntent {
  /** Present tense, what they are doing right now: "chasing the riser inspections". */
  text: string;
  /** Edits that fit it. */
  kinds: readonly ActionKind[];
  /** Words that pick the tasks it is about (any task of their area when none match). */
  keywords: readonly string[];
}

export interface Persona {
  person: CrowdPerson;
  firstName: string;
  /** What they look after and why, in a sentence (also given to the language model). */
  cares: string;
  /** Words in task and phase names that make a task theirs. */
  keywords: readonly string[];
  weights: Readonly<Record<ActionKind, number>>;
  intents: readonly CannedIntent[];
  notes: readonly string[];
  /** Short clarifiers they add to a task name (kept meaning), each for names with one of its words (any name when none). */
  qualifiers: readonly (readonly [string, readonly string[]])[];
  /** Brings date changes back first (the scheduler). */
  tidiesDates?: boolean;
}

const byId = (index: number): CrowdPerson => CROWD_PEOPLE[index]!;

const persona = (index: number, rest: Omit<Persona, 'person' | 'firstName'>): Persona => {
  const person = byId(index);
  return { person, firstName: person.name.split(' ')[0] ?? person.name, ...rest };
};

export const PERSONAS: readonly Persona[] = [
  persona(0, {
    cares: 'Field engineer: layout, sitework and hold-point inspections; wants every inspection booked before the pour.',
    keywords: ['layout', 'survey', 'excavat', 'footing', 'foundation', 'sitework', 'drainage', 'test pit', 'inspect', 'hold point', 'slab', 'subbase', 'levels', 'scaffold', 'fence', 'site'],
    weights: { progress: 3, note: 3, rename: 1, move: 1, resize: 1, crew: 1 },
    intents: [
      { text: 'walking the site and updating progress', kinds: ['progress', 'note'], keywords: [] },
      { text: 'booking the hold-point inspections', kinds: ['note', 'move'], keywords: ['inspect', 'hold point'] },
      { text: 'checking levels on the sitework', kinds: ['note', 'progress'], keywords: ['excavat', 'footing', 'slab', 'subbase'] },
      { text: 'getting the layout signed off', kinds: ['note', 'rename'], keywords: ['layout', 'survey'] },
    ],
    notes: [
      'Hold point booked with the building inspector for {day}.',
      'Levels checked against the drawings: within tolerance.',
      'Layout pins in; second check by {day}.',
      'Ground as expected, no change to the method.',
      'Photos of the subgrade taken before cover-up.',
      '{crew} to keep the area clear for the inspection.',
    ],
    qualifiers: [
      ['(hold point)', ['inspect', 'hold point']],
      ['– check levels', ['slab', 'footing', 'excavat', 'floor topping', 'lay out', 'layout']],
      ['(as surveyed)', ['lay out', 'layout', 'survey']],
    ],
  }),
  persona(1, {
    cares: 'Scheduler: keeps the schedule honest, watches float and sequencing, and tidies up date changes so the handover never slips.',
    keywords: ['fabricat', 'deliver', 'procure', 'order', 'design', 'approval', 'shop drawing', 'lead time', 'commission', 'testing', 'balancing', 'training', 'certif'],
    weights: { move: 3, resize: 3, note: 2, progress: 1, rename: 1, crew: 0 },
    intents: [
      { text: 'checking float on the look-ahead', kinds: ['move', 'resize', 'note'], keywords: [] },
      { text: 'resequencing deliveries around site access', kinds: ['move', 'note'], keywords: ['deliver', 'fabricat', 'order'] },
      { text: 'tightening the commissioning window', kinds: ['resize', 'note'], keywords: ['commission', 'testing', 'balancing', 'certif'] },
      { text: 'updating the two-week look-ahead', kinds: ['note', 'progress'], keywords: [] },
    ],
    notes: [
      'Float checked: no effect on the handover.',
      'Sequence confirmed with {crew}; no change to successors.',
      'Look-ahead updated for the next two weeks.',
      'Delivery slot moved to suit site access on {day}.',
      'Keep this off the critical path: start no later than {day2}.',
    ],
    qualifiers: [],
    tidiesDates: true,
  }),
  persona(2, {
    cares: 'MEP coordinator: rough-in and trim-out of electrical, HVAC, plumbing and data; chases inspections and clashes above the ceiling.',
    keywords: ['electric', 'ventilat', 'duct', 'air', 'plumb', 'water', 'drainage', 'heating', 'gas', 'fire alarm', 'data', 'cabling', 'conduit', 'lighting', 'outlet', 'sprinkler', 'riser', 'mep', 'nurse call', 'network', 'wi-fi', 'telecom', 'radiator', 'fixture', 'diffuser'],
    weights: { note: 3, progress: 2, crew: 2, rename: 1, move: 1, resize: 1 },
    intents: [
      { text: 'chasing the riser inspections', kinds: ['note', 'progress'], keywords: ['inspect', 'riser', 'mep'] },
      { text: 'coordinating rough-in above the ceiling', kinds: ['note', 'crew', 'progress'], keywords: ['rough-in', 'conduit', 'duct', 'cabling'] },
      { text: 'lining up trim-out crews', kinds: ['crew', 'note', 'move'], keywords: ['trim-out', 'lighting', 'outlet', 'diffuser', 'fixture'] },
      { text: 'getting test certificates in', kinds: ['note', 'progress'], keywords: ['test', 'certif', 'commission'] },
    ],
    notes: [
      'Riser inspection booked for {day}.',
      'Clash with the ductwork resolved on site; markup sent.',
      'Waiting on {crew} to confirm labor for {day}.',
      'Conduit routes agreed with {crew}.',
      'Test sheets due from {crew} by {day2}.',
      'Materials on site; rough-in can start {day}.',
    ],
    qualifiers: [
      ['(MEP)', ['electric', 'plumb', 'duct', 'ventilat', 'data', 'fire alarm', 'heating', 'lighting', 'cabling', 'mep']],
      ['– services coordinated', ['electric', 'plumb', 'duct', 'ventilat', 'data', 'fire alarm', 'heating', 'lighting', 'cabling', 'mep']],
    ],
  }),
  persona(3, {
    cares: 'Cost engineer: progress for the monthly pay application, change orders and what is on site; keeps percentages honest.',
    keywords: ['cladding', 'roof', 'window', 'door', 'floor', 'millwork', 'furniture', 'equipment', 'signage', 'build-out', 'kitchen', 'balcon', 'facade', 'floor topping'],
    weights: { progress: 4, note: 2, rename: 1, move: 0, resize: 0, crew: 0 },
    intents: [
      { text: 'updating progress for the monthly pay application', kinds: ['progress', 'note'], keywords: [] },
      { text: 'logging materials on site', kinds: ['note', 'progress'], keywords: ['deliver', 'floor', 'door', 'window'] },
      { text: 'checking a change order on the build-out', kinds: ['note', 'rename'], keywords: ['millwork', 'build-out', 'furniture'] },
    ],
    notes: [
      'Progress agreed with {crew} for this month’s pay application.',
      'Change order raised for extra work asked for on site; awaiting direction.',
      'Materials on site counted for the pay application.',
      'Measured on site: matches the quantities.',
      'Nothing to bill this month; work not started.',
    ],
    qualifiers: [],
  }),
  persona(4, {
    cares: 'Foreman: runs the crews day to day (partitions, ceilings, painting and touch-up); reports who is on site and how far they got.',
    keywords: ['partition', 'drywall', 'ceiling', 'paint', 'tile', 'tiling', 'clean', 'punch', 'touch-up', 'demolition', 'trailer', 'masonry', 'block', 'plaster', 'baseboard'],
    weights: { progress: 3, crew: 2, note: 2, move: 1, resize: 1, rename: 0 },
    intents: [
      { text: 'logging progress from the morning walk', kinds: ['progress', 'note'], keywords: [] },
      { text: 'moving crews between floors', kinds: ['crew', 'note', 'move'], keywords: [] },
      { text: 'getting areas ready for the next trade', kinds: ['note', 'progress'], keywords: ['clean', 'touch-up', 'drywall', 'ceiling'] },
    ],
    notes: [
      '{crew} on site with a full crew today.',
      'Short a laborer {day}; catching up {day2}.',
      'Area handed over clean to the next trade.',
      'Second crew starts {day} to keep this on track.',
      'Scaffold tower booked for {day}.',
    ],
    qualifiers: [],
  }),
  persona(5, {
    cares: "Architect's site rep: finishes, specification and the wording of the work packages; raises RFIs and approves samples.",
    keywords: ['window', 'door', 'door hardware', 'millwork', 'desk', 'signage', 'protection', 'floor', 'tiling', 'paint', 'cladding', 'membrane', 'finish', 'lead lining', 'ceiling', 'kitchen', 'restroom', 'facade'],
    weights: { rename: 3, note: 3, progress: 1, move: 0, resize: 0, crew: 0 },
    intents: [
      { text: 'aligning task names with the spec', kinds: ['rename', 'note'], keywords: [] },
      { text: 'chasing RFIs on the finishes', kinds: ['note'], keywords: ['floor', 'tiling', 'door', 'window', 'finish'] },
      { text: 'approving samples on site', kinds: ['note', 'progress'], keywords: ['door hardware', 'millwork', 'signage', 'cladding'] },
    ],
    notes: [
      'RFI issued on the junction detail; awaiting a reply.',
      'Sample approved on site.',
      'Spec clarified: approved product only, no substitutes.',
      'Color reference confirmed with the client.',
      'Mock-up to be inspected before the rest goes in.',
    ],
    qualifiers: [
      ['(per spec)', []],
      ['– as specified', []],
      ['(approved finish)', ['paint', 'floor', 'tiling', 'ceiling', 'finish', 'millwork', 'door']],
    ],
  }),
  persona(6, {
    cares: 'Structural engineer: steel frame, concrete and fireproofing; signs off pours, bolt checks and temporary works.',
    keywords: ['steel', 'frame', 'bolt', 'grout', 'base plate', 'rebar', 'pour', 'cure', 'concrete', 'footing', 'slab', 'deck', 'intumescent', 'fireproofing', 'column', 'beam', 'shop drawing', 'core'],
    weights: { note: 3, progress: 2, move: 1, resize: 1, rename: 1, crew: 0 },
    intents: [
      { text: 'signing off the steel bolt checks', kinds: ['note', 'progress'], keywords: ['steel', 'bolt', 'frame', 'grout'] },
      { text: 'reviewing pour sequences', kinds: ['note', 'move', 'resize'], keywords: ['pour', 'cure', 'concrete', 'slab', 'rebar'] },
      { text: 'checking temporary works', kinds: ['note'], keywords: [] },
    ],
    notes: [
      'Bolt torque checks signed off on the first bays.',
      'Pour approved after the rebar inspection.',
      'Temporary works checked; no change.',
      'Cylinder test results due {day}.',
      'Fireproofing thickness checked on a sample.',
    ],
    qualifiers: [
      ['(structural)', ['steel', 'frame', 'slab', 'footing', 'pour', 'beam', 'column', 'deck', 'rebar']],
      ['– engineer to inspect', ['steel', 'pour', 'rebar', 'slab', 'footing', 'bolt']],
    ],
  }),
];

export function personaFor(personId: string): Persona | undefined {
  return PERSONAS.find((entry) => entry.person.id === personId);
}
