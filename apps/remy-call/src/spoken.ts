/**
 * A line as Remy says it aloud, and about how many syllables that is: the pace check (pace.ts) times her takes per
 * spoken syllable. Numbers are read out ("$37,800" is "thirty seven thousand eight hundred dollars", "level 1" is
 * "level one", "November 25" is "November twenty fifth", "2:30 PM" is "two thirty p m"), capitals like "PDF" letter
 * by letter, and each word's syllables come from its spelling: its vowel groups, less a silent e and the like, with a
 * short list of words the rules get wrong. It is an estimate, not a dictionary; it only has to be steady on her kinds
 * of lines (test/spoken.test.ts checks it on her typical lines).
 *
 * The same writing-out feeds `speakableText`, what a voice that can't read figures is handed.
 */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES: Array<[number, string]> = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
];
const ORDINALS: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
const MONTHS: Record<string, string> = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', sept: 'September', oct: 'October', nov: 'November', dec: 'December',
};
const WEEKDAYS: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', tues: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const MONTH_NAME = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)';
/** Capitals said as a word, not letter by letter. */
const SAID_AS_WORDS: Record<string, string> = { HVAC: 'h vac' };
const LETTER_NAMES: Record<string, string> = { W: 'double u' };

/** A whole number in words, US style (no "and"): 105000 → "one hundred five thousand". */
export function numberWords(n: number): string {
  const whole = Math.floor(Math.abs(n));
  if (whole < 20) return ONES[whole] ?? 'zero';
  if (whole < 100) return [TENS[Math.floor(whole / 10)], whole % 10 ? ONES[whole % 10] : ''].filter(Boolean).join(' ');
  if (whole < 1000) return [`${ONES[Math.floor(whole / 100)]} hundred`, whole % 100 ? numberWords(whole % 100) : ''].filter(Boolean).join(' ');
  for (const [size, name] of SCALES) {
    if (whole >= size) return [`${numberWords(Math.floor(whole / size))} ${name}`, whole % size ? numberWords(whole % size) : ''].filter(Boolean).join(' ');
  }
  return String(whole);
}

/** 25 → "twenty fifth". */
export function ordinalWords(n: number): string {
  const words = numberWords(n).split(' ');
  const last = words.pop() ?? '';
  words.push(ORDINALS[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`));
  return words.join(' ');
}

/** 2026 → "twenty twenty six", 1905 → "nineteen oh five", 2007 → "two thousand seven". */
function yearWords(n: number): string {
  if (n >= 2000 && n < 2010) return numberWords(n);
  const low = n % 100;
  return `${numberWords(Math.floor(n / 100))} ${low === 0 ? 'hundred' : low < 10 ? `oh ${ONES[low]}` : numberWords(low)}`;
}

/** "PM", "pm", "p.m." after a time. A dot that ends the sentence stays: only one inside a running sentence goes. */
const MERIDIEM = String.raw`([aApP])(?:\.\s?[mM](?:\.(?=\s*[a-z,;]))?|[mM])(?![a-zA-Z])`;
const CLOCK_TIME = new RegExp(String.raw`\b(\d{1,2}):(\d{2})(?:\s?${MERIDIEM})?`, 'g');
const HOUR_TIME = new RegExp(String.raw`\b(\d{1,2})\s?${MERIDIEM}`, 'g');

const digitsWords = (digits: string) => [...digits].map((d) => ONES[Number(d)] ?? '').join(' ');
const toNumber = (digits: string) => Number(digits.replace(/,/g, ''));

/** "1,250", "2.5", "2026" as said. */
function plainNumber(token: string): string {
  const [whole = '0', fraction] = token.split('.');
  const n = toNumber(whole);
  if (fraction !== undefined) return `${numberWords(n)} point ${digitsWords(fraction)}`;
  if (!whole.includes(',') && whole.length === 4 && n >= 1900 && n < 2100) return yearWords(n);
  return numberWords(n);
}

/** `describing` a noun, an amount is singular: "a twelve thousand dollar order". */
function moneyWords(whole: string, fraction: string | undefined, scale: string | undefined, describing = false): string {
  const n = toNumber(whole);
  const scaleWord = scale ? ({ k: 'thousand', m: 'million', b: 'billion', bn: 'billion' }[scale.toLowerCase()] ?? scale.toLowerCase()) : '';
  if (scaleWord) return `${fraction ? `${numberWords(n)} point ${digitsWords(fraction)}` : numberWords(n)} ${scaleWord} ${describing ? 'dollar' : 'dollars'}`;
  const cents = fraction ? Number(fraction.padEnd(2, '0').slice(0, 2)) : 0;
  const centsWords = `${numberWords(cents)} ${cents === 1 ? 'cent' : 'cents'}`;
  if (n === 0 && cents) return centsWords;
  return `${numberWords(n)} ${n === 1 || (describing && !cents) ? 'dollar' : 'dollars'}${cents ? ` and ${centsWords}` : ''}`;
}

function timeWords(hour: string, minute: string | undefined, half: string | undefined): string {
  const m = minute ? Number(minute) : 0;
  const minutes = m === 0 ? '' : m < 10 ? ` oh ${ONES[m]}` : ` ${numberWords(m)}`;
  return `${numberWords(Number(hour))}${minutes}${half ? ` ${half.toLowerCase()} m` : ''}`;
}

/** Money, percentages, times, dates and numbers written out as she says them. */
function writtenOut(text: string): string {
  return (
    ` ${text} `
      .replace(/[‘’]/g, "'")
      .replace(/&/g, ' and ')
      // a range of money: $5,000–$6,000
      .replace(/(\$[\d.,]*\d[kKmMbB]?)\s?[–—-]\s?(?=\$)/g, '$1 to ')
      // money: $37,800 · $12.50 · $1.2 million · $12k
      // after "a", before a word, it describes that word: a $12,000 order
      .replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(thousand|million|billion|trillion|bn|[kmb])\b)?/gi, (match: string, whole: string, fraction: string | undefined, scale: string | undefined, at: number, all: string) => {
        const describing = /\ban?\s+$/i.test(all.slice(Math.max(0, at - 4), at)) && /^\s+[a-z]/.test(all.slice(at + match.length));
        return ` ${moneyWords(whole, fraction, scale, describing)} `;
      })
      .replace(/(\d+(?:\.\d+)?)\s?%/g, (_, n: string) => ` ${plainNumber(n)} percent `)
      // times: 2:30 PM · 7am · 10:05
      .replace(CLOCK_TIME, (_, h: string, m: string, half?: string) => ` ${timeWords(h, m, half)} `)
      .replace(HOUR_TIME, (_, h: string, half: string) => ` ${timeWords(h, undefined, half)} `)
      // dates: 2026-11-30 · "Mon, Nov 30" is Monday, November thirtieth · Nov 25–Dec 23 · Nov 2026
      .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, year: string, month: string, day: string) => {
        const name = MONTHS[Object.keys(MONTHS).filter((key) => key !== 'sept')[Number(month) - 1] ?? ''];
        return name ? ` ${name} ${ordinalWords(Number(day))}, ${year} ` : whole;
      })
      .replace(new RegExp(`\\b(Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat|Sun)\\.?,?\\s+(?=${MONTH_NAME}\\b)`, 'g'), (_, day: string) => `${WEEKDAYS[day.toLowerCase()] ?? day}, `)
      .replace(new RegExp(`(\\d(?:st|nd|rd|th)?)\\s?[–—-]\\s?(?=${MONTH_NAME}\\b)`, 'g'), '$1 to ')
      .replace(new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![,.]?\\d)`, 'g'), (_, month: string, day: string) => ` ${MONTHS[month.slice(0, 3).toLowerCase()] ?? month} ${ordinalWords(Number(day))} `)
      .replace(new RegExp(`\\b(${MONTH_NAME})\\.?\\s+(?=\\d{4}\\b)`, 'g'), (_, month: string) => `${MONTHS[month.slice(0, 3).toLowerCase()] ?? month} `)
      .replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_, n: string) => ` ${ordinalWords(Number(n))} `)
      // ranges: 2–3 days
      .replace(/(\d)\s?[–—-]\s?(?=\d)/g, '$1 to ')
      // areas: 4,000 sq ft
      .replace(/(\d)\s?(?:sq\.?\s?ft\b(?:\.(?=\s+[a-z]))?|sqft\b)/gi, '$1 square feet')
      .replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, (n) => ` ${plainNumber(n)} `)
  );
}

const tidied = (text: string) => text.replace(/\s+/g, ' ').replace(/ ([,.;:!?])/g, '$1').trim();

/** The line with its numbers, money, dates, times and capitals written out as she says them. */
export function spokenText(text: string): string {
  // capitals letter by letter: PDF, GC, OK (a plural s adds nothing)
  return tidied(writtenOut(text).replace(/\b([A-Z]{2,5})s?\b/g, (_, caps: string) => ` ${SAID_AS_WORDS[caps] ?? [...caps].map((c) => LETTER_NAMES[c] ?? c).join(' ')} `));
}

const TENS_PATTERN = TENS.filter(Boolean).join('|');
const UNITS_PATTERN = 'one|two|three|four|five|six|seven|eight|nine|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth';
const COMPOUND = new RegExp(`\\b(${TENS_PATTERN}) (${UNITS_PATTERN})\\b`, 'gi');

/**
 * The line for a voice to read, the figures written out the way a person would say them. Left to read figures alone,
 * ElevenLabs's fast models turn "Mon, Nov 2" into "Mon Nov 2" and "4,000 sq ft" into "skew fit" (and the server's own
 * expansion is documented as Enterprise-only for them), so what reaches the model is already words: "thirty-five
 * thousand dollars", "Monday, November second", "two thirty PM". Capitals stay as they are: the voice says "PDF" and
 * "OK" better than "P D F".
 */
export function speakableText(text: string): string {
  return tidied(writtenOut(text))
    .replace(/\b([ap]) m\b/g, (_, half: string) => `${half.toUpperCase()}M`)
    .replace(COMPOUND, '$1-$2');
}

/** Words the rules below get wrong, by their spoken syllables. */
const KNOWN: Record<string, number> = {
  every: 2, everyone: 3, everybody: 4, everything: 3, everywhere: 3, evening: 2, business: 2, businesses: 3,
  someone: 2, something: 2, sometimes: 2, somewhere: 2, somebody: 3, anyone: 3, maybe: 2,
  wednesday: 2, wednesdays: 2, hundred: 2, hundreds: 2, million: 2, millions: 2, billion: 2, billions: 2, trillion: 2,
  area: 3, areas: 3, idea: 3, ideas: 3, create: 2, created: 3, react: 2, element: 3, elements: 3,
  client: 2, clients: 2, quiet: 2, science: 2, poem: 2, poet: 2,
  timeline: 2, timelines: 2, baseline: 2, baselines: 2, milestone: 2, milestones: 2, lifetime: 2,
  nineteen: 2, nineteenth: 2, ninety: 2, ninetieth: 3, twentieth: 3, thirtieth: 3, fortieth: 3, fiftieth: 3, sixtieth: 3, seventieth: 4, eightieth: 3,
};

/** Endings counted on their own, so the stem keeps its silent e: "payment", "completely", "going". */
const SUFFIXES: Array<[string, number]> = [
  ['ings', 1],
  ['ing', 1],
  ['ments', 1],
  ['ment', 1],
  ['fully', 2],
  ['ful', 1],
  ['ly', 1],
  ['ness', 1],
  ['less', 1],
];

const PLAIN_VOWELS = 'aeiou';
const plainVowel = (c: string | undefined) => c !== undefined && PLAIN_VOWELS.includes(c);

/** y is a consonant at the start of a word ("you") and between vowels ("payout"), a vowel elsewhere ("any", "day"). */
function isVowel(word: string, i: number): boolean {
  const c = word[i];
  if (plainVowel(c)) return true;
  if (c !== 'y' || i === 0) return false;
  return !(plainVowel(word[i - 1]) && plainVowel(word[i + 1]));
}

/** Two vowels that are said apart: "radio", "actual", "video", "premium", "earlier", "client". */
function splitsInGroup(group: string, before: string, after: string): number {
  const pair = group.slice(0, 2);
  if ((pair === 'ia' || pair === 'io') && !'ctsxghln'.includes(before)) return 1;
  if (pair === 'iu') return 1;
  if ((pair === 'ua' || pair === 'uo') && !'qg'.includes(before)) return 1;
  if (pair === 'eo' && !'gp'.includes(before)) return 1;
  if (group === 'ie' && (after === 'r' || after === 'st' || after.startsWith('n')) && !'ctsxg'.includes(before)) return 1;
  return 0;
}

function vowelGroups(word: string): number {
  let count = 0;
  for (let i = 0; i < word.length; ) {
    if (!isVowel(word, i)) {
      i++;
      continue;
    }
    const start = i;
    while (i < word.length && isVowel(word, i)) i++;
    const rest = word.slice(i);
    count += 1 + splitsInGroup(word.slice(start, i), word[start - 1] ?? '', rest === 'r' || rest === 'st' ? rest : rest.slice(0, 1));
  }
  return count;
}

/** A consonant other than l before "le", "les", "led": a syllable of its own ("table", "titles", "settled"). */
const syllabicL = (word: string, at: number) => at >= 0 && !isVowel(word, at) && word[at] !== 'l';

function baseSyllables(word: string): number {
  let count = vowelGroups(word);
  const n = word.length;
  const consonantAt = (i: number) => i >= 0 && !isVowel(word, i);
  if (count > 1 && word.endsWith('e') && consonantAt(n - 2) && !(word[n - 2] === 'l' && syllabicL(word, n - 3))) count--;
  else if (count > 1 && word.endsWith('es') && consonantAt(n - 3) && !'sxzcg'.includes(word[n - 3] ?? '') && !/[cs]hes$/.test(word) && !(word[n - 3] === 'l' && syllabicL(word, n - 4))) count--;
  else if (count > 1 && word.endsWith('ed') && consonantAt(n - 3) && !'td'.includes(word[n - 3] ?? '') && !(word[n - 3] === 'l' && syllabicL(word, n - 4))) count--;
  return Math.max(1, count);
}

const hasVowel = (word: string) => [...word].some((_, i) => isVowel(word, i));

function plainWordSyllables(word: string): number {
  const known = KNOWN[word];
  if (known) return known;
  for (const [suffix, syllables] of SUFFIXES) {
    if (word.length > suffix.length + 1 && word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (hasVowel(stem)) return plainWordSyllables(stem) + syllables;
    }
  }
  return baseSyllables(word);
}

/** One word's syllables: "fixtures" 2, "didn't" 2, "I've" 1, "Chris's" 2. */
export function wordSyllables(word: string): number {
  const lower = word.toLowerCase().replace(/[‘’]/g, "'");
  // "n't" after a consonant is a syllable of its own (didn't, isn't), and so is "'s" after a hiss (Chris's).
  const extra = (/[^aeiouy']n't$/.test(lower) ? 1 : 0) + (/(s|x|z|ch|sh)'s$/.test(lower) ? 1 : 0);
  const letters = lower.replace(/[^a-z]/g, '');
  return letters ? plainWordSyllables(letters) + extra : 0;
}

/** The words of a line as said aloud. */
export function spokenWords(text: string): string[] {
  return spokenText(text)
    .split(/[^A-Za-z']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** About how many syllables the line has, said aloud. */
export function spokenSyllables(text: string): number {
  return spokenWords(text).reduce((n, word) => n + wordSyllables(word), 0);
}
