/**
 * "Invite", in the header beside the people in the session: the session code to read out or paste ("482 917"), the
 * link that joins the session, each with a button that copies it, and "Open a teammate in a new tab", which opens the
 * link in this browser as a second person (supabase/client.ts), for someone trying a session on their own. No QR code:
 * Gantry needs a computer, not a phone.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useDismiss } from '../app/useDismiss';
import { formatSessionCode, inviteLink, teammateLink } from './invite';
import { report } from './report';
import { JOIN_WITH_CODE } from './words';
import '../styles/copy.css';

export interface InviteButtonProps {
  /** The session's join token. */
  token: string;
  /** The session's code, 6 digits; null when this browser doesn't know it. */
  code: string | null;
  /** This site, for the link (the page's own origin). */
  origin?: string;
}

/** Where someone types the code: this site, as its address reads ("example.app"). */
export const codeLine = (origin: string): string => `They open ${new URL(origin).host} and choose ${JOIN_WITH_CODE}.`;

type Copied = 'code' | 'link' | null;

export function InviteButton({ token, code, origin = window.location.origin }: InviteButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<Copied>(null);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const linkId = useId();
  const link = useMemo(() => inviteLink(token, origin), [token, origin]);
  const teammate = useMemo(() => teammateLink(token, origin), [token, origin]);
  useDismiss(open, root, () => setOpen(false));

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (what: 'code' | 'link', text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      // No clipboard here (an insecure page, or a refusal): the link is selected for copying by hand.
      if (what === 'link') {
        field.current?.focus();
        field.current?.select();
      }
    }
  };

  return (
    <div className="copy-invite" ref={root}>
      <button
        type="button"
        className={`copy-invite-button${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Invite someone to this session"
        onClick={() => setOpen((value) => !value)}
        data-testid="invite-open"
      >
        <i className="fa fa-user-plus" aria-hidden="true" />
        <span>Invite</span>
      </button>
      {open && (
        <div className="popover copy-invite-card" role="dialog" aria-label="Invite to this session" data-testid="invite-card">
          <p className="copy-invite-title">Invite to this session</p>
          {code && (
            <div className="copy-invite-part">
              <span className="field-label">Session code</span>
              <div className="copy-invite-code">
                <span className="copy-invite-digits" data-testid="invite-code">
                  {formatSessionCode(code)}
                </span>
                <button type="button" className="button is-sm" onClick={() => void copy('code', code)} data-testid="invite-copy-code">
                  <i className={`fa fa-${copied === 'code' ? 'check' : 'copy'}`} aria-hidden="true" />
                  {copied === 'code' ? 'Copied' : 'Copy code'}
                </button>
              </div>
              <span className="field-hint">{codeLine(origin)}</span>
            </div>
          )}
          <div className="copy-invite-part">
            <label className="field-label" htmlFor={linkId}>
              Invite link
            </label>
            <div className="copy-invite-link">
              <input
                ref={field}
                id={linkId}
                className="input"
                readOnly
                value={link}
                onFocus={(event) => event.currentTarget.select()}
                data-testid="invite-link"
              />
              <button type="button" className="button is-sm" onClick={() => void copy('link', link)} data-testid="invite-copy">
                <i className={`fa fa-${copied === 'link' ? 'check' : 'copy'}`} aria-hidden="true" />
                {copied === 'link' ? 'Copied' : 'Copy link'}
              </button>
            </div>
          </div>
          <div className="copy-invite-part copy-invite-alone">
            <a className="button is-block" href={teammate} target="_blank" rel="noopener" onClick={() => report('teammate_opened')} data-testid="invite-teammate">
              <i className="fa fa-arrow-up-right-from-square" aria-hidden="true" />
              Open a teammate in a new tab
            </a>
            <span className="field-hint">On your own? The new tab joins as a second person, so you can see both sides.</span>
          </div>
          <p className="copy-invite-line">Up to 5 people can be in a session, each under a name of their own.</p>
        </div>
      )}
    </div>
  );
}
