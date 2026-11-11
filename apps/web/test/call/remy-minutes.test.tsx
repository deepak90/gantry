/**
 * Remy's minutes on the hosted site, as the header shows them (call/RemyMinutes.tsx through CallLayer): an orb and
 * what's left beside the call button, counting down while someone's call with her is going; once they're used up, by
 * the room route's word or the token route's refusal, "No Remy minutes left" in the button's place. And the orb on the
 * call bar's clock.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/hosted', () => ({ HOSTED: true, FILM_URL: '/#film', readHostedConfig: () => ({ turnstileSiteKey: null, livekitUrl: null }) }));

import CallLayer from '../../src/call/CallLayer';
import { CallClock } from '../../src/call/CallStrip';
import { RemyOrb } from '../../src/call/RemyMinutes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = '00000000-0000-4000-8000-000000000002';
const SESSION = '0f8e5c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The call layer on a page whose room route answers `room` (or what `room` makes of now) and token route `token`. */
async function mount(room: unknown | (() => unknown), token: [number, unknown] = [200, { url: 'wss://lk.example', token: 't', remy: 'on-create' }]) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url);
      return url.startsWith('/api/call/room') ? reply(200, typeof room === 'function' ? room() : room) : reply(token[0], token[1]);
    }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<CallLayer projectId={PROJECT} sessionId={SESSION} name="Deepak Jayaram" color="#2563eb" role="cm" sim={false} assistant={null} accessToken={async () => 'jwt'} />),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { asked };
}

const chip = () => document.querySelector<HTMLElement>('[data-testid="remy-minutes"]');
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="call-start"]');

describe('Remy’s minutes in the header', () => {
  it('shows what’s left beside the call button, as an orb filled to it', async () => {
    await mount({ up: true, people: [], remy: false, minutes: { totalMs: 300_000, leftMs: 252_000, going: false } });
    await vi.waitFor(() => expect(chip()).not.toBeNull());
    expect(chip()!.textContent).toBe('4:12 left');
    expect(chip()!.getAttribute('aria-label')).toBe("4 minutes 12 seconds of Remy's time left for this session");
    expect(chip()!.title).toMatch(/^Remy minutes for this session: 4:12 of 5:00 left\. Everyone on this session shares them\./);
    expect(chip()!.querySelector('.remy-orb')!.getAttribute('data-fullness')).toBe('0.840');
    expect(chip()!.querySelector('.remy-orb')!.classList.contains('is-draining')).toBe(false);
    expect(button()!.textContent).toContain('Call Remy');
  });

  it('counts down while someone’s call with her is going, and offers to join it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    // The site's answer runs down too, as the call goes on.
    const end = Date.now() + 120_000;
    await mount(() => ({ up: true, people: ['Chris Hale'], remy: true, minutes: { totalMs: 300_000, leftMs: Math.max(0, end - Date.now()), going: true } }));
    await vi.waitFor(() => expect(chip()?.textContent).toBe('2:00 left'));
    expect(chip()!.querySelector('.remy-orb')!.classList.contains('is-draining')).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(chip()!.textContent).toBe('1:30 left');
    expect(button()!.textContent).toContain('Join');
  });

  it('puts the call button away once they’re used up, and says so', async () => {
    await mount({ up: true, people: [], remy: false, minutes: { totalMs: 300_000, leftMs: 4_000, going: false } });
    await vi.waitFor(() => expect(chip()?.getAttribute('data-spent')).toBe('true'));
    expect(chip()!.textContent).toBe('No Remy minutes left');
    expect(chip()!.title).toBe("This session's 5 minutes with Remy on calls are used up. She's still in the chat, and the rest of the plan works as usual.");
    expect(chip()!.querySelector('.remy-orb')!.classList.contains('is-empty')).toBe(true);
    // No call button, ever: it waits for the site's first word on the room, and that said they're used up.
    expect(button()).toBeNull();
    expect(document.querySelector('[data-testid="call-held"]')).toBeNull();
  });

  it('does the same when the site refuses a call because they’re used up', async () => {
    const { asked } = await mount({ up: true, people: [], remy: false }, [403, { error: "This session's minutes with Remy are used up. The rest of the app still works.", code: 'minutes_spent' }]);
    expect(chip()).toBeNull();
    await act(async () => button()!.click());
    await vi.waitFor(() => expect(chip()?.textContent).toBe('No Remy minutes left'));
    expect(button()).toBeNull();
    expect(asked.filter((url) => url === '/api/call/token')).toHaveLength(1);
  });

  it('shows nothing of them where the site keeps none', async () => {
    await mount({ up: true, people: [], remy: false });
    await vi.waitFor(() => expect(button()).not.toBeNull());
    expect(chip()).toBeNull();
  });
});

describe('the orb', () => {
  const orb = (props: Parameters<typeof RemyOrb>[0]) => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<RemyOrb {...props} />));
    return host.querySelector('svg')!;
  };

  it('fills to what’s left, moves while draining, goes amber at the end, and is an empty rim at nothing', () => {
    expect(orb({ fullness: 0.5, draining: false, ending: false }).getAttribute('class')).toBe('remy-orb');
    act(() => root!.render(<RemyOrb fullness={0.5} draining ending={false} />));
    expect(document.querySelector('svg')!.getAttribute('class')).toBe('remy-orb is-draining');
    act(() => root!.render(<RemyOrb fullness={0.05} draining ending />));
    expect(document.querySelector('svg')!.getAttribute('class')).toBe('remy-orb is-draining is-ending');
    act(() => root!.render(<RemyOrb fullness={0} draining ending />));
    expect(document.querySelector('svg')!.getAttribute('class')).toBe('remy-orb is-empty');
    expect(document.querySelector('.remy-orb-liquid')).toBeNull();
  });

  it('runs down on the call bar’s clock when the call’s time is the session’s minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<CallClock endsAt={1_000_000 + 150_000} totalMs={300_000} />));
    const clock = host.querySelector('[data-testid="call-time"]')!;
    expect(clock.textContent).toBe('2:30 left');
    expect(clock.querySelector('.remy-orb')!.getAttribute('data-fullness')).toBe('0.500');
    act(() => root!.render(<CallClock endsAt={1_000_000 + 150_000} />));
    expect(host.querySelector('.remy-orb')).toBeNull();
  });
});
