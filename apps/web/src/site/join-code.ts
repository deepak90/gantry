/**
 * "Join with a code" on the landing page: the 6 digits a teammate reads out ("482 917") take you to /app?code=482917,
 * where the app joins their session (src/copy/invite.ts reads the same code the same way).
 *
 * The field is a plain GET form to /app, so it works without scripts too; with them, what's typed is shown in
 * groups of three as it's typed, and anything that isn't 6 digits gets a plain message instead of a trip to the app.
 */
import { parseSessionCode, typedSessionCode } from '../copy/invite';

export type JoinCodeTarget = { readonly href: string } | { readonly error: string };

/** Where a typed code goes, or what to say about it. Spaces and dashes between the digits are fine. */
export function joinCodeTarget(typed: string): JoinCodeTarget {
  const code = parseSessionCode(typed);
  if (code) return { href: `/app?code=${code}` };
  if (typed.trim() === '') return { error: 'Type the 6-digit code your teammate gave you.' };
  return { error: 'A session code is 6 digits, like 482 917.' };
}

/** Wires every `form[data-join-code]` on the page; `go` leaves for the app (a test passes its own). */
export function startJoinCodeForms(root: ParentNode = document, go: (href: string) => void = (href) => window.location.assign(href)): void {
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-join-code]')) {
    const input = form.querySelector<HTMLInputElement>('input[name="code"]');
    const message = form.querySelector<HTMLElement>('[data-join-error]');
    if (!input || !message) continue;
    const say = (error: string | null) => {
      message.textContent = error ?? '';
      message.hidden = error === null;
      if (error) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };
    input.addEventListener('input', () => {
      const shown = typedSessionCode(input.value);
      if (shown !== input.value) input.value = shown;
      if (!message.hidden) say(null);
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const target = joinCodeTarget(input.value);
      if ('error' in target) {
        say(target.error);
        input.focus();
        return;
      }
      say(null);
      go(target.href);
    });
    // The disclosure around the field: opening it puts the cursor in the field.
    const details = form.closest('details');
    details?.addEventListener('toggle', () => {
      if (details.open) input.focus();
    });
  }
}
