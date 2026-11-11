/**
 * Where only a class name fits (a Bryntum menu item, the changelog), `.remy-glyph` in styles/remy.css
 * draws Remy's mark as a picture. The pictures must stay the mark the component draws: the still
 * mark, and the spark alone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { markDrawing, SPARK_PATH } from '../../src/assistant/RemyMark';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/styles/remy.css'), 'utf8');

/** An SVG as a CSS url(): single quotes inside, and the characters a data URI can't hold escaped. */
const asCssUrl = (svg: string) => `url("data:image/svg+xml,${svg.replaceAll('"', "'").replace(/[#%<>]/g, encodeURIComponent)}")`;

describe('the class-only Remy glyph', () => {
  it('draws the mark as RemyMark draws it', () => {
    expect(css).toContain(asCssUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${markDrawing('m')}</svg>`));
  });

  it('draws the spark alone from SPARK_PATH', () => {
    expect(css).toContain(asCssUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${SPARK_PATH}"/></svg>`));
  });
});
