/**
 * Reading what you said, so the assistant's hand follows your words: the amount you named, and which
 * line of a draft your words are about. Plain rules, no guessing beyond them; the transcription is
 * whatever was heard.
 */

/** A word as matched: lower case, letters and digits only ("7,500." is "7500", "I’m" is "im"). */
export const plainWord = (word: string): string =>
  word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');

/** Words that say nothing about which line is meant. */
const FILLER = new Set(
  'the this that these those more like around about should would will needs need cost costs price instead make made it its be is are was were for and not no yes our we you can please just really actually rather than closer nearer each every here there with'.split(' '),
);

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Readonly<Record<string, number>> = { thousand: 1000, million: 1_000_000 };

/**
 * Amounts said in words, in the order they come, with where each starts: "thirty-five thousand" is 35,000, "a hundred
 * and five thousand" 105,000, "forty-two hundred" 4,200. A transcript writes some amounts out in words.
 */
export function amountsInWords(said: string): { value: number; index: number }[] {
  const found: { value: number; index: number }[] = [];
  const words = [...said.toLowerCase().matchAll(/[a-z]+/g)];
  let total = 0;
  let part = 0;
  let start = -1;
  let last = '';
  const close = () => {
    if (start >= 0) found.push({ value: total + part, index: start });
    total = 0;
    part = 0;
    start = -1;
    last = '';
  };
  let end = 0;
  for (const match of words) {
    const word = match[0];
    const index = match.index ?? 0;
    // A stop or a comma ends a number: "not twelve thousand, thirty-five thousand" is two.
    if (/[,.;:?!—–]/.test(said.slice(end, index))) close();
    end = index + word.length;
    const unit = UNITS[word] ?? TENS[word];
    if (unit !== undefined) {
      // "five ... six" with no tens between them are two numbers.
      if (start >= 0 && last !== 'and' && (UNITS[last] !== undefined || (TENS[last] !== undefined && TENS[word] !== undefined))) close();
      if (start < 0) start = index;
      part += unit;
    } else if (word === 'hundred' && start >= 0) {
      part = (part || 1) * 100;
    } else if (word === 'hundred' && (last === 'a' || last === 'one')) {
      start = index;
      part = 100;
    } else if (SCALES[word] !== undefined && start >= 0) {
      total += (part || 1) * SCALES[word]!;
      part = 0;
    } else if (word === 'and' && start >= 0) {
      // "a hundred and five": the number goes on.
    } else if (word !== 'a') {
      close();
    }
    last = word;
  }
  close();
  return found;
}

/**
 * The amount named in what was said, in whole dollars: "7,600", "$7600", "7600.00", "7.6k", "7.6
 * thousand" or in words ("thirty-five thousand"). An amount said to be replaced ("instead of 6,000",
 * "not 6,000", "from 6,000") doesn't count. Null when there is none.
 */
export function amountIn(said: string): number | null {
  const text = said.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const amount = /\$?\s*(\d+(?:\.\d+)?)\s*(k\b|thousand\b)?/gi;
  const replaced = /(?:instead of|not|rather than|from|was)\s*$/i;
  for (const match of text.matchAll(amount)) {
    const before = text.slice(0, match.index);
    if (replaced.test(before)) continue;
    const value = Number(match[1]) * (match[2] ? 1000 : 1);
    // A price, not a level or a count.
    if (value >= 100) return Math.round(value);
  }
  for (const { value, index } of amountsInWords(text)) {
    if (replaced.test(text.slice(0, index))) continue;
    if (value >= 100) return Math.round(value);
  }
  return null;
}

/** The words of what was said that could name something: four letters or more, no fillers, no numbers. */
export function namingWords(said: string): string[] {
  return said
    .split(/\s+/)
    .map(plainWord)
    .filter((word) => word.length >= 4 && !FILLER.has(word) && !/^\d+$/.test(word));
}

/** A word without its ending, so "wiring" and "wire", or "fixtures" and "fixture", meet. */
const stem = (word: string): string => word.replace(/(ing|ed|es|e|s)$/, '');

/**
 * Two words for the same thing: the same, one the start of the other ("test", "testing"), the same
 * once their endings are off ("wiring", "wire"), or sharing their first five letters ("electrician",
 * "electrical").
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [sa, sb] = [stem(a), stem(b)];
  if (sa.length >= 3 && sa === sb) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 4 && long.startsWith(short)) return true;
  const length = Math.min(5, a.length, b.length);
  return length >= 5 && a.slice(0, length) === b.slice(0, length);
}

/** How many of the words that name something in `said` turn up in `text`. */
export function mentions(said: string, text: string): number {
  const words = text.split(/\s+/).map(plainWord).filter(Boolean);
  return namingWords(said).filter((named) => words.some((word) => sameWord(named, word))).length;
}
