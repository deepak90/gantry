/**
 * The call's subtitles: one speaker at a time, their lines run together until someone else speaks; a line of
 * someone else's already under way doesn't take the caption back from whoever spoke after it.
 */
import { describe, expect, it } from 'vitest';
import { Subtitles } from '../../src/call/subtitles';

const caption = (identity: string, segmentId: string, text: string, final = true) => ({ identity, segmentId, text, final });

describe('the call’s subtitles', () => {
  it('runs a speaker’s lines together, and grows the latest as it is transcribed', () => {
    const subtitles = new Subtitles();
    expect(subtitles.current()).toBeNull();
    expect(subtitles.take(caption('chris', 'c1', 'Okay, two things.'), 1000)).toEqual({ identity: 'chris', text: 'Okay, two things.', last: 'Okay, two things.', final: true });
    expect(subtitles.take(caption('chris', 'c2', 'The tenant wants', false), 2000)).toMatchObject({ text: 'Okay, two things. The tenant wants', last: 'The tenant wants', final: false });
    expect(subtitles.take(caption('chris', 'c2', 'The tenant wants new lights.'), 2400)).toMatchObject({ text: 'Okay, two things. The tenant wants new lights.', final: true });
  });

  it('hands the caption to whoever speaks next', () => {
    const subtitles = new Subtitles();
    subtitles.take(caption('chris', 'c1', 'Remy, can you add the lights?'), 1000);
    expect(subtitles.take(caption('remy', 'm1', 'Sure,', false), 3000)).toEqual({ identity: 'remy', text: 'Sure,', last: 'Sure,', final: false });
    expect(subtitles.take(caption('chris', 'c2', 'Thanks.'), 6000)).toMatchObject({ identity: 'chris', text: 'Thanks.' });
  });

  it('doesn’t give it back to a line that started before the new speaker did', () => {
    const subtitles = new Subtitles();
    subtitles.take(caption('remy', 'm1', 'Levels two and three look the', false), 1000);
    subtitles.take(caption('chris', 'c1', 'Yep, do all', false), 2000);
    // Her voice was cut off in the word "same": its last caption comes in after Chris took over.
    expect(subtitles.take(caption('remy', 'm1', 'Levels two and three look the sa'), 2100)).toBeNull();
    expect(subtitles.current()).toMatchObject({ identity: 'chris', text: 'Yep, do all' });
    // A new line of hers, after his, is hers to show.
    expect(subtitles.take(caption('remy', 'm2', 'Got it.'), 5000)).toMatchObject({ identity: 'remy', text: 'Got it.' });
  });

  it('lets someone take the floor before their words are in, and keeps it theirs', () => {
    const subtitles = new Subtitles();
    subtitles.take(caption('remy', 'm1', 'Levels two and three look the', false), 1000);
    expect(subtitles.floor('chris', 2000)).toEqual({ identity: 'chris', text: '', last: '', final: false });
    // Her line, still coming in, doesn't take it back; his first words join his floor.
    expect(subtitles.take(caption('remy', 'm1', 'Levels two and three look the same'), 2100)).toBeNull();
    expect(subtitles.take(caption('chris', 'c1', 'Yep, do', false), 2600)).toMatchObject({ identity: 'chris', text: 'Yep, do' });
    // Taking the floor again changes nothing.
    expect(subtitles.floor('chris', 2700)).toMatchObject({ identity: 'chris', text: 'Yep, do' });
  });

  it('never starts a caption with punctuation', () => {
    const subtitles = new Subtitles();
    expect(subtitles.take(caption('remy', 'm1', '. The crane is on rent November 30.'), 1000)).toMatchObject({ text: 'The crane is on rent November 30.' });
    expect(subtitles.take(caption('remy', 'm2', '… Nothing sits idle.'), 2000)).toMatchObject({ text: 'The crane is on rent November 30. Nothing sits idle.', last: 'Nothing sits idle.' });
  });

  it('starts afresh once the bar went quiet', () => {
    const subtitles = new Subtitles();
    subtitles.take(caption('deepak', 'd1', 'Sounds fair.'), 1000);
    subtitles.clear();
    expect(subtitles.current()).toBeNull();
    expect(subtitles.take(caption('deepak', 'd2', 'Remy, how’s the crane rental looking?'), 9000)).toMatchObject({ text: 'Remy, how’s the crane rental looking?' });
  });
});
