/**
 * The header avatars over real presence sessions on the in-memory hub: who is shown, what the
 * tooltip says, clicking to follow and to stop, the "following your view" chip and the refusal note.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryPresenceHub } from '../../src/presence/in-memory-presence';
import { PresenceBar } from '../../src/presence/PresenceBar';
import { PresenceSession } from '../../src/presence/session';
import { usePresenceSnapshot } from '../../src/presence/usePresence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROLES = { pm: 'Project manager', cm: 'Cost manager' } as const;

function Bar({ session }: { session: PresenceSession }) {
  const snapshot = usePresenceSnapshot(session);
  return <PresenceBar session={session} snapshot={snapshot} roleLabel={(role) => ROLES[role]} taskName={(id) => (id === 15 ? 'Erect structural steel frame' : null)} />;
}

let hub: InMemoryPresenceHub;
let sessions: PresenceSession[];
let root: Root;
let host: HTMLDivElement;

function session(id: string, name: string, role: 'pm' | 'cm') {
  const created = new PresenceSession({ self: { session: id, user: `user-${id}`, name, color: role === 'pm' ? '#2563eb' : '#d97706', role }, transport: hub.connect(id) });
  created.start();
  sessions.push(created);
  return created;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 3; i++) {
      hub.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

const query = (selector: string) => host.querySelector<HTMLElement>(selector);

describe('PresenceBar', () => {
  beforeEach(() => {
    hub = new InMemoryPresenceHub();
    sessions = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    for (const created of sessions) created.dispose();
  });

  it('shows nobody when alone, then the other person with what they are looking at', async () => {
    const me = session('pm', 'Priya Mehta', 'pm');
    act(() => root.render(<Bar session={me} />));
    await settle();
    expect(query('[data-testid=presence-bar]')?.dataset.count).toBe('0');
    expect(host.querySelectorAll('[data-testid^=presence-avatar-]')).toHaveLength(0);

    const other = session('cm', 'Chris Morgan', 'cm');
    other.setSelectedTask(15);
    await settle();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      hub.flush();
    });
    const avatar = query('[data-testid=presence-avatar-cm]');
    expect(avatar?.textContent).toBe('CM');
    expect(avatar?.getAttribute('aria-pressed')).toBe('false');
    // A click opens the card about the person; it does not follow them.
    act(() => avatar?.click());
    await settle();
    const card = query('[data-testid=presence-card-cm]');
    expect(card?.textContent).toContain('Chris Morgan');
    expect(card?.textContent).toContain('Cost manager');
    expect(card?.textContent).toContain('Looking at “Erect structural steel frame”');
    expect(me.getSnapshot().following).toBeNull();
  });

  it('follows from the card and stops from it again; the other person sees "following you"', async () => {
    const me = session('pm', 'Priya Mehta', 'pm');
    const other = session('cm', 'Chris Morgan', 'cm');
    act(() => root.render(<Bar session={me} />));
    await settle();
    act(() => query('[data-testid=presence-avatar-cm]')?.click());
    await settle();
    act(() => query('[data-testid=presence-follow-cm]')?.click());
    await settle();
    expect(query('[data-testid=presence-avatar-cm]')?.getAttribute('aria-pressed')).toBe('true');
    expect(me.getSnapshot().following?.session).toBe('cm');
    expect(other.getSnapshot().followers.map((peer) => peer.name)).toEqual(['Priya Mehta']);
    expect(query('[data-testid=presence-card-cm]')).toBeNull();

    act(() => query('[data-testid=presence-avatar-cm]')?.click());
    await settle();
    expect(query('[data-testid=presence-follow-cm]')?.textContent).toContain('Stop following');
    act(() => query('[data-testid=presence-follow-cm]')?.click());
    await settle();
    expect(me.getSnapshot().following).toBeNull();
    expect(query('[data-testid=presence-avatar-cm]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('says who is following and refuses to follow them back', async () => {
    const me = session('cm', 'Chris Morgan', 'cm');
    const follower = session('pm', 'Priya Mehta', 'pm');
    act(() => root.render(<Bar session={me} />));
    await settle();
    follower.startFollowing('cm');
    await settle();
    expect(query('[data-testid=presence-followers]')?.textContent).toBe('Priya is following your view');
    expect(query('[data-testid=presence-avatar-pm] .presence-badge')).not.toBeNull();
    expect(query('[data-testid=presence-avatar-pm]')?.classList.contains('follows-me')).toBe(true);
    expect(query('[data-testid=presence-avatar-pm]')?.getAttribute('aria-label')).toContain('following your view');
    act(() => query('[data-testid=presence-avatar-pm]')?.click());
    await settle();
    expect(query('[data-testid=presence-card-pm]')?.textContent).toContain('Following you');
    act(() => query('[data-testid=presence-follow-pm]')?.click());
    await settle();
    expect(query('[data-testid=presence-note]')?.textContent).toContain('Priya is following you. They need to stop first.');
    expect(me.getSnapshot().following).toBeNull();
  });

  it('groups several tabs of one person into one avatar', async () => {
    const me = session('pm', 'Priya Mehta', 'pm');
    const first = new PresenceSession({ self: { session: 'cm-1', user: 'user-cm', name: 'Chris Morgan', color: '#d97706', role: 'cm' }, transport: hub.connect('cm-1') });
    const second = new PresenceSession({ self: { session: 'cm-2', user: 'user-cm', name: 'Chris Morgan', color: '#d97706', role: 'cm' }, transport: hub.connect('cm-2') });
    sessions.push(first, second);
    first.start();
    second.start();
    act(() => root.render(<Bar session={me} />));
    await settle();
    expect(host.querySelectorAll('[data-testid^=presence-avatar-]')).toHaveLength(1);
    act(() => query('[data-testid^=presence-avatar-]')?.click());
    await settle();
    expect(query('[data-testid^=presence-card-]')?.textContent).toContain('2 tabs');
  });

  it('marks simulated people with a robot and shows a busy office of them without folding anyone away', async () => {
    const me = session('pm', 'Priya Mehta', 'pm');
    const names = ['Marcus Webb', 'Lena Ortiz', 'Tom Becker', 'Aisha Khan', 'Dan Murphy', 'Sofia Rossi', 'Kenji Sato'];
    names.forEach((name, index) => {
      const sim = new PresenceSession({ self: { session: `sim${index}`, user: `sim-user-${index}`, name: `${name} (sim)`, color: '#0f766e', role: 'pm', simulated: true }, transport: hub.connect(`sim${index}`) });
      sim.start();
      sessions.push(sim);
    });
    session('cm', 'Chris Morgan', 'cm');
    act(() => root.render(<Bar session={me} />));
    await settle();
    // Eight others, all shown: each can be followed from their card.
    expect(host.querySelectorAll('[data-testid^=presence-avatar-]')).toHaveLength(8);
    const sim = query('[data-testid=presence-avatar-sim0]')!;
    expect(sim.querySelector('.presence-badge.is-sim .fa-robot')).not.toBeNull();
    expect(sim.getAttribute('aria-label')).toContain('simulated');
    expect(query('[data-testid=presence-avatar-cm]')!.querySelector('.is-sim')).toBeNull();
    act(() => sim.click());
    await settle();
    expect(query('[data-testid=presence-card-sim0]')?.textContent).toContain('Simulated');
    expect(query('[data-testid=presence-follow-sim0]')).not.toBeNull();
  });
});
