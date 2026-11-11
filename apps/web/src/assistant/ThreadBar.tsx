/**
 * The thread switcher at the top of the assistant, and who the open thread is for.
 *
 * Every new conversation is its own thread: "New" opens an empty one, created (private, named by its
 * first words) when its first message goes out; the assistant gives it a short name once it has
 * answered. The list shows the main thread "General" (everyone's) first, then the busiest threads,
 * with a lock on private ones, a dot on those with something new and "writing…" on the one the
 * assistant is answering in. A thread's starter or a project manager renames or deletes it
 * (deleting asks first: its messages go with it, while the changelog keeps what was decided in it).
 *
 * Under it, the open thread's audience: private to you, shared with the people you invited, or with
 * the whole project. Anyone in a private thread invites another member; its starter shares it with
 * the project. Bringing in someone who cannot see costs, where someone in the conversation can, first
 * asks the person doing it to confirm (a caution card): everything in it, amounts included, will be
 * visible to them. Confirming shares the costs in that conversation (the server records who and
 * when, and refuses the invitation without it); the assistant then gives amounts to everyone in it.
 * Where nobody shared them (the General thread) and someone reading may not see costs, the assistant
 * leaves amounts out, and the bar says so.
 */
import { MAIN_THREAD_TITLE, type AgentThreadRow } from '@collab/shared';
import { useEffect, useRef, useState } from 'react';
import { useDismiss } from '../app/useDismiss';
import { when } from '../editor/ui';
import { MAIN_THREAD_KEY } from './session';
import { ASSISTANT_NAME } from './identity';

export interface ThreadMember {
  userId: string;
  canViewCosts: boolean;
}

export interface ThreadBarProps {
  threadId: string | null;
  /** A new conversation not sent yet. */
  draft: boolean;
  threads: readonly AgentThreadRow[];
  /** Who was invited into each private thread. */
  invited: ReadonlyMap<string, readonly string[]>;
  /** The project's members (for invitations and for whether amounts are shown). */
  members: readonly ThreadMember[];
  unread: ReadonlySet<string>;
  busyThread: string | null;
  viewerId: string;
  viewerIsPm: boolean;
  /** Whether replies in the open thread mention amounts (inviting someone who may not see costs warns). */
  mentionsAmounts: boolean;
  nameOf(userId: string | null): string | null;
  onOpen(threadId: string | null): void;
  onNew(): void;
  onRename(threadId: string, title: string): Promise<boolean>;
  onDelete(threadId: string): Promise<boolean>;
  /** `shareCosts`: the viewer confirmed sharing the costs in the conversation with this person. */
  onInvite(userId: string, shareCosts?: boolean): Promise<boolean>;
  onRemove(userId: string): Promise<boolean>;
  onShare(visibility: 'project' | 'private', shareCosts?: boolean): Promise<boolean>;
}

export function ThreadBar(props: ThreadBarProps) {
  const { threadId, draft, threads, unread, busyThread, viewerId, viewerIsPm, nameOf, onOpen, onNew, onRename, onDelete } = props;
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const current = threadId ? threads.find((thread) => thread.id === threadId) : null;
  const openKey = draft ? null : (threadId ?? MAIN_THREAD_KEY);
  const othersUnread = [...unread].some((key) => key !== openKey);

  useDismiss(open, root, () => {
    setOpen(false);
    setRenaming(null);
    setConfirming(null);
  });

  const pick = (id: string | null) => {
    onOpen(id);
    setOpen(false);
  };
  const canChange = (thread: AgentThreadRow) => thread.created_by === viewerId || viewerIsPm;

  const row = (key: string, id: string | null, title: string, meta: string, thread: AgentThreadRow | null) => {
    const active = openKey === key;
    if (thread && renaming?.id === thread.id) {
      return (
        <form
          key={key}
          className="thread-row is-editing"
          onSubmit={(event) => {
            event.preventDefault();
            void onRename(thread.id, renaming.title).then((ok) => ok && setRenaming(null));
          }}
        >
          <input className="input" autoFocus value={renaming.title} maxLength={80} aria-label="Thread name" onChange={(event) => setRenaming({ id: thread.id, title: event.target.value })} />
          <button type="submit" className="button is-quiet is-icon is-sm" aria-label="Save the name" disabled={!renaming.title.trim()}>
            <i className="fa fa-check" aria-hidden="true" />
          </button>
        </form>
      );
    }
    if (thread && confirming === thread.id) {
      return (
        <div key={key} className="note is-danger thread-row is-confirming" role="alertdialog" aria-label="Delete this thread?">
          <span>Delete “{thread.title}” and its messages?</span>
          <button type="button" className="button is-danger is-primary is-sm" onClick={() => void onDelete(thread.id).then(() => setConfirming(null))} data-testid="thread-delete-confirm">
            Delete
          </button>
          <button type="button" className="button is-link" onClick={() => setConfirming(null)}>
            Keep
          </button>
        </div>
      );
    }
    return (
      <div key={key} className={`thread-row${active ? ' is-active' : ''}`}>
        <button type="button" className="thread-pick" onClick={() => pick(id)} aria-current={active ? 'true' : undefined} data-testid="thread-option">
          <span className="thread-title">
            {unread.has(key) && !active && <i className="thread-dot" aria-label="new messages" />}
            {thread?.visibility === 'private' && <i className="fa fa-lock thread-lock" aria-label="private" />}
            {title}
          </span>
          <span className="thread-meta">{busyThread === key ? 'Assistant writing…' : meta}</span>
        </button>
        {thread && canChange(thread) && (
          <span className="thread-actions">
            <button type="button" className="button is-quiet is-icon is-sm" aria-label={`Rename ${thread.title}`} onClick={() => setRenaming({ id: thread.id, title: thread.title })}>
              <i className="fa fa-pen" aria-hidden="true" />
            </button>
            <button type="button" className="button is-quiet is-icon is-sm" aria-label={`Delete ${thread.title}`} onClick={() => setConfirming(thread.id)} data-testid="thread-delete">
              <i className="fa fa-trash-can" aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
    );
  };

  const currentTitle = draft ? 'New conversation' : (current?.title ?? MAIN_THREAD_TITLE);

  return (
    <div className="thread-head">
      <div className="thread-bar" ref={root}>
        <button type="button" className="button is-quiet thread-current" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="true" data-testid="thread-switcher">
          <i className={`fa fa-${current?.visibility === 'private' || draft ? 'lock' : 'comments'}`} aria-hidden="true" />
          <span>{currentTitle}</span>
          {othersUnread && <i className="thread-dot" aria-label="new messages in another thread" />}
          <i className={`fa fa-chevron-${open ? 'up' : 'down'}`} aria-hidden="true" />
        </button>
        <button type="button" className="button is-sm thread-new" onClick={onNew} disabled={draft} title="Start a new conversation" data-testid="thread-new">
          <i className="fa fa-plus" aria-hidden="true" /> New
        </button>
        {open && (
          <div className="popover thread-menu" role="menu">
            <div className="thread-list">
              {row(MAIN_THREAD_KEY, null, MAIN_THREAD_TITLE, 'Shared with everyone in the project', null)}
              {threads.map((thread) =>
                row(thread.id, thread.id, thread.title, `${thread.created_by === viewerId ? 'You' : (firstName(nameOf(thread.created_by)) ?? 'Someone')} · ${when(thread.last_message_at)}`, thread),
              )}
            </div>
            {threads.length === 0 && <p className="field-hint thread-hint">Each new conversation is its own thread: private to you until you invite someone.</p>}
          </div>
        )}
      </div>
      <Audience {...props} current={current ?? null} />
    </div>
  );
}

/** What the caution card asks about: bringing one person in, or the whole project. */
type Caution = { kind: 'invite'; userId: string } | { kind: 'share' };

/** Who reads the open thread, with Invite and Share, and whether amounts are shared or left out. */
function Audience({ draft, current, invited, members, viewerId, mentionsAmounts, nameOf, onInvite, onRemove, onShare }: ThreadBarProps & { current: AgentThreadRow | null }) {
  const [picking, setPicking] = useState(false);
  const [caution, setCaution] = useState<Caution | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(picking || caution !== null, root, () => {
    setPicking(false);
    setCaution(null);
  });

  const isPrivate = draft || current?.visibility === 'private';
  const inside = current ? [current.created_by, ...(invited.get(current.id) ?? [])].filter((id): id is string => Boolean(id)) : [viewerId];
  const readers = isPrivate ? members.filter((member) => inside.includes(member.userId)) : members;
  const sharedBy = current?.costs_shared_by ?? null;
  const hidden = sharedBy ? [] : readers.filter((member) => !member.canViewCosts);
  const outside = members.filter((member) => !inside.includes(member.userId));
  const starter = !current || current.created_by === viewerId;
  const viewerSeesCosts = members.find((member) => member.userId === viewerId)?.canViewCosts ?? false;
  /** Someone in the conversation sees costs, and nobody has shared them yet. */
  const costsAtStake = !sharedBy && readers.some((member) => member.canViewCosts);
  const name = (userId: string) => (userId === viewerId ? 'you' : (firstName(nameOf(userId)) ?? 'someone'));

  const who = draft
    ? 'Private: only you until you invite someone'
    : isPrivate
      ? `Private: ${inside.length <= 1 ? `you and ${ASSISTANT_NAME}` : listOf(inside.map(name))}`
      : current
        ? 'Shared with everyone in the project'
        : 'General: everyone in the project';

  const done = () => {
    setPicking(false);
    setCaution(null);
  };
  const invite = (member: ThreadMember) => {
    if (!member.canViewCosts && costsAtStake) {
      setPicking(false);
      setCaution({ kind: 'invite', userId: member.userId });
      return;
    }
    void onInvite(member.userId).then(done);
  };
  const share = () => {
    if (costsAtStake && members.some((member) => !member.canViewCosts)) {
      setCaution({ kind: 'share' });
      return;
    }
    void onShare('project');
  };

  return (
    <div className="thread-audience" ref={root} data-testid="thread-audience">
      <span className="thread-audience-who">
        <i className={`fa fa-${isPrivate ? 'lock' : 'users'}`} aria-hidden="true" />
        {who}
      </span>
      {sharedBy && readers.some((member) => !member.canViewCosts) && (
        <span
          className="pill is-sm is-warning thread-audience-money"
          title={`${sharedBy === viewerId ? 'You' : (firstName(nameOf(sharedBy)) ?? 'Someone')} chose to share the costs in this conversation with everyone in it${current?.costs_shared_at ? ` (${when(current.costs_shared_at)})` : ''}`}
          data-testid="thread-costs-shared"
        >
          <i className="fa fa-eye" aria-hidden="true" /> Costs shared by {name(sharedBy)}
        </span>
      )}
      {hidden.length > 0 && (
        <span className="pill is-sm thread-audience-money" title={`${ASSISTANT_NAME} leaves amounts out where someone reading may not see costs`}>
          <i className="fa fa-eye-slash" aria-hidden="true" /> Amounts hidden for {listOf(hidden.map((member) => name(member.userId)))}
        </span>
      )}
      {!draft && current && isPrivate && (
        <span className="thread-audience-actions">
          {outside.length > 0 && (
            <button type="button" className="button is-quiet is-sm" aria-haspopup="true" aria-expanded={picking} onClick={() => setPicking((value) => !value)} data-testid="thread-invite">
              <i className="fa fa-user-plus" aria-hidden="true" /> Invite
            </button>
          )}
          {starter && (
            <button type="button" className="button is-quiet is-sm" onClick={share} title="Everyone in the project can read it">
              <i className="fa fa-users" aria-hidden="true" /> Share
            </button>
          )}
          {!starter && (
            <button type="button" className="button is-quiet is-sm" onClick={() => void onRemove(viewerId)}>
              Leave
            </button>
          )}
        </span>
      )}
      {!draft && current && !isPrivate && current.created_by === viewerId && (
        <button type="button" className="button is-quiet is-sm" onClick={() => void onShare('private')}>
          <i className="fa fa-lock" aria-hidden="true" /> Make private
        </button>
      )}
      {picking && (
        <div className="popover thread-invite" role="menu">
          <p className="section-label">Invite into this thread</p>
          {outside.map((member) => (
            <div key={member.userId} className="thread-invite-row">
              <button type="button" className="menu-item" onClick={() => invite(member)} data-testid="thread-invite-member">
                <i className="fa fa-user" aria-hidden="true" />
                <span>{nameOf(member.userId) ?? 'A member'}</span>
                {!member.canViewCosts && <span className="pill is-sm">no cost access</span>}
              </button>
            </div>
          ))}
        </div>
      )}
      {caution && (
        <CostsCaution
          caution={caution}
          person={caution.kind === 'invite' ? (firstName(nameOf(caution.userId)) ?? 'This person') : null}
          viewerSeesCosts={viewerSeesCosts}
          mentionsAmounts={mentionsAmounts}
          onCancel={() => setCaution(null)}
          onConfirm={() => void (caution.kind === 'invite' ? onInvite(caution.userId, true) : onShare('project', true)).then(done)}
        />
      )}
    </div>
  );
}

/**
 * The caution before someone who cannot see costs comes into a conversation where someone can: they
 * will see everything in it, amounts included, from before and from now on. Confirming shares the
 * costs here; only someone who sees costs may.
 */
function CostsCaution({ caution, person, viewerSeesCosts, mentionsAmounts, onCancel, onConfirm }: { caution: Caution; person: string | null; viewerSeesCosts: boolean; mentionsAmounts: boolean; onCancel(): void; onConfirm(): void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  const who = caution.kind === 'invite' ? person! : 'Some members of this project';
  const them = caution.kind === 'invite' ? person! : 'everyone in the project';
  return (
    <div className="popover thread-caution" role="alertdialog" aria-labelledby="thread-caution-title" aria-describedby="thread-caution-text" data-testid="thread-caution">
      <p className="thread-caution-title" id="thread-caution-title">
        <i className="fa fa-triangle-exclamation" aria-hidden="true" />
        {caution.kind === 'invite' ? `Invite ${person} into this conversation?` : 'Share this conversation with the whole project?'}
      </p>
      <p id="thread-caution-text">
        {who} can’t see costs on this project. Everything in this conversation will be visible to {them}: what has been said{mentionsAmounts ? ', including the amounts already mentioned here,' : ''} and
        what the assistant says from now on, amounts included.
      </p>
      {viewerSeesCosts ? (
        <p className="thread-caution-small">Go ahead only if that is all right. The conversation will show that you shared its costs.</p>
      ) : (
        <p className="thread-caution-small">Only someone who can see costs can share them. Ask them to {caution.kind === 'invite' ? `invite ${person}` : 'share it'}.</p>
      )}
      <div className="thread-caution-actions">
        {viewerSeesCosts && (
          <button type="button" ref={confirm} className="button is-primary is-sm" onClick={onConfirm} data-testid="thread-caution-confirm">
            {caution.kind === 'invite' ? `Invite ${person} and share costs` : 'Share it, costs included'}
          </button>
        )}
        <button type="button" className="button is-sm" onClick={onCancel} data-testid="thread-caution-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}

const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] ?? null;

/** "you", "you and Chris", "you, Chris and Deepak". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
