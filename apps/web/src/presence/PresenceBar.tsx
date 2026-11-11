/**
 * Who else is in the plan, in the header: one avatar per person, in their color. Hovering or
 * clicking an avatar opens a card about the person: their role, how many tabs they have open, what
 * they are looking at (with a button to show that task in your own plan, without following), and
 * whether they follow someone. Following their view takes over your scrolling and zoom, so it is a
 * deliberate choice in that card ("Follow their view"), not what a click on the avatar does.
 *
 * Being followed means your view is on someone else's screen, so it shows the moment it starts: a pill
 * beside the avatars ("Chris is following your view") that arrives filled and settles to a tint, and an
 * eye on the follower's avatar, ringed as they start (presence.css).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MemberRole } from '@collab/shared';
import { useDismiss } from '../app/useDismiss';
import { initialsOf, readableInkOn } from './peers';
import type { Peer } from './protocol';
import type { PresenceSession, PresenceSnapshot } from './session';
import '../styles/presence.css';

export interface PresenceBarProps {
  session: PresenceSession | null;
  snapshot: PresenceSnapshot | null;
  roleLabel(role: MemberRole): string;
  /** The name of a task, for "looking at …". */
  taskName(taskId: number): string | null;
  /** Selects a task in this person's own plan (no following). */
  onShowTask?(taskId: number): void;
}

/** Room for a busy site office (the simulated crowd is up to seven people) before the rest fold into "+N". */
const MAX_AVATARS = 9;

/** One avatar per person: their newest tab stands for them. */
function byPerson(peers: readonly Peer[]): { peer: Peer; tabs: number }[] {
  const people = new Map<string, { peer: Peer; tabs: number }>();
  for (const peer of peers) {
    const known = people.get(peer.user);
    if (!known) people.set(peer.user, { peer, tabs: 1 });
    else people.set(peer.user, { peer: peer.since >= known.peer.since ? peer : known.peer, tabs: known.tabs + 1 });
  }
  return [...people.values()];
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

const since = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function PresenceBar({ session, snapshot, roleLabel, taskName, onShowTask }: PresenceBarProps) {
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The person whose card is open, and whether a click pinned it (a hover card closes when the pointer leaves). */
  const [card, setCard] = useState<{ user: string; pinned: boolean } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // This person's other tabs are not somebody else.
  const people = useMemo(() => byPerson((snapshot?.peers ?? []).filter((peer) => peer.user !== session?.userId)), [snapshot?.peers, session]);

  useEffect(() => {
    if (!refusal) return undefined;
    const timer = setTimeout(() => setRefusal(null), 4_000);
    return () => clearTimeout(timer);
  }, [refusal]);

  // A pinned card closes on a click elsewhere or Escape.
  useDismiss(Boolean(card?.pinned), root, () => setCard(null));

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  if (!session || !snapshot) return null;
  const followingUser = snapshot.following?.user ?? null;
  const followers = byPerson(snapshot.followers);
  const shown = people.slice(0, MAX_AVATARS);
  const hidden = people.length - shown.length;

  const toggle = (peer: Peer) => {
    setRefusal(null);
    setCard(null);
    if (followingUser === peer.user) {
      session.stopFollowing('manual');
      return;
    }
    const result = session.startFollowing(peer.session);
    if (!result.ok && result.reason === 'loop') setRefusal(`${firstName(peer.name)} is following you. They need to stop first.`);
  };
  const hover = (user: string | null) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (card?.pinned) return;
    // A short wait on the way in and out, so passing over the avatars does not flash cards.
    hoverTimer.current = setTimeout(() => setCard(user ? { user, pinned: false } : null), user ? 250 : 200);
  };

  return (
    <div
      ref={root}
      className="presence-bar"
      data-testid="presence-bar"
      data-count={people.length}
      data-status={snapshot.status}
      data-frames-sent={snapshot.framesSent}
      data-frames-applied={snapshot.framesApplied}
    >
      {followers.length > 0 && (
        <span className="presence-followers" data-testid="presence-followers">
          <i className="fa fa-eye" aria-hidden="true" />
          {followers.length === 1 ? `${firstName(followers[0]!.peer.name)} is following your view` : `${followers.length} people are following your view`}
        </span>
      )}
      {people.length > 0 && (
        <ul className="presence-avatars" aria-label="People in this plan">
          {shown.map(({ peer, tabs }) => {
            const looking = peer.taskId !== null ? taskName(peer.taskId) : null;
            const isFollowed = followingUser === peer.user;
            const followsMe = snapshot.followers.some((follower) => follower.user === peer.user);
            const leader = peer.following ? snapshot.peers.find((other) => other.session === peer.following) : null;
            const open = card?.user === peer.user;
            return (
              <li key={peer.user} className="presence-person" onMouseEnter={() => hover(peer.user)} onMouseLeave={() => hover(null)}>
                <button
                  type="button"
                  className={`presence-avatar${isFollowed ? ' is-followed' : ''}${followsMe ? ' follows-me' : ''}`}
                  style={{ '--peer': peer.color, '--peer-ink': readableInkOn(peer.color) } as CSSProperties}
                  aria-pressed={isFollowed}
                  aria-expanded={open}
                  aria-haspopup="dialog"
                  aria-label={`${peer.name}, ${roleLabel(peer.role)}${peer.simulated ? ', simulated' : ''}${isFollowed ? ' (you are following them)' : followsMe ? ' (following your view)' : ''}`}
                  data-testid={`presence-avatar-${peer.session}`}
                  data-name={peer.name}
                  onClick={() => {
                    // A click soon after the pointer arrived beats the hover's pending open, which would unpin it.
                    if (hoverTimer.current) clearTimeout(hoverTimer.current);
                    setCard(open && card?.pinned ? null : { user: peer.user, pinned: true });
                  }}
                  onFocus={() => hover(peer.user)}
                >
                  <span className="presence-initials">{initialsOf(peer.name)}</span>
                  {peer.simulated && (
                    <span className="presence-badge is-sim" aria-hidden="true" title="Simulated person">
                      <i className="fa fa-robot" />
                    </span>
                  )}
                  {followsMe && (
                    <span className="presence-badge" aria-hidden="true">
                      <i className="fa fa-eye" />
                    </span>
                  )}
                </button>
                {open && (
                  <div className="popover presence-card" role="dialog" aria-label={peer.name} data-testid={`presence-card-${peer.session}`} style={{ '--peer': peer.color } as CSSProperties}>
                    <p className="presence-card-name">
                      <span className="presence-card-swatch" aria-hidden="true" />
                      <strong>{peer.name}</strong>
                    </p>
                    <p className="presence-card-meta">
                      {peer.simulated ? 'Simulated · ' : ''}
                      {roleLabel(peer.role)} · here since {since(peer.since)}
                      {tabs > 1 ? ` · ${tabs} tabs` : ''}
                    </p>
                    <p className="presence-card-line">
                      <i className="fa fa-arrow-pointer" aria-hidden="true" />
                      {looking ? (
                        <>
                          Looking at{' '}
                          {onShowTask && peer.taskId !== null ? (
                            <button type="button" className="button is-link presence-card-task" onClick={() => onShowTask(peer.taskId!)} title="Show it in your plan (you keep your own view)" data-testid="presence-card-task">
                              {looking}
                            </button>
                          ) : (
                            <strong>“{looking}”</strong>
                          )}
                        </>
                      ) : (
                        'Nothing selected'
                      )}
                    </p>
                    {leader && (
                      <p className="presence-card-line">
                        <i className="fa fa-eye" aria-hidden="true" /> Following {leader.user === session.userId ? 'you' : firstName(leader.name)}
                      </p>
                    )}
                    {followsMe && (
                      <p className="presence-card-line">
                        <i className="fa fa-eye" aria-hidden="true" /> Following you
                      </p>
                    )}
                    <div className="presence-card-actions">
                      <button type="button" className="button is-block" onClick={() => toggle(peer)} data-testid={`presence-follow-${peer.session}`}>
                        <i className={`fa fa-${isFollowed ? 'eye-slash' : 'eye'}`} aria-hidden="true" />
                        {isFollowed ? 'Stop following' : 'Follow their view'}
                      </button>
                      {!isFollowed && <span className="presence-card-hint">Your plan then scrolls and zooms with theirs until you move it.</span>}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          {hidden > 0 && (
            <li>
              <span className="presence-avatar presence-more" title={people.slice(MAX_AVATARS).map(({ peer }) => peer.name).join('\n')}>
                +{hidden}
              </span>
            </li>
          )}
        </ul>
      )}
      {snapshot.canRestore && !refusal && (
        <span className="presence-restore" data-testid="presence-restore">
          <button type="button" className="presence-restore-button" onClick={() => session.restoreOwnView()} title="Go back to what you were looking at before following">
            <i className="fa fa-rotate-left" aria-hidden="true" />
            Back to my view
          </button>
          {!snapshot.notice && (
            <button type="button" className="presence-restore-dismiss" aria-label="Stay here" title="Stay here" onClick={() => session.dismissNotice()}>
              <i className="fa fa-xmark" aria-hidden="true" />
            </button>
          )}
        </span>
      )}
      {(refusal ?? snapshot.notice) && (
        <p className="presence-note" role="status" data-testid="presence-note">
          <span>{refusal ?? snapshot.notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setRefusal(null);
              session.dismissNotice();
            }}
          >
            <i className="fa fa-xmark" aria-hidden="true" />
          </button>
        </p>
      )}
    </div>
  );
}
