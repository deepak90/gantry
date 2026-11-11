/** Colors offered for crews: muted mid-tones that carry white text at 5.7:1 or more, never red, orange or pink. */
export const CREW_PALETTE = [
  '#3e6596', '#296b88', '#1f7074', '#2e7065', '#357153', '#4c6e44',
  '#5e6a37', '#6c6433', '#585493', '#695086', '#4e5c6b', '#64594c',
  '#3a497e', '#165c6b', '#245e50', '#415b33', '#65572f', '#504374',
] as const;

/** A color for a new crew: the first one no crew has yet, else the palette again from the start. */
export function freeCrewColor(used: readonly (string | null | undefined)[]): string {
  const taken = new Set(used);
  return CREW_PALETTE.find((color) => !taken.has(color)) ?? CREW_PALETTE[used.length % CREW_PALETTE.length]!;
}
