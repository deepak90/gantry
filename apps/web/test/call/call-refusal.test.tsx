/**
 * The call on the hosted site: it asks the site's own routes with the person's access token, and when the server
 * refuses a place on the call the call bar says so in the server's words, then (for want of Remy) that she's still
 * in the chat.
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/hosted', () => ({ HOSTED: true, FILM_URL: '/#film', readHostedConfig: () => ({ turnstileSiteKey: null, livekitUrl: null }) }));

import CallLayer, { UNAVAILABLE_NOW, noticeOf, useRefusalNotice } from '../../src/call/CallLayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = '00000000-0000-4000-8000-000000000002';
const SESSION = '0f8e5c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';
const WORDS = 'Remy is on three calls, the most she takes at once.';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the call on the hosted site', () => {
  let requests: { url: string; init?: RequestInit }[];

  beforeEach(() => {
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return url.startsWith('/api/call/room') ? reply(200, { up: true, people: [], remy: false }) : reply(409, { error: WORDS });
      }),
    );
  });

  it('asks the site’s routes with the access token, and says on the call bar that Remy is unavailable right now, and why', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(<CallLayer projectId={PROJECT} sessionId={SESSION} name="Deepak Jayaram" color="#2563eb" role="cm" sim={false} assistant={null} accessToken={async () => 'jwt-abc'} />),
    );
    expect(requests[0]).toEqual({ url: `/api/call/room?projectId=${PROJECT}`, init: { headers: { Authorization: 'Bearer jwt-abc' } } });

    const start = document.querySelector<HTMLButtonElement>('[data-testid="call-start"]')!;
    expect(start.textContent).toContain('Call Remy');
    await act(async () => start.click());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="rail-call-notice"] .rail-call-notice-title')?.textContent).toBe(UNAVAILABLE_NOW));
    expect(document.querySelector('[data-testid="rail-call-notice"] .rail-call-notice-detail')?.textContent).toMatch(/as many calls as she can take/);
    // And the button holds, saying the same, instead of inviting another try.
    expect(document.querySelector('[data-testid="call-held"]')?.textContent).toContain('Remy is unavailable');

    const ask = requests.find((request) => request.url === '/api/call/token')!;
    expect(ask.init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer jwt-abc' });
    expect(JSON.parse(String(ask.init?.body))).toMatchObject({ projectId: PROJECT, sessionId: SESSION, remy: true });
    expect(document.querySelector('[data-testid="call-strip"]')?.getAttribute('data-status')).toBe('failed');
  });
});

describe('useRefusalNotice', () => {
  function Notice({ refusal }: { refusal: { message: string; status: number; code?: string | null; n: number } | null }) {
    const notice = useRefusalNotice(refusal);
    return <p data-testid="notice">{notice ? `${notice.title}|${notice.detail ?? ''}` : ''}</p>;
  }

  function mountNotice() {
    let refuse: (status: number, code?: string | null) => void = () => undefined;
    function Harness() {
      const [refusal, setRefusal] = useState<{ message: string; status: number; code?: string | null; n: number } | null>(null);
      refuse = (status, code = null) => setRefusal((last) => ({ message: WORDS, status, code, n: (last?.n ?? 0) + 1 }));
      return <Notice refusal={refusal} />;
    }
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
    const text = () => document.querySelector('[data-testid="notice"]')!.textContent;
    return { refuse: (status: number, code?: string | null) => act(() => refuse(status, code)), text };
  }

  it('says Remy is unavailable right now, with why, when the server can’t bring her in, then nothing', () => {
    vi.useFakeTimers();
    const notice = mountNotice();
    expect(notice.text()).toBe('');
    notice.refuse(403, 'allowance_spent');
    expect(notice.text()).toBe(`${UNAVAILABLE_NOW}|This session's calls with Remy are used up. She's still in the chat, and the rest of the plan works as usual.`);
    expect(UNAVAILABLE_NOW).toBe('Remy is unavailable right now');
    act(() => vi.advanceTimersByTime(8_000));
    expect(notice.text()).toBe('');
  });

  it('reads a bare 409 as Remy being busy', () => {
    expect(noticeOf({ message: WORDS, status: 409 })).toEqual({ title: UNAVAILABLE_NOW, detail: expect.stringMatching(/as many calls as she can take/) });
  });

  it('gives the server’s own words for a refusal that isn’t about Remy', () => {
    vi.useFakeTimers();
    const notice = mountNotice();
    notice.refuse(403);
    expect(notice.text()).toBe(`The call couldn't start|${WORDS}`);
    act(() => vi.advanceTimersByTime(8_000));
    expect(notice.text()).toBe('');
  });
});
