/**
 * A reply written for the thread, as Remy's voice is handed it: a task link says its name, marks for
 * emphasis go, and days and money are said the way people say them (spoken()). The words stay the reply's.
 */
import { spoken } from '../talk/spoken';

/**
 * A line in parts that each come to at most `max` characters as the voice is handed them (speakable), cut at the ends
 * of sentences, or else between words. Each part is the line's own words, in order, spaces run together: a part of a
 * signed reply is still part of it. A single word longer than `max` stays a part of its own (the worker turns it down).
 */
export function voiceParts(line: string, max: number): string[] {
  const text = line.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (speakable(text).length <= max) return [text];
  const fits = (words: string) => speakable(words).length <= max;
  const parts: string[] = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?…]["'”’)\]]*)\s+/)) {
    const joined = current ? `${current} ${sentence}` : sentence;
    if (fits(joined)) {
      current = joined;
      continue;
    }
    if (current) parts.push(current);
    current = '';
    if (fits(sentence)) {
      current = sentence;
      continue;
    }
    for (const word of sentence.split(' ')) {
      const longer = current ? `${current} ${word}` : word;
      if (!current || fits(longer)) current = longer;
      else {
        parts.push(current);
        current = word;
      }
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function speakable(text: string): string {
  return spoken(
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
