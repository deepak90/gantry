/**
 * The browser's own placement rules (when the assistant cannot be asked): the same place as on the
 * floor before, else the build-out trade order, else the end of the group. And which groups are the
 * same place ("Concrete deck, level 1" and "Level 1 build-out"), and whether a group holds the kind of
 * work a piece is (light fixtures among a floor's build-out, not in its concrete pour).
 */
import { describe, expect, it } from 'vitest';
import { baseName, placeNumber, placeOf, stageFits, suggestPlacement, withTheTiles } from '../src/placement';

const level = (n: number) => ({
  name: `Level ${n} build-out`,
  tasks: [
    { id: n * 100 + 11, name: `Lay out partitions, level ${n}` },
    { id: n * 100 + 12, name: `Frame partitions, level ${n}` },
    { id: n * 100 + 13, name: `Electrical rough-in, level ${n}` },
    { id: n * 100 + 14, name: `Ceiling grid, level ${n}` },
    { id: n * 100 + 15, name: `Hang and tape drywall, level ${n}` },
    { id: n * 100 + 16, name: `Ceiling tiles, level ${n}` },
    { id: n * 100 + 17, name: `Paint, level ${n}` },
    { id: n * 100 + 18, name: `Floor finishes, level ${n}` },
  ],
});

const fixtures = {
  name: 'Light fixtures',
  tasks: [
    { name: 'Order light fixtures', days: 1 },
    { name: 'Install light fixtures', days: 4 },
    { name: 'Test and tag lighting', days: 1 },
  ],
};

describe('baseName', () => {
  it('drops the floor or copy a task belongs to', () => {
    expect(baseName('Ceiling grid, level 2')).toBe('ceiling grid');
    expect(baseName('Ceiling grid – Floor 3')).toBe('ceiling grid');
    expect(baseName('Paint (level 1)')).toBe('paint');
    expect(baseName('Exam room 2')).toBe('exam room');
  });
});

const diffusers = { name: 'Air diffusers', tasks: [{ name: 'Install air diffusers', days: 2 }] };

describe('suggestPlacement', () => {
  it('puts what hangs from the grid after the ceiling grid and before the tiles, wherever it was let go', () => {
    expect(suggestPlacement(diffusers, level(1))).toMatchObject({ afterId: 114, beforeId: 116, source: 'rules' });
    expect(suggestPlacement(diffusers, level(1))!.reason).toContain('hangs from the ceiling grid');
  });

  it('puts light fixtures in a lay-in ceiling in with the tiles: alongside them, so nothing moves', () => {
    const placed = suggestPlacement(fixtures, level(1));
    expect(placed).toMatchObject({ afterId: 116, beforeId: null, source: 'rules', mode: 'alongside' });
    expect(placed!.reason).toBe('In a lay-in ceiling the fixtures go in with the tiles: it starts with Ceiling tiles, level 1, and nothing moves.');
    // Without a grid and its tiles, or for another piece, the rule has nothing to say.
    expect(withTheTiles(fixtures, { name: 'Lobby', tasks: [{ id: 1, name: 'Plaster ceiling' }, { id: 2, name: 'Paint' }] })).toBeNull();
    expect(withTheTiles(diffusers, level(1))).toBeNull();
  });

  it('follows a precedent that went in alongside, on the same task of the next floor', () => {
    const placed = suggestPlacement(fixtures, level(2), { group: 'Level 1 build-out', after: 'Ceiling tiles, level 1', before: null, mode: 'alongside' });
    expect(placed).toEqual({ afterId: 216, beforeId: null, reason: 'Placed like Level 1 build-out: with Ceiling tiles, level 2.', source: 'rules', mode: 'alongside' });
  });

  it('follows the precedent from another floor', () => {
    const placed = suggestPlacement(fixtures, level(3), { group: 'Level 1 build-out', after: 'Ceiling grid, level 1', before: 'Ceiling tiles, level 1' });
    expect(placed).toEqual({ afterId: 314, beforeId: 316, reason: 'Placed like Level 1 build-out: after Ceiling grid, level 3, before Ceiling tiles, level 3.', source: 'rules' });
  });

  it('goes to the end when nothing says otherwise, and has nothing to say about an empty group', () => {
    expect(suggestPlacement({ name: 'Signage', tasks: [{ name: 'Fix signage', days: 1 }] }, level(1))).toMatchObject({ afterId: 118, beforeId: null });
    expect(suggestPlacement(fixtures, { name: 'Empty', tasks: [] })).toBeNull();
  });
});

describe('the place a name is for', () => {
  it('is the same for a floor however its groups put it', () => {
    expect(placeOf('Concrete deck, level 1')).toBe('level 1');
    expect(placeOf('Level 1 build-out')).toBe('level 1');
    expect(placeOf('Level 2 build-out')).toBe('level 2');
    expect(placeOf('Fit-out, second floor')).toBe('level 2');
    expect(placeOf('Ground floor build-out')).toBe('level 0');
    expect(placeOf('Wing 2 fit-out')).toBe('wing 2');
  });

  it('is none for a name that names no place', () => {
    expect(placeOf('Structure')).toBeNull();
    expect(placeOf('Erect steel and metal deck')).toBeNull();
    expect(placeOf('Footings')).toBeNull();
  });

  it('reads the number a place is called by, said or written', () => {
    expect(placeNumber('floor one')).toBe(1);
    expect(placeNumber('the 2nd floor')).toBe(2);
    expect(placeNumber('level 3')).toBe(3);
    expect(placeNumber('the roof')).toBeNull();
  });
});

describe('whether a group holds the kind of work a piece is', () => {
  const fixtures = { name: 'Light fixtures', tasks: [{ name: 'Order light fixtures', days: 1 }, { name: 'Install light fixtures', days: 3 }] };
  const deck = ['Edge forms and shoring, level 1', 'Rebar and mesh, level 1', 'Pour deck, level 1', 'Cure deck, level 1'];

  it('finds light fixtures at home in a build-out and not in a concrete deck', () => {
    expect(stageFits(fixtures, level(1).tasks.map((task) => task.name))).toBe(true);
    expect(stageFits(fixtures, deck)).toBe(false);
  });

  it('says nothing about work the trade order doesn’t know', () => {
    expect(stageFits({ name: 'Safety netting', tasks: [{ name: 'Hang safety netting', days: 1 }] }, deck)).toBeNull();
  });
});
