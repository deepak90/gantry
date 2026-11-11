/**
 * The screens before a session: "Start a session" waits for Cloudflare Turnstile's check (rendered explicitly) and
 * hands its token on with the name picked; the name is one nobody in the session has, and "Another name" goes through
 * the others; a code is typed as people read it out and sent once it has six digits; a sign-in needs no check; every
 * session in use is a calm screen with the film; a reset session offers a new one; a network that must wait sees why
 * and a countdown, and only then a button.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEAT_NAMES } from '../../src/copy/names';
import { BusyScreen, RefusedScreen, ResetScreen, WaitScreen, waitText, WelcomeScreen, type WelcomeScreenProps } from '../../src/copy/screens';
import type { TurnstileApi, TurnstileRenderOptions } from '../../src/copy/turnstile';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  delete (window as { turnstile?: unknown }).turnstile;
});

/** Cloudflare's script, already loaded: what it was asked to render, and a way to pass its check. */
function fakeTurnstile() {
  const rendered: { container: HTMLElement; options: TurnstileRenderOptions }[] = [];
  const api: TurnstileApi = {
    render: vi.fn((container: HTMLElement, options: TurnstileRenderOptions) => {
      rendered.push({ container, options });
      return 'widget-1';
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  (window as { turnstile?: TurnstileApi }).turnstile = api;
  return { api, rendered, pass: (token: string) => act(() => rendered[0]!.options.callback?.(token)) };
}

async function mount(element: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
  return host;
}

/** No shuffle: the names come in the list's order. */
const inOrder = () => 0.999999;

function welcome(props: Partial<WelcomeScreenProps> = {}) {
  return (
    <WelcomeScreen
      mode="claim"
      signedIn={false}
      error={null}
      siteKey="key"
      onGo={() => undefined}
      onChooseOwn={() => undefined}
      onChooseCode={() => undefined}
      random={inOrder}
      {...props}
    />
  );
}

const go = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-testid="copy-go"]')!;
const nameShown = (host: HTMLElement) => host.querySelector('[data-testid="copy-name"]')?.textContent;

/** Types into a controlled input, as a person would. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('WelcomeScreen', () => {
  it('waits for the human check, then hands its token and the name to "Start a session"', async () => {
    const turnstile = fakeTurnstile();
    const onGo = vi.fn();
    const host = await mount(welcome({ siteKey: '1x00000000000000000000AA', onGo }));
    expect(turnstile.rendered[0]!.options).toMatchObject({ sitekey: '1x00000000000000000000AA', action: 'get_copy' });
    expect(turnstile.rendered[0]!.container.dataset.testid).toBe('turnstile');
    expect(host.querySelector('h1')?.textContent).toBe('Start a session');
    expect(go(host).textContent).toBe('Start a session');
    expect(host.querySelector('[data-testid="copy-who"]')?.textContent).toContain('You’ll join as Riley Brooks, construction manager.');
    expect(go(host).disabled).toBe(true);

    turnstile.pass('token-1');
    expect(go(host).disabled).toBe(false);
    act(() => go(host).click());
    expect(onGo).toHaveBeenCalledWith('token-1', 'Riley Brooks', null);
  });

  it('goes through other names on request, and sends the one shown', async () => {
    const onGo = vi.fn();
    const host = await mount(welcome({ signedIn: true, onGo }));
    const another = host.querySelector<HTMLButtonElement>('[data-testid="copy-other-name"]')!;
    act(() => another.click());
    expect(nameShown(host)).toBe('Jordan Ellis');
    act(() => another.click());
    expect(nameShown(host)).toBe('Avery Patel');
    act(() => go(host).click());
    expect(onGo).toHaveBeenCalledWith(null, 'Avery Patel', null);
  });

  it('suggests only names nobody in the session has, as a project manager', async () => {
    const taken = SEAT_NAMES.slice(0, 28);
    const host = await mount(welcome({ mode: 'join', taken }));
    expect(host.querySelector('h1')?.textContent).toBe('Join a session');
    expect(host.querySelector('[data-testid="copy-who"]')?.textContent).toContain(`You’ll join as ${SEAT_NAMES[28]}, project manager.`);
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="copy-other-name"]')!.click());
    expect(nameShown(host)).toBe(SEAT_NAMES[29]);
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="copy-other-name"]')!.click());
    expect(nameShown(host)).toBe(SEAT_NAMES[28]);
  });

  it('keeps the name picked before when it is still free', async () => {
    const host = await mount(welcome({ name: 'Kai Larsen' }));
    expect(nameShown(host)).toBe('Kai Larsen');
    await act(async () => root!.render(welcome({ name: 'Kai Larsen', taken: ['Kai Larsen'] })));
    expect(nameShown(host)).toBe('Riley Brooks');
  });

  it('asks for a fresh check after a failed try, and shows why it failed', async () => {
    const turnstile = fakeTurnstile();
    const host = await mount(welcome());
    turnstile.pass('token-1');
    await act(async () => root!.render(welcome({ error: 'captcha verification process failed' })));
    expect(turnstile.api.reset).toHaveBeenCalledWith('widget-1');
    expect(host.querySelector('[data-testid="copy-error"]')?.textContent).toBe('captcha verification process failed');
    expect(go(host).disabled).toBe(true);
  });

  it('says "Start a new session" after one ended, with the check and the name the person had', async () => {
    const turnstile = fakeTurnstile();
    const onGo = vi.fn();
    const host = await mount(welcome({ again: true, name: 'Kai Larsen', onGo }));
    expect(host.querySelector('h1')?.textContent).toBe('Start a new session');
    expect(go(host).textContent).toBe('Start a new session');
    expect(nameShown(host)).toBe('Kai Larsen');
    expect(go(host).disabled).toBe(true);
    turnstile.pass('token-2');
    act(() => go(host).click());
    expect(onGo).toHaveBeenCalledWith('token-2', 'Kai Larsen', null);
  });

  it('needs no check for someone already signed in', async () => {
    const turnstile = fakeTurnstile();
    const onGo = vi.fn();
    const host = await mount(welcome({ signedIn: true, onGo }));
    expect(turnstile.api.render).not.toHaveBeenCalled();
    act(() => go(host).click());
    expect(onGo).toHaveBeenCalledWith(null, 'Riley Brooks', null);
  });

  it('joins from an invite, or starts a session of their own instead', async () => {
    fakeTurnstile();
    const onChooseOwn = vi.fn();
    const host = await mount(welcome({ mode: 'join', onChooseOwn }));
    expect(go(host).textContent).toBe('Join this session');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="copy-own-instead"]')!.click());
    expect(onChooseOwn).toHaveBeenCalled();
  });

  it('offers joining with a code from "Start a session"', async () => {
    const onChooseCode = vi.fn();
    const host = await mount(welcome({ onChooseCode }));
    const useCode = host.querySelector<HTMLButtonElement>('[data-testid="copy-use-code"]')!;
    expect(useCode.textContent).toBe('Join with a code');
    act(() => useCode.click());
    expect(onChooseCode).toHaveBeenCalled();
  });

  it('takes a code as people read it out, and sends it once it has six digits', async () => {
    const onGo = vi.fn();
    const host = await mount(welcome({ mode: 'code', signedIn: true, onGo }));
    expect(host.querySelector('h1')?.textContent).toBe('Join with a code');
    const field = host.querySelector<HTMLInputElement>('[data-testid="copy-code"]')!;
    expect(document.activeElement).toBe(field);
    expect(field.inputMode).toBe('numeric');
    type(field, '4829');
    expect(field.value).toBe('482 9');
    expect(go(host).disabled).toBe(true);
    type(field, '482-917');
    expect(field.value).toBe('482 917');
    expect(go(host).disabled).toBe(false);
    act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(onGo).toHaveBeenCalledWith(null, 'Riley Brooks', '482 917');
  });

  it('starts with the code from the address, and says beside it why the last one didn’t work', async () => {
    const host = await mount(welcome({ mode: 'code', code: '111111', error: 'That code doesn’t match a session that’s open now.' }));
    expect(host.querySelector<HTMLInputElement>('[data-testid="copy-code"]')!.value).toBe('111 111');
    expect(host.querySelector('[data-testid="copy-error"]')?.textContent).toBe('That code doesn’t match a session that’s open now.');
    expect(host.querySelector('[data-testid="copy-code"]')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('takes the check out when the screen goes', async () => {
    const turnstile = fakeTurnstile();
    await mount(welcome());
    await act(async () => root!.unmount());
    root = null;
    expect(turnstile.api.remove).toHaveBeenCalledWith('widget-1');
  });
});

describe('the other screens', () => {
  it('says calmly that every session is in use, with the film and a way to try again', async () => {
    const onRetry = vi.fn();
    const host = await mount(<BusyScreen onRetry={onRetry} />);
    expect(host.querySelector('h1')?.textContent).toBe('Every session is in use');
    expect(host.textContent).toContain('All sessions are in use right now. Try again in a few minutes.');
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="copy-film"]')!.getAttribute('href')).toBe('/#film');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="copy-retry"]')!.click());
    expect(onRetry).toHaveBeenCalled();
  });

  it('says a session was reset and offers a new one', async () => {
    const onNewCopy = vi.fn();
    const host = await mount(<ResetScreen onNewCopy={onNewCopy} />);
    expect(host.querySelector('h1')?.textContent).toBe('This session was reset');
    const button = host.querySelector<HTMLButtonElement>('[data-testid="copy-new"]')!;
    expect(button.textContent).toBe('Start a new session');
    act(() => button.click());
    expect(onNewCopy).toHaveBeenCalled();
  });

  it('counts down calmly when the network must wait, with nothing to press until it is over', async () => {
    vi.useFakeTimers();
    try {
      let clock = Date.parse('2026-11-11T18:00:00Z');
      const now = () => clock;
      const onDone = vi.fn();
      const host = await mount(<WaitScreen until={clock + 105_000} reason="gap" onDone={onDone} now={now} />);
      expect(host.querySelector('h1')?.textContent).toBe('Start a new session');
      expect(host.textContent).toContain('A session was just started on your network.');
      expect(host.querySelector('[data-testid="copy-countdown"]')?.textContent).toBe('You can start a new session in 1:45');
      expect(host.querySelector('[data-testid="copy-countdown"]')?.getAttribute('role')).toBe('timer');
      expect(host.querySelector('[data-testid="copy-new"]')).toBeNull();
      expect(host.querySelector<HTMLAnchorElement>('[data-testid="copy-film"]')!.getAttribute('href')).toBe('/#film');

      clock += 60_000;
      act(() => vi.advanceTimersByTime(1_000));
      expect(host.querySelector('[data-testid="copy-countdown"]')?.textContent).toBe('You can start a new session in 0:45');
      expect(host.querySelector('[data-testid="copy-new"]')).toBeNull();

      clock += 45_000;
      act(() => vi.advanceTimersByTime(1_000));
      expect(host.querySelector('[data-testid="copy-countdown"]')).toBeNull();
      expect(host.textContent).toContain('You can start a new session now.');
      expect(host.textContent).not.toContain('A session was just started');
      const button = host.querySelector<HTMLButtonElement>('[data-testid="copy-new"]')!;
      expect(button.textContent).toBe('Start a new session');
      act(() => button.click());
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why the network waits, and counts a long wait in hours', async () => {
    const now = () => 0;
    const host = await mount(<WaitScreen until={3 * 3600_000 - 20_000} reason="held" onDone={() => undefined} now={now} />);
    expect(host.textContent).toContain('Your network already has as many sessions open as it can.');
    expect(host.querySelector('[data-testid="copy-countdown"]')?.textContent).toBe('You can start a new session in about 3 hours');
    await act(async () => root!.render(<WaitScreen until={90_000} reason={null} onDone={() => undefined} now={now} />));
    expect(host.textContent).toContain('Each network can start only so many sessions, to keep the demo open for everyone.');
    expect(waitText(59 * 60_000 + 59_000)).toBe('59:59');
    expect(waitText(500)).toBe('0:01');
    expect(waitText(90 * 60_000)).toBe('about 2 hours');
  });

  it('says why an invite link didn’t work, and offers a session of their own', async () => {
    const onOwn = vi.fn();
    const host = await mount(<RefusedScreen message="This session already has 5 people in it." onOwn={onOwn} />);
    expect(host.querySelector('[data-testid="copy-refused-message"]')?.textContent).toBe('This session already has 5 people in it.');
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="copy-new"]')!.click());
    expect(onOwn).toHaveBeenCalled();
  });
});
