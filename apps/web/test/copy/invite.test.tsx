/**
 * The ways into someone's session: the invite link (`/app?join=<token>`), the 6-digit session code (typed with spaces
 * or a dash, or sent by the landing page as `/app?code=482917`), and a teammate in a new tab
 * (`/app?join=<token>&as=teammate`); and the invite card that offers all three, each copied with a button.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeLine, InviteButton } from '../../src/copy/InviteButton';
import {
  formatSessionCode,
  inviteLink,
  joinTokenOf,
  parseSessionCode,
  sessionCodeOf,
  teammateLink,
  typedSessionCode,
  withoutJoin,
  withoutParams,
} from '../../src/copy/invite';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the invite link', () => {
  it('is /app?join=<token> on this site', () => {
    expect(inviteLink('tok_123-abc', 'https://gantry.example')).toBe('https://gantry.example/app?join=tok_123-abc');
  });

  it('reads the token from the address, and nothing that isn’t one', () => {
    expect(joinTokenOf('?join=tok_123-abc')).toBe('tok_123-abc');
    expect(joinTokenOf('?join=0f8e5c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b&x=1')).toBe('0f8e5c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b');
    expect(joinTokenOf('')).toBeNull();
    expect(joinTokenOf('?join=')).toBeNull();
    expect(joinTokenOf('?join=%3Cscript%3E')).toBeNull();
  });

  it('comes out of the address once used, leaving the rest', () => {
    expect(withoutJoin('https://gantry.example/app?join=abcd1234&fx=off#top')).toBe('/app?fx=off#top');
    expect(withoutJoin('https://gantry.example/app?join=abcd1234')).toBe('/app');
    expect(withoutParams('https://gantry.example/app?join=abcd1234&code=482917&fx=off', ['join', 'code'])).toBe('/app?fx=off');
  });

  it('opens a teammate in a new tab with as=teammate', () => {
    expect(teammateLink('tok_123-abc', 'https://gantry.example')).toBe('https://gantry.example/app?join=tok_123-abc&as=teammate');
  });
});

describe('the session code', () => {
  it('is six digits, typed with or without a space or a dash', () => {
    expect(parseSessionCode('482917')).toBe('482917');
    expect(parseSessionCode('482 917')).toBe('482917');
    expect(parseSessionCode(' 482-917 ')).toBe('482917');
    expect(parseSessionCode('48291')).toBeNull();
    expect(parseSessionCode('4829170')).toBeNull();
    expect(parseSessionCode('482x917')).toBeNull();
    expect(parseSessionCode('')).toBeNull();
    expect(parseSessionCode(null)).toBeNull();
  });

  it('is read the way people say it, "482 917"', () => {
    expect(formatSessionCode('482917')).toBe('482 917');
    expect(formatSessionCode('48291')).toBe('48291');
  });

  it('shows what was typed so far the same way: digits only, at most six', () => {
    expect(typedSessionCode('48')).toBe('48');
    expect(typedSessionCode('4829')).toBe('482 9');
    expect(typedSessionCode('482-917')).toBe('482 917');
    expect(typedSessionCode('482 9170')).toBe('482 917');
    expect(typedSessionCode('a4b8c2')).toBe('482');
  });

  it('comes from the landing page as /app?code=482917', () => {
    expect(sessionCodeOf('?code=482917')).toBe('482917');
    expect(sessionCodeOf('?code=482+917')).toBe('482917');
    expect(sessionCodeOf('?code=482%20917')).toBe('482917');
    expect(sessionCodeOf('?code=48291')).toBeNull();
    expect(sessionCodeOf('?code=%3Cscript%3E')).toBeNull();
    expect(sessionCodeOf('')).toBeNull();
  });
});

describe('InviteButton', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
      root = undefined;
    }
    container?.remove();
    vi.unstubAllGlobals();
  });

  async function mount(code: string | null = '482917') {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const mounted = root;
    await act(async () => mounted.render(<InviteButton token="tok_123-abc" code={code} origin="https://gantry.example" />));
    const open = container.querySelector<HTMLButtonElement>('[data-testid="invite-open"]')!;
    await act(async () => open.click());
    return container;
  }

  it('opens the session code, the link and a teammate in a new tab, and no QR code', async () => {
    const shown = await mount();
    expect(shown.querySelector('[data-testid="invite-code"]')!.textContent).toBe('482 917');
    expect(shown.querySelector('[data-testid="invite-card"]')!.textContent).toContain('They open gantry.example and choose Join with a code.');
    expect(shown.querySelector<HTMLInputElement>('[data-testid="invite-link"]')!.value).toBe('https://gantry.example/app?join=tok_123-abc');
    const teammate = shown.querySelector<HTMLAnchorElement>('[data-testid="invite-teammate"]')!;
    expect(teammate.getAttribute('href')).toBe('https://gantry.example/app?join=tok_123-abc&as=teammate');
    expect(teammate.target).toBe('_blank');
    expect(teammate.rel).toBe('noopener');
    expect(shown.querySelector('svg')).toBeNull();
  });

  it('says where the code goes, on this site', () => {
    expect(codeLine('https://gantry-pearl.vercel.app')).toBe('They open gantry-pearl.vercel.app and choose Join with a code.');
  });

  it('copies the code, as digits, and the link with their buttons', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const shown = await mount();
    const copyCode = shown.querySelector<HTMLButtonElement>('[data-testid="invite-copy-code"]')!;
    await act(async () => copyCode.click());
    expect(writeText).toHaveBeenLastCalledWith('482917');
    expect(copyCode.textContent).toContain('Copied');
    const copyLink = shown.querySelector<HTMLButtonElement>('[data-testid="invite-copy"]')!;
    await act(async () => copyLink.click());
    expect(writeText).toHaveBeenLastCalledWith('https://gantry.example/app?join=tok_123-abc');
    expect(copyLink.textContent).toContain('Copied');
  });

  it('selects the link for copying by hand when the clipboard says no', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async () => Promise.reject(new Error('denied')) } });
    const shown = await mount();
    await act(async () => shown.querySelector<HTMLButtonElement>('[data-testid="invite-copy"]')!.click());
    expect(document.activeElement).toBe(shown.querySelector('[data-testid="invite-link"]'));
  });

  it('offers the link alone while this browser doesn’t know the code', async () => {
    const shown = await mount(null);
    expect(shown.querySelector('[data-testid="invite-code"]')).toBeNull();
    expect(shown.querySelector('[data-testid="invite-link"]')).not.toBeNull();
  });
});
