/**
 * A reply written for the thread, as Remy's voice is given it: a task link says its name, marks for emphasis go, and
 * days and money are written the way people say them. The same as the page's `speakable()` (apps/web/src/call/speech.ts
 * and apps/web/src/talk/spoken.ts), here because the worker builds from its own folder alone: a signed line arrives as
 * the reply's own words (line-proof.ts), and is written for her voice here.
 */

const WEEKDAYS: Readonly<Record<string, string>> = {
  Mon: 'Monday',
  Tue: 'Tuesday',
  Tues: 'Tuesday',
  Wed: 'Wednesday',
  Thu: 'Thursday',
  Thur: 'Thursday',
  Thurs: 'Thursday',
  Fri: 'Friday',
  Sat: 'Saturday',
  Sun: 'Sunday',
};

const MONTHS: Readonly<Record<string, string>> = {
  Jan: 'January',
  Feb: 'February',
  Mar: 'March',
  Apr: 'April',
  Jun: 'June',
  Jul: 'July',
  Aug: 'August',
  Sep: 'September',
  Sept: 'September',
  Oct: 'October',
  Nov: 'November',
  Dec: 'December',
};

const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)';

/** Days in full words, whole dollars without cents, a range as "to", and no separators to read out. */
export function spokenDates(text: string): string {
  return (
    text
      // A short weekday before a month and day: "Mon, Nov 2" is "Monday, Nov 2" (the month follows).
      .replace(new RegExp(`\\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\\.?,?\\s+(?=${MONTH}\\.?\\s+\\d)`, 'g'), (_, day: string) => `${WEEKDAYS[day] ?? day}, `)
      // A short month before a day: "Nov 2" is "November 2".
      .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?(?=\s+\d{1,2}\b)/g, (month: string) => MONTHS[month.replace('.', '')] ?? month)
      // A day and then a time ("November 2 2:12 PM") would run together: "November 2, at 2:12 PM".
      .replace(new RegExp(`\\b(${MONTH}\\s+\\d{1,2}),?\\s+(?=\\d{1,2}:\\d{2})`, 'g'), '$1, at ')
      // Whole dollars: "$8,400.00" is "$8,400".
      .replace(/(\$\s?\d[\d,]*)\.00\b/g, '$1')
      // A range between days, amounts or numbers: "January 31–February 13" is "January 31 to February 13".
      .replace(new RegExp(`(\\d)\\s*[–—]\\s*(?=\\$|\\d|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|${MONTH})\\b)`, 'g'), '$1 to ')
      // Separators a voice reads out ("dot", "bullet").
      .replace(/\s*[·•]\s*/g, ', ')
  );
}

/** The line Remy's voice is given for a reply's words. */
export function voiceLine(text: string): string {
  return spokenDates(
    text
      // "[Crane erection](task:3104)" is "Crane erection".
      .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1')
      // "**two days**", "_two_", "`two`" are "two days", "two", "two".
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?;:]|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}
