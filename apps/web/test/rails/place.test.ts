/**
 * The number a place is called by, however it is said: "level 1", "floor one", "the first floor"; and
 * what the library's note says once a package is on the plan, as sentences.
 */
import { describe, expect, it } from 'vitest';
import { noteWords, placeNumber } from '../../src/rails/place';

describe('what the library says it did', () => {
  it('reads each part of the note as its own sentence, without the buttons', () => {
    const note = document.createElement('div');
    note.innerHTML = `<i></i><div class="library-note-text"><strong>Added Light fixtures</strong><span>After “Ceiling grid, level 1”.</span><span class="library-note-placed"><i></i> Light fixtures hang from the ceiling grid</span><span>“Ceiling tiles, level 1” and 19 more moved later (up to 13 days)</span><span class="library-note-actions"><button>Show in the plan</button><button>Undo</button></span></div>`;
    expect(noteWords(note)).toBe(
      'Added Light fixtures. After “Ceiling grid, level 1”. Light fixtures hang from the ceiling grid. “Ceiling tiles, level 1” and 19 more moved later (up to 13 days).',
    );
  });
});

describe('naming a place', () => {
  it('reads the number a floor or wing is called by', () => {
    expect(placeNumber('level 1')).toBe(1);
    expect(placeNumber('floor one')).toBe(1);
    expect(placeNumber('the first floor')).toBe(1);
    expect(placeNumber('Wing 2')).toBe(2);
    expect(placeNumber('third floor')).toBe(3);
    expect(placeNumber('the roof')).toBeNull();
  });
});
