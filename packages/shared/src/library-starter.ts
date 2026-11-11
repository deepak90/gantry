/**
 * The library every project starts with: well-established pieces of work for a clinic build-out,
 * filed in folders. `supabase/seed.sql` and the demo reset write it into `library_folders` and
 * `library_snippets` (scripts/gen-seed-library.ts); after that it is the team's own to change.
 *
 * Every snippet starts with exactly one task and ends with exactly one task, so that dropped after a
 * task it follows that task, and later work can wait for it as a whole. `test/library.test.ts` checks
 * that, and that each one schedules without loops.
 */
import type { SnippetDraft } from './library';

export interface StarterSnippet extends SnippetDraft {
  /** Stable name for the seed (the database gives the row its own id). */
  starterKey: string;
}

export interface StarterFolder {
  name: string;
  /** Starter keys of the snippets filed here, in order. */
  snippets: string[];
  folders?: StarterFolder[];
}

const SNIPPETS: StarterSnippet[] = [
  {
    starterKey: 'consulting-room',
    name: 'Exam room build-out',
    summary: 'Walls, services, finishes and punch list for one exam room.',
    icon: 'door-open',
    unit: { one: 'room', many: 'rooms' },
    children: [
      {
        key: 'walls',
        name: 'Walls & rough-in',
        children: [
          { key: 'setout', name: 'Lay out walls & door locations', duration: 1, crews: [{ name: 'General contractor' }] },
          { key: 'studs', name: 'Metal stud walls & door frames', duration: 2, crews: [{ name: 'Carpentry' }] },
          {
            key: 'elec1',
            name: 'Electrical rough-in: cables & boxes',
            duration: 2,
            crews: [{ name: 'Electrical' }],
            note: 'Starts once the first wall is up.',
          },
          { key: 'plumb1', name: 'Plumbing rough-in: sink supply & drain', duration: 1, crews: [{ name: 'Plumbing' }] },
        ],
      },
      {
        key: 'close',
        name: 'Close up',
        children: [
          {
            key: 'board',
            name: 'Hang, tape & finish drywall',
            duration: 2,
            crews: [{ name: 'Carpentry' }],
            note: 'Hold point: services checked inside the walls before the drywall goes on.',
          },
          { key: 'ceiling', name: 'Suspended ceiling', duration: 1, crews: [{ name: 'Carpentry' }] },
        ],
      },
      {
        key: 'finish',
        name: 'Trim-out & finishes',
        children: [
          { key: 'elec2', name: 'Electrical trim-out: lights, outlets & switches', duration: 1, crews: [{ name: 'Electrical' }] },
          { key: 'basin', name: 'Clinical hand-wash sink & faucets', duration: 1, crews: [{ name: 'Plumbing' }] },
          { key: 'decorate', name: 'Paint walls & ceiling', duration: 2, crews: [{ name: 'Painting' }] },
          { key: 'floor', name: 'Safety vinyl floor & cove base', duration: 1, crews: [{ name: 'Carpentry' }] },
        ],
      },
      { key: 'snag', name: 'Punch list & clean the room', duration: 1, crews: [{ name: 'General contractor' }] },
    ],
    links: [
      { from: 'setout', to: 'studs' },
      { from: 'studs', to: 'elec1', type: 'SS', lag: 1 },
      { from: 'studs', to: 'plumb1', type: 'SS', lag: 1 },
      { from: 'studs', to: 'board' },
      { from: 'elec1', to: 'board' },
      { from: 'plumb1', to: 'board' },
      { from: 'board', to: 'ceiling' },
      { from: 'ceiling', to: 'elec2' },
      { from: 'ceiling', to: 'basin' },
      { from: 'elec2', to: 'decorate' },
      { from: 'basin', to: 'decorate' },
      { from: 'decorate', to: 'floor' },
      { from: 'floor', to: 'snag' },
    ],
  },
  {
    starterKey: 'xray-room',
    name: 'X-ray room lead lining',
    summary: 'Shielding design, lead-lined walls and door, checks and the sign-off before the X-ray unit goes in.',
    icon: 'radiation',
    unit: { one: 'room', many: 'rooms' },
    children: [
      {
        key: 'prepare',
        name: 'Design & order',
        children: [
          {
            key: 'design',
            name: 'Confirm shielding design with the medical physicist',
            duration: 1,
            crews: [{ name: 'Medical equipment' }],
            note: 'Lead thickness per wall comes from the medical physicist’s report.',
          },
          { key: 'order', name: 'Order lead-lined drywall & shielded door', duration: 5, note: 'Lead time from the supplier; no crew on site.' },
        ],
      },
      {
        key: 'line',
        name: 'Lead lining',
        children: [
          { key: 'boards', name: 'Hang lead-lined drywall on walls', duration: 3, crews: [{ name: 'Carpentry' }] },
          { key: 'door', name: 'Hang shielded door & viewing window', duration: 1, crews: [{ name: 'Carpentry' }] },
          { key: 'seal', name: 'Lead-seal joints & penetrations', duration: 1, crews: [{ name: 'Carpentry' }] },
        ],
      },
      {
        key: 'check',
        name: 'Checks & sign-off',
        children: [
          { key: 'lights', name: 'Warning lights & door interlock', duration: 1, crews: [{ name: 'Electrical' }] },
          { key: 'survey', name: 'Shielding survey of walls & door', duration: 1, crews: [{ name: 'Medical equipment' }] },
          {
            key: 'exam',
            name: 'Radiation survey & sign-off',
            duration: 1,
            crews: [{ name: 'Medical equipment' }],
            note: 'The room may not be used for X-rays until this is signed.',
          },
        ],
      },
    ],
    links: [
      { from: 'design', to: 'order' },
      { from: 'order', to: 'boards' },
      { from: 'boards', to: 'door' },
      { from: 'door', to: 'seal' },
      { from: 'door', to: 'lights', type: 'SS' },
      { from: 'seal', to: 'survey' },
      { from: 'lights', to: 'exam' },
      { from: 'survey', to: 'exam' },
    ],
    timeRanges: [
      {
        key: 'closed',
        name: 'X-ray room closed to other trades',
        from: { task: 'boards', edge: 'start' },
        to: { task: 'exam', edge: 'end' },
        tone: 'rose',
        note: 'Only the lining crew and the engineers go in until the sign-off.',
      },
    ],
  },
  {
    starterKey: 'medical-gas-zone',
    name: 'Medical gas zone (one floor)',
    summary: 'Oxygen, vacuum and air piping for one floor, from rough-in to the verifier’s sign-off.',
    icon: 'lungs',
    unit: { one: 'floor', many: 'floors' },
    children: [
      {
        key: 'first',
        name: 'Piping',
        children: [
          { key: 'pipes', name: 'Install copper piping: oxygen, vacuum & air', duration: 4, crews: [{ name: 'Plumbing' }] },
          { key: 'pressure', name: 'Pressure test the piping', duration: 1, crews: [{ name: 'Plumbing' }], note: 'Hold point before ceilings close.' },
          { key: 'valves', name: 'Install zone valve box & alarm panel', duration: 1, crews: [{ name: 'Plumbing' }] },
        ],
      },
      {
        key: 'second',
        name: 'Outlets & alarms',
        children: [
          { key: 'outlets', name: 'Install wall outlets & headwall units', duration: 2, crews: [{ name: 'Plumbing' }] },
          { key: 'alarm', name: 'Wire the area alarm', duration: 1, crews: [{ name: 'Electrical' }] },
        ],
      },
      {
        key: 'test',
        name: 'Testing & sign-off',
        children: [
          { key: 'purge', name: 'Purge & cross-connection tests', duration: 1, crews: [{ name: 'Commissioning' }] },
          { key: 'identity', name: 'Gas identity & purity tests', duration: 1, crews: [{ name: 'Commissioning' }] },
          {
            key: 'signoff',
            name: 'Medical gas verifier signs off on the zone',
            duration: 1,
            crews: [{ name: 'Commissioning' }],
            note: 'Keep the test certificates for the closeout package.',
          },
        ],
      },
    ],
    links: [
      { from: 'pipes', to: 'pressure' },
      { from: 'pressure', to: 'valves' },
      { from: 'valves', to: 'outlets' },
      { from: 'valves', to: 'alarm', type: 'SS' },
      { from: 'outlets', to: 'purge' },
      { from: 'alarm', to: 'purge' },
      { from: 'purge', to: 'identity' },
      { from: 'identity', to: 'signoff' },
    ],
  },
  {
    starterKey: 'fire-stopping',
    name: 'Firestopping & inspection package',
    summary: 'Seal every opening in fire-rated walls, check fire doors and get it inspected and recorded.',
    icon: 'fire-extinguisher',
    unit: { one: 'floor', many: 'floors' },
    children: [
      {
        key: 'plan',
        name: 'Survey & approve',
        children: [
          { key: 'survey', name: 'Survey penetrations & mark up drawings', duration: 1, crews: [{ name: 'General contractor' }] },
          { key: 'agree', name: 'Get firestopping products approved by the building inspector', duration: 1, note: 'One meeting; no crew on site.' },
        ],
      },
      {
        key: 'stop',
        name: 'Firestopping',
        children: [
          {
            key: 'penetrations',
            name: 'Seal pipe & cable penetrations in fire walls',
            duration: 3,
            crews: [{ name: 'Firestopping' }],
            note: 'A specialty contractor; add them as a crew to see their workload.',
          },
          { key: 'heads', name: 'Firestop the head-of-wall joints', duration: 2, crews: [{ name: 'Firestopping' }] },
          { key: 'collars', name: 'Install fire collars & wraps on plastic pipes', duration: 1, crews: [{ name: 'Plumbing' }] },
        ],
      },
      {
        key: 'inspect',
        name: 'Inspection',
        children: [
          { key: 'doors', name: 'Check fire doors, seals & closers', duration: 1, crews: [{ name: 'Carpentry' }] },
          { key: 'thirdparty', name: 'Special inspection of firestopping', duration: 1 },
          { key: 'record', name: 'Photo log & certificates to the file', duration: 1, crews: [{ name: 'General contractor' }] },
        ],
      },
    ],
    links: [
      { from: 'survey', to: 'agree' },
      { from: 'agree', to: 'penetrations' },
      { from: 'penetrations', to: 'heads', type: 'SS', lag: 1 },
      { from: 'penetrations', to: 'collars' },
      { from: 'agree', to: 'doors' },
      { from: 'heads', to: 'thirdparty' },
      { from: 'collars', to: 'thirdparty' },
      { from: 'doors', to: 'thirdparty' },
      { from: 'thirdparty', to: 'record' },
    ],
  },
  {
    starterKey: 'nurse-call-data',
    name: 'Nurse call & data (one floor)',
    summary: 'Cable trays, data and nurse call cabling, devices and testing for one floor.',
    icon: 'network-wired',
    unit: { one: 'floor', many: 'floors' },
    children: [
      {
        key: 'cabling',
        name: 'Trays & cabling',
        children: [
          { key: 'tray', name: 'Install cable tray & basket', duration: 2, crews: [{ name: 'Electrical' }] },
          { key: 'data', name: 'Pull data cables to every outlet', duration: 3, crews: [{ name: 'IT & data' }] },
          { key: 'callcable', name: 'Pull nurse call cables', duration: 2, crews: [{ name: 'Electrical' }] },
        ],
      },
      {
        key: 'devices',
        name: 'Devices',
        children: [
          { key: 'terminate', name: 'Terminate & label data outlets', duration: 2, crews: [{ name: 'IT & data' }] },
          { key: 'wifi', name: 'Mount Wi-Fi access points', duration: 1, crews: [{ name: 'IT & data' }] },
          { key: 'callpoints', name: 'Install call stations, dome lights & displays', duration: 2, crews: [{ name: 'Electrical' }] },
        ],
      },
      {
        key: 'testing',
        name: 'Test & certify',
        children: [
          { key: 'datatest', name: 'Test & certify data links', duration: 1, crews: [{ name: 'IT & data' }] },
          {
            key: 'calltest',
            name: 'Nurse call test with clinic staff',
            duration: 1,
            crews: [{ name: 'Commissioning' }],
            note: 'Every call point, reset and display, room by room.',
          },
        ],
      },
    ],
    links: [
      { from: 'tray', to: 'data', type: 'SS', lag: 1 },
      { from: 'tray', to: 'callcable' },
      { from: 'data', to: 'terminate' },
      { from: 'terminate', to: 'wifi' },
      { from: 'callcable', to: 'callpoints' },
      { from: 'terminate', to: 'datatest' },
      { from: 'wifi', to: 'datatest' },
      { from: 'datatest', to: 'calltest' },
      { from: 'callpoints', to: 'calltest' },
    ],
  },
  {
    starterKey: 'accessible-restroom',
    name: 'Accessible restroom build-out',
    summary: 'Grab-bar blocking, a waterproof floor, the full set of accessible fixtures and the emergency alarm.',
    icon: 'wheelchair',
    unit: { one: 'restroom', many: 'restrooms' },
    children: [
      {
        key: 'first',
        name: 'Walls & rough-in',
        children: [
          { key: 'setout', name: 'Lay out fixtures & grab-bar locations', duration: 1, crews: [{ name: 'General contractor' }] },
          { key: 'studs', name: 'Stud walls with plywood blocking for grab bars', duration: 2, crews: [{ name: 'Carpentry' }] },
          { key: 'plumb1', name: 'Water & drainage rough-in', duration: 2, crews: [{ name: 'Plumbing' }] },
          { key: 'elec1', name: 'Lighting & alarm cable rough-in', duration: 1, crews: [{ name: 'Electrical' }] },
        ],
      },
      {
        key: 'finish',
        name: 'Finishes',
        children: [
          { key: 'board', name: 'Hang, tape & finish', duration: 1, crews: [{ name: 'Carpentry' }] },
          { key: 'vinyl', name: 'Sheet vinyl floor & cove base', duration: 1, crews: [{ name: 'Carpentry' }] },
          { key: 'paint', name: 'Paint', duration: 1, crews: [{ name: 'Painting' }] },
        ],
      },
      {
        key: 'fit',
        name: 'Fixtures',
        children: [
          { key: 'pack', name: 'Install toilet, sink & grab bars (ADA package)', duration: 1, crews: [{ name: 'Plumbing' }] },
          { key: 'pullcord', name: 'Emergency pull-cord alarm', duration: 1, crews: [{ name: 'Electrical' }] },
          { key: 'test', name: 'Test the alarm & punch list', duration: 1, crews: [{ name: 'General contractor' }] },
        ],
      },
    ],
    links: [
      { from: 'setout', to: 'studs' },
      { from: 'studs', to: 'plumb1', type: 'SS', lag: 1 },
      { from: 'studs', to: 'elec1', type: 'SS', lag: 1 },
      { from: 'studs', to: 'board' },
      { from: 'plumb1', to: 'board' },
      { from: 'elec1', to: 'board' },
      { from: 'board', to: 'vinyl' },
      { from: 'vinyl', to: 'paint' },
      { from: 'paint', to: 'pack' },
      { from: 'paint', to: 'pullcord' },
      { from: 'pack', to: 'test' },
      { from: 'pullcord', to: 'test' },
    ],
  },
  {
    starterKey: 'handover-pack',
    name: 'Closeout documentation package',
    summary: 'Certificates, drawings, manuals, training and the owner’s sign-off.',
    icon: 'folder-open',
    unit: { one: 'package', many: 'packages' },
    children: [
      {
        key: 'collect',
        name: 'Collect',
        children: [
          { key: 'certs', name: 'Gather test certificates from every trade', duration: 3, crews: [{ name: 'Commissioning' }] },
          { key: 'asbuilt', name: 'As-built drawings', duration: 4, crews: [{ name: 'General contractor' }] },
          { key: 'manuals', name: 'Operation & maintenance manuals', duration: 5, crews: [{ name: 'Commissioning' }] },
        ],
      },
      {
        key: 'review',
        name: 'Review',
        children: [
          { key: 'hsfile', name: 'Safety documentation', duration: 2, crews: [{ name: 'General contractor' }] },
          { key: 'estates', name: 'Review the package with the clinic’s facilities team', duration: 1, note: 'Bring the punch list too.' },
        ],
      },
      {
        key: 'hand',
        name: 'Hand over',
        children: [
          { key: 'training', name: 'Staff training sessions', duration: 2, crews: [{ name: 'Commissioning' }] },
          { key: 'logbook', name: 'Building records & keys', duration: 1, crews: [{ name: 'General contractor' }] },
          { key: 'signed', name: 'Owner signs the handover', duration: 0, note: 'A milestone: the date the clinic takes the keys.' },
        ],
      },
    ],
    links: [
      { from: 'certs', to: 'asbuilt', type: 'SS' },
      { from: 'certs', to: 'manuals', type: 'SS', lag: 1 },
      { from: 'certs', to: 'hsfile' },
      { from: 'asbuilt', to: 'hsfile' },
      { from: 'manuals', to: 'hsfile' },
      { from: 'hsfile', to: 'estates' },
      { from: 'estates', to: 'training' },
      { from: 'training', to: 'logbook' },
      { from: 'logbook', to: 'signed' },
    ],
  },

  {
    starterKey: 'pad-foundation',
    name: 'Spread footing',
    summary: 'Dig, inspect, reinforce, pour and cure one column footing; backfill starts before the cure ends.',
    icon: 'cube',
    unit: { one: 'pad', many: 'pads' },
    children: [
      {
        key: 'dig',
        name: 'Excavate & inspect',
        children: [
          { key: 'excavate', name: 'Saw-cut & excavate the footing', duration: 2, crews: [{ name: 'General contractor' }] },
          {
            key: 'inspect',
            name: 'Inspect the subgrade (hold point)',
            duration: 1,
            note: 'The building inspector sees the bottom of the excavation before any concrete goes in.',
          },
        ],
      },
      {
        key: 'concrete',
        name: 'Reinforce & pour',
        children: [
          { key: 'blinding', name: 'Mud slab', duration: 1, crews: [{ name: 'General contractor' }] },
          { key: 'rebar', name: 'Place rebar cage & anchor bolts', duration: 2, crews: [{ name: 'General contractor' }] },
          { key: 'pour', name: 'Pour the footing', duration: 1, crews: [{ name: 'General contractor' }, { name: 'Concrete pump' }] },
          { key: 'cure', name: 'Cure the concrete', duration: 7, crews: [{ name: 'General contractor', units: 20 }], note: 'Keep it wet and covered; a fifth of the crew checks it daily.' },
          { key: 'backfill', name: 'Backfill & compact around the footing', duration: 1, crews: [{ name: 'General contractor' }] },
        ],
      },
    ],
    links: [
      { from: 'excavate', to: 'inspect' },
      { from: 'inspect', to: 'blinding' },
      { from: 'blinding', to: 'rebar', lag: 1 },
      { from: 'rebar', to: 'pour' },
      { from: 'pour', to: 'cure' },
      { from: 'cure', to: 'backfill', lag: -2 },
    ],
    timeRanges: [
      { key: 'curing', name: 'Curing: no loads on the footing', from: { task: 'pour', edge: 'end' }, to: { task: 'cure', edge: 'end' }, tone: 'sky' },
    ],
  },
  {
    starterKey: 'floor-topping-and-floor',
    name: 'Floor topping, dry-out & floor finish',
    summary: 'Pump a floor topping, let it dry, test it, then lay the safety floor while the painters finish alongside.',
    icon: 'layer-group',
    unit: { one: 'area', many: 'areas' },
    children: [
      {
        key: 'topping',
        name: 'Floor topping',
        children: [
          { key: 'lay', name: 'Pump & level the floor topping', duration: 1, crews: [{ name: 'General contractor' }, { name: 'Concrete pump', units: 50 }] },
          { key: 'dry', name: 'Floor topping drying', duration: 10, note: 'No crew: the floor must stay clear while it dries.' },
          { key: 'moisture', name: 'Moisture test the floor topping', duration: 1, crews: [{ name: 'General contractor' }] },
        ],
      },
      {
        key: 'finish',
        name: 'Finishes',
        children: [
          { key: 'decorate', name: 'Paint walls & ceilings', duration: 4, crews: [{ name: 'Painting' }], note: 'Can start two days into the drying; keep off the floor.' },
          { key: 'vinyl', name: 'Safety vinyl & cove base', duration: 3, crews: [{ name: 'Carpentry' }] },
          { key: 'snag', name: 'Punch list the area', duration: 1, crews: [{ name: 'General contractor' }] },
        ],
      },
    ],
    links: [
      { from: 'lay', to: 'dry' },
      { from: 'dry', to: 'moisture' },
      { from: 'lay', to: 'decorate', type: 'SS', lag: 2 },
      { from: 'moisture', to: 'vinyl' },
      { from: 'vinyl', to: 'decorate', type: 'FF' },
      { from: 'vinyl', to: 'snag' },
      { from: 'decorate', to: 'snag' },
    ],
    timeRanges: [
      { key: 'keep-off', name: 'Floor topping drying: keep foot traffic off', from: { task: 'lay', edge: 'end' }, to: { task: 'dry', edge: 'end' }, tone: 'amber' },
    ],
  },
];

/** Folders and the snippets in them, as a new project's library starts. */
export const STARTER_FOLDERS: StarterFolder[] = [
  {
    name: 'Build-out',
    snippets: [],
    folders: [
      { name: 'Clinical rooms', snippets: ['consulting-room', 'xray-room'] },
      { name: 'Restrooms', snippets: ['accessible-restroom'] },
      { name: 'Floors & finishes', snippets: ['floor-topping-and-floor'] },
    ],
  },
  { name: 'Structure', snippets: ['pad-foundation'] },
  { name: 'MEP systems', snippets: ['medical-gas-zone', 'nurse-call-data'] },
  { name: 'Fire & compliance', snippets: ['fire-stopping'] },
  { name: 'Completion', snippets: ['handover-pack'] },
];

export const STARTER_SNIPPETS: readonly StarterSnippet[] = SNIPPETS;

export function starterSnippet(key: string): StarterSnippet | undefined {
  return SNIPPETS.find((snippet) => snippet.starterKey === key);
}

/** A folder as `seed_library()` takes it (supabase/migrations/20261024010000_library.sql). */
export interface SeedLibraryFolder {
  name: string;
  snippets: { name: string; summary: string; icon: string; unit: { one: string; many: string }; body: Record<string, unknown> }[];
  folders: SeedLibraryFolder[];
}

/** The starter library in the shape the seed writes. */
export function starterLibrarySeed(folders: readonly StarterFolder[] = STARTER_FOLDERS): SeedLibraryFolder[] {
  return folders.map((folder) => ({
    name: folder.name,
    snippets: folder.snippets.map((key) => {
      const snippet = starterSnippet(key);
      if (!snippet) throw new Error(`The starter library files an unknown snippet: ${key}`);
      const { name, summary, icon, unit, children, links, timeRanges } = snippet;
      return { name, summary, icon, unit, body: { children, links, ...(timeRanges ? { timeRanges } : {}) } };
    }),
    folders: starterLibrarySeed(folder.folders ?? []),
  }));
}
