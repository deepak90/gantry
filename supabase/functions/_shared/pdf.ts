/**
 * One-page business documents (the payment receipt, the seeded supplier quote) as PDF, laid out
 * from a plain description: a header with reference fields, a heading, an optional notice, two
 * party blocks, then sections of amount tables, labeled fields and paragraphs, and a footer.
 *
 * pdf-lib is passed in rather than imported: the edge runtime loads it as `npm:pdf-lib@<version>`
 * (supabase.ts), Node scripts and Vitest as `pdf-lib`, so this module has no runtime import at all
 * and the same layout serves both. Text uses the PDF standard fonts (Helvetica), whose WinAnsi
 * encoding covers Western European text; any other character is transliterated or replaced, so an
 * unusual supplier or task name can never stop a receipt from being produced.
 */
// Types only (erased by Vitest and Node), spelled as the edge runtime resolves them: Deno builds the
// module graph from type imports too. deno-env.d.ts maps the specifier to `pdf-lib` for tsc.
import type { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'npm:pdf-lib@1.17.1';

/** The part of the pdf-lib module the layout uses. */
export interface PdfLib {
  PDFDocument: typeof PDFDocument;
  StandardFonts: typeof StandardFonts;
  rgb: typeof rgb;
}

export interface LabeledValue {
  label: string;
  value: string;
  /** Right-aligned, muted (a date beside a name). */
  aside?: string;
}

export interface AmountLine {
  label: string;
  /** Muted text after the label ("one-off", "on request"). */
  detail?: string;
  /** Already formatted ('$1,200.00'); drawn right-aligned. */
  amount: string;
  strong?: boolean;
  /** A rule above the line (before a total). */
  ruleAbove?: boolean;
}

export type DocumentSection =
  | { kind: 'amounts'; title: string; lines: AmountLine[]; note?: string }
  | { kind: 'fields'; title: string; fields: LabeledValue[] }
  | { kind: 'text'; title: string; paragraphs: string[] };

export interface DocumentParty {
  label: string;
  /** The first line is drawn in bold. */
  lines: string[];
}

export interface DocumentSpec {
  /** PDF metadata title. */
  title: string;
  /** Small capitals above the heading ('PAYMENT RECEIPT'). */
  eyebrow: string;
  heading: string;
  subheading?: string;
  /** Reference fields at the top right (Receipt no., Date paid). */
  references: LabeledValue[];
  /** A highlighted notice under the heading: a bold first line, then plain lines. */
  notice?: { title: string; text?: string };
  parties: DocumentParty[];
  sections: DocumentSection[];
  footer: string[];
  /** Written to the PDF metadata. */
  author: string;
  createdAt: Date;
}

// Letter, 0.75 in margins.
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const MARGIN_TOP = 54;
const FOOTER_TOP = 70;
const RIGHT = PAGE_WIDTH - MARGIN_X;
const CONTENT_WIDTH = RIGHT - MARGIN_X;

interface Palette {
  ink: ReturnType<typeof rgb>;
  muted: ReturnType<typeof rgb>;
  rule: ReturnType<typeof rgb>;
  noticeFill: ReturnType<typeof rgb>;
  noticeBar: ReturnType<typeof rgb>;
  noticeInk: ReturnType<typeof rgb>;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  /** Code points the standard fonts can encode. */
  charset: ReadonlySet<number>;
}

/** Common punctuation outside WinAnsi, spelled with what it has. */
const SUBSTITUTES: Readonly<Record<string, string>> = {
  '→': '->',
  '←': '<-',
  '≤': '<=',
  '≥': '>=',
  '≠': '!=',
  '−': '-',
  '‐': '-',
  '‑': '-',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
};

/** Text the standard fonts can draw: accents folded where that helps, anything else as '?'. */
export function winAnsiText(text: string, charset: ReadonlySet<number>): string {
  let out = '';
  for (const char of text.replace(/[\r\n\t]+/g, ' ')) {
    const code = char.codePointAt(0) ?? 63;
    if (charset.has(code)) {
      out += char;
      continue;
    }
    const substitute = SUBSTITUTES[char];
    if (substitute !== undefined) {
      out += substitute;
      continue;
    }
    const folded = char.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += [...folded].every((c) => charset.has(c.codePointAt(0) ?? 63)) && folded.length > 0 ? folded : '?';
  }
  return out;
}

/** Splits text into lines no wider than `width`; a word longer than a line is broken. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  const fits = (candidate: string) => font.widthOfTextAtSize(candidate, size) <= width;
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line !== '') {
      lines.push(line);
      line = '';
    }
    let rest = word;
    while (!fits(rest)) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line !== '' || lines.length === 0) {
    lines.push(line);
  }
  return lines;
}

/** Renders the document; returns the PDF bytes. */
export async function renderDocumentPdf(lib: PdfLib, spec: DocumentSpec): Promise<Uint8Array> {
  const doc = await lib.PDFDocument.create({ updateMetadata: false });
  const regular = await doc.embedFont(lib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(lib.StandardFonts.HelveticaBold);
  const fonts: Fonts = { regular, bold, charset: new Set(regular.getCharacterSet()) };
  const colors: Palette = {
    ink: lib.rgb(0.07, 0.09, 0.13),
    muted: lib.rgb(0.42, 0.45, 0.5),
    rule: lib.rgb(0.84, 0.86, 0.89),
    noticeFill: lib.rgb(1, 0.973, 0.902),
    noticeBar: lib.rgb(0.85, 0.55, 0.05),
    noticeInk: lib.rgb(0.45, 0.25, 0),
  };
  const safe = (text: string) => winAnsiText(text, fonts.charset);

  doc.setTitle(safe(spec.title));
  doc.setAuthor(safe(spec.author));
  doc.setCreator(safe(spec.author));
  doc.setProducer('pdf-lib');
  doc.setLanguage('en-US');
  doc.setCreationDate(spec.createdAt);
  doc.setModificationDate(spec.createdAt);

  const pages: PDFPage[] = [];
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  pages.push(page);
  let y = PAGE_HEIGHT - MARGIN_TOP;

  const text = (value: string, x: number, top: number, size: number, font: PDFFont, color = colors.ink) => {
    // `top` is the top of the line box; pdf-lib places text on its baseline.
    page.drawText(safe(value), { x, y: top - size * 0.8, size, font, color });
  };
  const textRight = (value: string, right: number, top: number, size: number, font: PDFFont, color = colors.ink) => {
    const clean = safe(value);
    text(clean, right - font.widthOfTextAtSize(clean, size), top, size, font, color);
  };
  const rule = (top: number, thickness = 0.6, color = colors.rule) => {
    page.drawLine({ start: { x: MARGIN_X, y: top }, end: { x: RIGHT, y: top }, thickness, color });
  };
  /** Starts a continuation page when `height` does not fit above the footer. */
  const ensure = (height: number) => {
    if (y - height >= FOOTER_TOP + 12) {
      return;
    }
    page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    y = PAGE_HEIGHT - MARGIN_TOP;
    text(`${spec.eyebrow} (continued)`, MARGIN_X, y, 8, fonts.bold, colors.muted);
    y -= 24;
  };

  // Header: eyebrow on the left, reference fields on the right ------------------------------
  text(spec.eyebrow, MARGIN_X, y, 8.5, fonts.bold, colors.muted);
  let referencesBottom = y;
  for (const reference of spec.references) {
    textRight(reference.label, RIGHT - 128, referencesBottom, 8, fonts.regular, colors.muted);
    textRight(reference.value, RIGHT, referencesBottom, 8.5, fonts.bold);
    referencesBottom -= 13;
  }
  y = Math.min(y - 22, referencesBottom - 10);

  // Heading -----------------------------------------------------------------------------------
  for (const line of wrapText(safe(spec.heading), fonts.bold, 19, CONTENT_WIDTH)) {
    text(line, MARGIN_X, y, 19, fonts.bold);
    y -= 24;
  }
  if (spec.subheading) {
    for (const line of wrapText(safe(spec.subheading), fonts.regular, 10.5, CONTENT_WIDTH)) {
      text(line, MARGIN_X, y, 10.5, fonts.regular, colors.muted);
      y -= 14;
    }
  }
  y -= 10;

  // Notice --------------------------------------------------------------------------------------
  if (spec.notice) {
    const inner = CONTENT_WIDTH - 24;
    const body = spec.notice.text ? wrapText(safe(spec.notice.text), fonts.regular, 8.5, inner) : [];
    const height = 12 + 12 + body.length * 11 + 8;
    page.drawRectangle({ x: MARGIN_X, y: y - height, width: CONTENT_WIDTH, height, color: colors.noticeFill });
    page.drawRectangle({ x: MARGIN_X, y: y - height, width: 3, height, color: colors.noticeBar });
    let top = y - 10;
    text(spec.notice.title, MARGIN_X + 14, top, 9.5, fonts.bold, colors.noticeInk);
    top -= 13;
    for (const line of body) {
      text(line, MARGIN_X + 14, top, 8.5, fonts.regular, colors.noticeInk);
      top -= 11;
    }
    y -= height + 16;
  }

  // Parties, side by side -------------------------------------------------------------------------
  if (spec.parties.length > 0) {
    const gap = 24;
    const width = (CONTENT_WIDTH - gap * (spec.parties.length - 1)) / spec.parties.length;
    let lowest = y;
    spec.parties.forEach((party, index) => {
      const x = MARGIN_X + index * (width + gap);
      let top = y;
      text(party.label.toUpperCase(), x, top, 7.5, fonts.bold, colors.muted);
      top -= 13;
      party.lines.forEach((value, lineIndex) => {
        const font = lineIndex === 0 ? fonts.bold : fonts.regular;
        const size = lineIndex === 0 ? 10.5 : 9;
        for (const line of wrapText(safe(value), font, size, width)) {
          text(line, x, top, size, font, lineIndex === 0 ? colors.ink : colors.muted);
          top -= lineIndex === 0 ? 14 : 12;
        }
      });
      lowest = Math.min(lowest, top);
    });
    y = lowest - 12;
  }

  // Sections ----------------------------------------------------------------------------------------
  for (const section of spec.sections) {
    ensure(46);
    text(section.title.toUpperCase(), MARGIN_X, y, 7.5, fonts.bold, colors.muted);
    y -= 12;
    rule(y, 0.8, colors.ink);
    y -= 8;

    if (section.kind === 'amounts') {
      for (const line of section.lines) {
        ensure(18);
        if (line.ruleAbove) {
          rule(y + 1, 0.6, colors.ink);
          y -= 5;
        }
        const font = line.strong ? fonts.bold : fonts.regular;
        const amountWidth = font.widthOfTextAtSize(safe(line.amount), 10);
        const label = wrapText(safe(line.label), font, 10, CONTENT_WIDTH - amountWidth - 140)[0] ?? '';
        text(label, MARGIN_X, y, 10, font);
        if (line.detail) {
          const labelWidth = font.widthOfTextAtSize(label, 10);
          const room = CONTENT_WIDTH - amountWidth - labelWidth - 24;
          const detail = wrapText(safe(line.detail), fonts.regular, 8.5, Math.max(room, 40))[0] ?? '';
          // Same baseline as the 10 pt label.
          text(detail, MARGIN_X + labelWidth + 8, y - 1.2, 8.5, fonts.regular, colors.muted);
        }
        textRight(line.amount, RIGHT, y, 10, font);
        y -= 16;
      }
      if (section.note) {
        for (const line of wrapText(safe(section.note), fonts.regular, 8, CONTENT_WIDTH)) {
          text(line, MARGIN_X, y, 8, fonts.regular, colors.muted);
          y -= 11;
        }
      }
    } else if (section.kind === 'fields') {
      const labelWidth = 128;
      for (const field of section.fields) {
        const asideWidth = field.aside ? fonts.regular.widthOfTextAtSize(safe(field.aside), 8.5) + 16 : 0;
        const lines = wrapText(safe(field.value), fonts.regular, 9.5, CONTENT_WIDTH - labelWidth - asideWidth);
        ensure(lines.length * 12.5 + 4);
        // Label and aside share the first value line's baseline.
        text(field.label, MARGIN_X, y - 0.8, 8.5, fonts.regular, colors.muted);
        if (field.aside) {
          textRight(field.aside, RIGHT, y - 0.8, 8.5, fonts.regular, colors.muted);
        }
        for (const line of lines) {
          text(line, MARGIN_X + labelWidth, y, 9.5, fonts.regular);
          y -= 12.5;
        }
        y -= 2.5;
      }
    } else {
      for (const paragraph of section.paragraphs) {
        const lines = wrapText(safe(paragraph), fonts.regular, 9.5, CONTENT_WIDTH);
        ensure(lines.length * 12.5);
        for (const line of lines) {
          text(line, MARGIN_X, y, 9.5, fonts.regular);
          y -= 12.5;
        }
        y -= 4;
      }
    }
    y -= 14;
  }

  // Footer on every page --------------------------------------------------------------------------------
  pages.forEach((footerPage, index) => {
    page = footerPage;
    rule(FOOTER_TOP);
    let top = FOOTER_TOP - 8;
    for (const value of spec.footer) {
      for (const line of wrapText(safe(value), fonts.regular, 7.5, CONTENT_WIDTH - 70)) {
        text(line, MARGIN_X, top, 7.5, fonts.regular, colors.muted);
        top -= 10;
      }
    }
    textRight(`Page ${index + 1} of ${pages.length}`, RIGHT, FOOTER_TOP - 8, 7.5, fonts.regular, colors.muted);
  });

  return doc.save({ useObjectStreams: false });
}
