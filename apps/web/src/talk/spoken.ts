/**
 * Text written for the screen, as the voice should say it. The app writes days and money for reading
 * ("Mon, Nov 2", "$8,400.00", "12 days · $7,200.00"), and a voice reads what it is given: "Mon, nov 2",
 * "eight thousand four hundred dot zero zero", "dot". What the voice is handed says days in full words,
 * money in whole dollars when there are no cents, a range as "to", and no separators to read out. The
 * numbers, days and names stay the same; the call's own record keeps the text as it was written.
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

export function spoken(text: string): string {
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
