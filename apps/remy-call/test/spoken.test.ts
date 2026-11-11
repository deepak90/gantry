import { describe, expect, it } from 'vitest';
import { numberWords, ordinalWords, speakableText, spokenSyllables, spokenText, wordSyllables } from '../src/spoken.ts';

/** Her lines in a recorded take, with their syllables counted by hand as said aloud. */
const HER_LINES: Array<[string, number]> = [
  ["Hi everyone, I've got the plan open.", 10],
  ['Drafting the fixtures for one floor.', 8],
  ['Here you go. Fixtures come to about $12,000 a floor.', 16],
  ['Fair enough, $35,000 a floor it is.', 14],
  ['It goes in with the ceiling tiles on level 1, so nothing moves. Levels 2 and 3 look the same; want me to add them?', 29],
  ['Done. One order for all three comes to $105,000.', 17],
  ['The PayPal invoice is ready to go.', 10],
  ["We're renting the crane from November 25 through December 13. It sits seven days with nothing to lift; that's $4,200.", 37],
  ['On it.', 2],
  ['Done. A day either side, and that saves us $3,000.', 15],
  ['In the plan, the ground-floor slab work waits for this payment. It starts the working day after the money lands, Wednesday, November 11, if paid by Tuesday.', 38],
  ['Let me play it out.', 5],
  ["If we wait for Friday's pay run, we make the deadline about half the time. If we pay when it falls due, it's about eight times out of ten.", 33],
  ['All set, one PayPal payout to both firms. Anything over $25,000 needs two of us, so Chris signs off too.', 31],
  ['The payment went through to both firms. The ground-floor slab base starts Wednesday.', 16],
  ['Anytime!', 3],
];

describe('spokenSyllables', () => {
  it.each(HER_LINES)('counts her line as said: %s', (text, syllables) => {
    expect(spokenSyllables(text)).toBe(syllables);
  });

  it('is within one on her longest line, money and a firm name in it', () => {
    // 63 by hand; the estimate hears "Pinecrest" as three syllables (the silent e inside a compound).
    const line = '$37,800 in all: $31,320 to Granite Ridge for the forms, rebar and pour, and $6,480 to Pinecrest for the backfill. It would normally go out Friday.';
    expect(Math.abs(spokenSyllables(line) - 63)).toBeLessThanOrEqual(1);
  });

  it('counts money and numbers as their words', () => {
    expect(spokenSyllables('$37,800')).toBe(11); // thir-ty sev-en thou-sand eight hun-dred dol-lars
    expect(spokenSyllables('level 1')).toBe(3);
    expect(spokenSyllables('Levels 2 and 3')).toBe(5);
    expect(spokenSyllables('$105,000')).toBe(8); // one hun-dred five thou-sand dol-lars
  });
});

describe('spokenText', () => {
  it('reads money out, with cents and scales', () => {
    expect(spokenText('$37,800')).toBe('thirty seven thousand eight hundred dollars');
    expect(spokenText('$31,320 to Granite Ridge')).toBe('thirty one thousand three hundred twenty dollars to Granite Ridge');
    expect(spokenText('about $12,000 a floor.')).toBe('about twelve thousand dollars a floor.');
    expect(spokenText('$12.50')).toBe('twelve dollars and fifty cents');
    expect(spokenText('$1.2 million')).toBe('one point two million dollars');
    expect(spokenText('$12k')).toBe('twelve thousand dollars');
    expect(spokenText('$1')).toBe('one dollar');
  });

  it('reads digits, dates, times and percentages as she says them', () => {
    expect(spokenText('on level 1, so')).toBe('on level one, so');
    expect(spokenText('from November 25 through December 13.')).toBe('from November twenty fifth through December thirteenth.');
    expect(spokenText('Mon, Nov 30')).toBe('Monday, November thirtieth');
    expect(spokenText('at 2:30 PM')).toBe('at two thirty p m');
    expect(spokenText('by 7am')).toBe('by seven a m');
    expect(spokenText('at 10:05')).toBe('at ten oh five');
    expect(spokenText('45% done')).toBe('forty five percent done');
    expect(spokenText('the 3rd floor')).toBe('the third floor');
    expect(spokenText('2–3 days')).toBe('two to three days');
    expect(spokenText('May 2027')).toBe('May twenty twenty seven');
    expect(spokenText('2.5 days')).toBe('two point five days');
  });

  it('spells capitals letter by letter', () => {
    expect(spokenText('the PDF')).toBe('the P D F');
    expect(spokenText('two WBSs')).toBe('two double u B S');
    expect(spokenText('the HVAC crew')).toBe('the h vac crew');
    expect(spokenSyllables('OK')).toBe(2);
  });

  it('writes whole numbers US style', () => {
    expect(numberWords(0)).toBe('zero');
    expect(numberWords(105_000)).toBe('one hundred five thousand');
    expect(numberWords(6_480)).toBe('six thousand four hundred eighty');
    expect(numberWords(2_000_000)).toBe('two million');
    expect(ordinalWords(1)).toBe('first');
    expect(ordinalWords(22)).toBe('twenty second');
    expect(ordinalWords(30)).toBe('thirtieth');
  });
});

describe('speakableText', () => {
  it.each([
    [
      "We're renting it November 25 through December 23. It sits fourteen days with nothing to lift; that's $8,400.",
      "We're renting it November twenty-fifth through December twenty-third. It sits fourteen days with nothing to lift; that's eight thousand four hundred dollars.",
    ],
    ["Sure. At four thousand square feet, that's about fifty fixtures a floor. Do we have a price?", "Sure. At four thousand square feet, that's about fifty fixtures a floor. Do we have a price?"],
    ["That's $35,000 a floor.", "That's thirty-five thousand dollars a floor."],
    [
      'The footings payment, $37,800. Two crews did that work: Granite Ridge gets about $31,000, and the rest goes to Pinecrest. It would normally go out Friday.',
      'The footings payment, thirty-seven thousand eight hundred dollars. Two crews did that work: Granite Ridge gets about thirty-one thousand dollars, and the rest goes to Pinecrest. It would normally go out Friday.',
    ],
    ['Anytime!', 'Anytime!'],
  ])('writes her line out for the voice: %s', (line, written) => {
    expect(speakableText(line)).toBe(written);
  });

  it('reads dates the way her tools write them, never "Mon, Nov 2"', () => {
    expect(speakableText('Mon, Nov 2')).toBe('Monday, November second');
    expect(speakableText('Wed, Nov 25, 2026')).toBe('Wednesday, November twenty-fifth, twenty twenty-six');
    expect(speakableText('on Sat, May 22.')).toBe('on Saturday, May twenty-second.');
    expect(speakableText('Sat May 22')).toBe('Saturday, May twenty-second');
    expect(speakableText('Nov 25–Dec 23')).toBe('November twenty-fifth to December twenty-third');
    expect(speakableText('by Nov 2026')).toBe('by November twenty twenty-six');
    expect(speakableText('due 2026-11-30.')).toBe('due November thirtieth, twenty twenty-six.');
  });

  it('reads money as dollars and cents, ranges and scales too', () => {
    expect(speakableText('$1')).toBe('one dollar');
    expect(speakableText('$12.50')).toBe('twelve dollars and fifty cents');
    expect(speakableText('$0.50')).toBe('fifty cents');
    expect(speakableText('$8,400.00')).toBe('eight thousand four hundred dollars');
    expect(speakableText('$1.2 million')).toBe('one point two million dollars');
    expect(speakableText('about $12k')).toBe('about twelve thousand dollars');
    expect(speakableText('$5,000–$6,000')).toBe('five thousand dollars to six thousand dollars');
  });

  it('makes an amount singular where it describes something', () => {
    expect(speakableText('a $12,000 change order')).toBe('a twelve thousand dollar change order');
    expect(speakableText('an $8,400 rental')).toBe('an eight thousand four hundred dollar rental');
    expect(speakableText('a $1.2 million job')).toBe('a one point two million dollar job');
    expect(speakableText('a $50 fee')).toBe('a fifty dollar fee');
    expect(speakableText("It's about $35,000 a floor.")).toBe("It's about thirty-five thousand dollars a floor.");
    expect(speakableText('That comes to a $8,400.')).toBe('That comes to a eight thousand four hundred dollars.');
  });

  it('writes times the way the voice reads them, and keeps the sentence they end', () => {
    expect(speakableText('at 2:30 PM')).toBe('at two thirty PM');
    expect(speakableText('Meet at 2:30 PM. Chris is in.')).toBe('Meet at two thirty PM. Chris is in.');
    expect(speakableText('by 7 a.m. tomorrow')).toBe('by seven AM tomorrow');
    expect(speakableText('by 7 a.m. Chris is in.')).toBe('by seven AM. Chris is in.');
    expect(speakableText('at 7am.')).toBe('at seven AM.');
    expect(speakableText('at 10:05, ok')).toBe('at ten oh five, ok');
  });

  it('reads numbers and areas, joining compound numbers the way a person writes them', () => {
    expect(speakableText('45% done on level 3')).toBe('forty-five percent done on level three');
    expect(speakableText('the 3rd floor, 2–3 days')).toBe('the third floor, two to three days');
    expect(speakableText('twenty one days')).toBe('twenty-one days');
    expect(speakableText('4,000 sq ft')).toBe('four thousand square feet');
    expect(speakableText('about 3,000 sq. ft. of open plan')).toBe('about three thousand square feet of open plan');
    expect(speakableText('4,000 sqft.')).toBe('four thousand square feet.');
  });

  it('leaves capitals for the voice, which says them better than spelled out', () => {
    expect(speakableText('Send the PDF to the GC. The HVAC crew is OK with it.')).toBe('Send the PDF to the GC. The HVAC crew is OK with it.');
  });

  it('leaves the syllable counter its letter-by-letter capitals', () => {
    expect(spokenText('the PDF at 2:30 PM')).toBe('the P D F at two thirty p m');
  });
});

describe('wordSyllables', () => {
  it.each([
    ['fixtures', 2],
    ['tiles', 1],
    ['moves', 1],
    ['places', 2],
    ['payment', 2],
    ['payout', 2],
    ['ceiling', 2],
    ['drafting', 2],
    ['going', 2],
    ['paying', 2],
    ['thing', 1],
    ['normally', 3],
    ['completely', 3],
    ["didn't", 2],
    ["don't", 1],
    ["I've", 1],
    ["We're", 1],
    ["Chris's", 2],
    ['settled', 2],
    ['scheduled', 2],
    ['moved', 1],
    ['added', 2],
    ['delayed', 2],
    ['actual', 3],
    ['radio', 3],
    ['nation', 2],
    ['people', 2],
    ['table', 2],
    ['everyone', 3],
    ['Wednesday', 2],
    ['eleven', 3],
    ['twelve', 1],
    ['thirtieth', 3],
  ] as Array<[string, number]>)('%s has %i', (word, syllables) => {
    expect(wordSyllables(word)).toBe(syllables);
  });
});
