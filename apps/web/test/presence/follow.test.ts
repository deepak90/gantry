import { describe, expect, it } from 'vitest';
import { FollowController, ViewBroadcaster } from '../../src/presence/follow';
import type { ViewBody, ViewFrame } from '../../src/presence/protocol';
import { FakeClock, FakeViewport, VIEW, peer } from './helpers';

const frame = (seq: number, overrides: Partial<ViewFrame> = {}): ViewFrame => ({ ...VIEW, session: 'lead', seq, revision: 0, ...overrides });

function controller() {
  const requests: string[] = [];
  let changes = 0;
  const follow = new FollowController({ request: (target) => requests.push(target), onChange: () => changes++ });
  const viewport = new FakeViewport(null);
  follow.attach(viewport);
  return { follow, viewport, requests, changes: () => changes };
}

describe('FollowController', () => {
  it('asks for the view when it starts and applies the followed person’s frames in order', () => {
    const { follow, viewport, requests } = controller();
    follow.follow('lead');
    expect(requests).toEqual(['lead']);
    expect(follow.state).toEqual({ mode: 'following', target: 'lead', waiting: true });

    expect(follow.receive(frame(0, { center: '2026-12-01T00:00:00' }))).toBe(true);
    expect(follow.state).toEqual({ mode: 'following', target: 'lead', waiting: false });
    // Older or repeated frames (reordered or duplicated in transit) are dropped.
    expect(follow.receive(frame(2, { center: '2026-12-03T00:00:00' }))).toBe(true);
    expect(follow.receive(frame(1, { center: '2026-12-02T00:00:00' }))).toBe(false);
    expect(follow.receive(frame(2, { center: '2026-12-03T00:00:00' }))).toBe(false);
    expect(viewport.applied.map((view) => view.center)).toEqual(['2026-12-01T00:00:00', '2026-12-03T00:00:00']);
    expect(follow.applied).toBe(2);
  });

  it('ignores frames from anybody else and frames while not following', () => {
    const { follow, viewport } = controller();
    expect(follow.receive(frame(0))).toBe(false);
    follow.follow('lead');
    expect(follow.receive(frame(0, { session: 'someone-else' }))).toBe(false);
    expect(viewport.applied).toHaveLength(0);
  });

  it('holds a frame back until this plan has the revision it was taken at', () => {
    const { follow, viewport } = controller();
    follow.follow('lead');
    follow.revisionChanged(4);
    expect(follow.receive(frame(0, { revision: 6, center: '2026-12-06T00:00:00' }))).toBe(false);
    // A newer frame replaces the held one; only the newest is applied once caught up.
    follow.receive(frame(1, { revision: 6, center: '2026-12-07T00:00:00' }));
    follow.revisionChanged(5);
    expect(viewport.applied).toHaveLength(0);
    follow.revisionChanged(6);
    expect(viewport.applied.map((view) => view.center)).toEqual(['2026-12-07T00:00:00']);
  });

  it('holds frames while no plan is attached', () => {
    const { follow, viewport } = controller();
    follow.attach(null);
    follow.follow('lead');
    follow.receive(frame(0));
    expect(viewport.applied).toHaveLength(0);
    follow.attach(viewport);
    expect(viewport.applied).toHaveLength(1);
  });

  it('counts frames whose middle task this plan does not have', () => {
    const { follow, viewport } = controller();
    viewport.tasks = new Set([1, 2]);
    follow.follow('lead');
    follow.receive(frame(0));
    expect(follow.missingAnchors).toBe(1);
    expect(follow.applied).toBe(1);
  });

  it('stops when the followed person leaves, and moves on to whoever they follow', () => {
    const { follow, requests } = controller();
    follow.follow('lead');
    follow.peersChanged([peer('me'), peer('lead', { following: 'boss' }), peer('boss')], 'me');
    expect(follow.target).toBe('boss');
    expect(requests).toEqual(['lead', 'boss']);
    follow.peersChanged([peer('me'), peer('lead')], 'me');
    expect(follow.state).toEqual({ mode: 'idle', stopped: { target: 'boss', reason: 'left' } });
  });

  it('stops when the followed person starts following this tab', () => {
    const { follow } = controller();
    follow.follow('lead');
    follow.peersChanged([peer('me', { following: 'lead' }), peer('lead', { following: 'me' })], 'me');
    expect(follow.state).toEqual({ mode: 'idle', stopped: { target: 'lead', reason: 'loop' } });
  });

  it('a stop drops a held frame', () => {
    const { follow, viewport } = controller();
    follow.follow('lead');
    follow.receive(frame(0, { revision: 9 }));
    follow.stop('escape');
    follow.revisionChanged(9);
    expect(viewport.applied).toHaveLength(0);
    expect(follow.state).toEqual({ mode: 'idle', stopped: { target: 'lead', reason: 'escape' } });
  });
});

describe('ViewBroadcaster', () => {
  function broadcaster(view: () => ViewBody | null = () => ({ ...VIEW })) {
    const clock = new FakeClock();
    const sent: ViewFrame[] = [];
    let revision = 3;
    const cast = new ViewBroadcaster({ self: 'lead', read: view, send: (f) => sent.push(f), revision: () => revision, clock, intervalMs: 100, heartbeatMs: 2_000 });
    return { cast, clock, sent, setRevision: (value: number) => (revision = value) };
  }

  it('sends nothing while nobody follows', () => {
    const { cast, clock, sent } = broadcaster();
    cast.changed();
    clock.advance(10_000);
    expect(sent).toHaveLength(0);
  });

  it('sends at once when followed, then at most every interval with the latest view', () => {
    let center = 0;
    const { cast, clock, sent } = broadcaster(() => ({ ...VIEW, center: `2026-12-${String(10 + center).padStart(2, '0')}T00:00:00` }));
    cast.setFollowed(true);
    expect(sent).toHaveLength(1);
    for (let step = 1; step <= 10; step++) {
      center = step;
      cast.changed();
      clock.advance(10);
    }
    clock.advance(100);
    // 1 on follow + at most one per 100 ms over 100 ms of changes + the trailing latest.
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent.at(-1)?.center).toBe('2026-12-20T00:00:00');
    expect(sent.map((f) => f.seq)).toEqual(sent.map((_, index) => index));
  });

  it('does not repeat an unchanged view on change, but heartbeats it', () => {
    const { cast, clock, sent } = broadcaster();
    cast.setFollowed(true);
    cast.changed();
    clock.advance(500);
    expect(sent).toHaveLength(1);
    clock.advance(1_500);
    expect(sent).toHaveLength(2);
    clock.advance(2_000);
    expect(sent).toHaveLength(3);
    cast.setFollowed(false);
    clock.advance(10_000);
    expect(sent).toHaveLength(3);
    expect(clock.pendingTimers).toBe(0);
  });

  it('answers a request at once, even before presence says it is followed, with its revision', () => {
    const { cast, sent, setRevision } = broadcaster();
    setRevision(42);
    cast.requested();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ session: 'lead', seq: 0, revision: 42, preset: VIEW.preset });
  });

  it('stays quiet without a plan to read and after dispose', () => {
    const { cast, clock, sent } = broadcaster(() => null);
    cast.setFollowed(true);
    cast.requested();
    expect(sent).toHaveLength(0);
    cast.dispose();
    clock.advance(10_000);
    expect(clock.pendingTimers).toBe(0);
  });
});
