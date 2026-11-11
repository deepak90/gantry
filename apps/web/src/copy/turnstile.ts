/**
 * Cloudflare Turnstile, the human check before an anonymous sign-in: Cloudflare's own script, rendered explicitly
 * into the welcome screen (the hosted site's Supabase project checks the token it gives). The script is fetched from
 * Cloudflare as their documentation asks, once, and only when the welcome screen needs it.
 */

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export interface TurnstileRenderOptions {
  sitekey: string;
  action?: string;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'flexible' | 'compact';
  'refresh-expired'?: 'auto' | 'manual' | 'never';
  callback?(token: string): void;
  'expired-callback'?(): void;
  'error-callback'?(code?: string): boolean | void;
  'timeout-callback'?(): void;
}

/** The part of `window.turnstile` this page uses. */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | null | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

type WithTurnstile = { turnstile?: TurnstileApi };

let loading: Promise<TurnstileApi> | null = null;

/** Cloudflare's script, loaded once. */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  const ready = (window as WithTurnstile).turnstile;
  if (ready) return Promise.resolve(ready);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const api = (window as WithTurnstile).turnstile;
      if (api) resolve(api);
      else fail();
    };
    const fail = () => {
      loading = null;
      script.remove();
      reject(new Error('The human check could not load. Check your connection and reload the page.'));
    };
    script.onerror = fail;
    doc.head.append(script);
  });
  return loading;
}
