/**
 * PayPal settings from the environment, checked before a function does anything else.
 *
 *   PAYPAL_MODE                              live (the sandbox REST API) or mock (paypal-mock.ts); unset = mock
 *   PAYPAL_ENV                               sandbox or unset; anything else is refused
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET   required in live mode
 *   PAYPAL_WEBHOOK_ID                        required by paypal-webhook in live mode
 */
import { MOCK_WEBHOOK_ID } from './paypal-mock.ts';
import type { PayPalMode } from './paypal.ts';

export interface Env {
  get(name: string): string | undefined;
}

export interface PayPalConfig {
  mode: PayPalMode;
  clientId: string;
  clientSecret: string;
  /** Null in live mode until a webhook is registered for the paypal-webhook URL. */
  webhookId: string | null;
}

const RESTART = 'Edit .env.local and restart `pnpm functions:serve`.';

export class ConfigError extends Error {
  readonly code = 'PAYPAL_NOT_CONFIGURED';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function readPayPalConfig(env: Env): PayPalConfig {
  const value = (name: string): string | null => {
    const raw = env.get(name)?.trim();
    return raw === undefined || raw === '' ? null : raw;
  };

  const mode = value('PAYPAL_MODE') ?? 'mock';
  if (mode !== 'live' && mode !== 'mock') {
    throw new ConfigError(`PAYPAL_MODE must be live or mock, not ${JSON.stringify(mode)}. ${RESTART}`);
  }
  const environment = value('PAYPAL_ENV') ?? 'sandbox';
  if (environment !== 'sandbox') {
    throw new ConfigError(
      `PAYPAL_ENV=${JSON.stringify(environment)} is refused: these functions only pay through the PayPal sandbox. ` +
        `Set PAYPAL_ENV=sandbox. ${RESTART}`,
    );
  }
  if (mode === 'mock') {
    return { mode, clientId: 'mock-client', clientSecret: 'mock-secret', webhookId: MOCK_WEBHOOK_ID };
  }
  const clientId = value('PAYPAL_CLIENT_ID');
  const clientSecret = value('PAYPAL_CLIENT_SECRET');
  if (clientId === null || clientSecret === null) {
    throw new ConfigError(
      'PayPal is not configured: PAYPAL_MODE=live needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (the Sandbox ' +
        'credentials of a REST app with Payouts enabled). Set them in .env.local and restart `pnpm functions:serve`, ' +
        'or set PAYPAL_MODE=mock to use the built-in mock PayPal.',
    );
  }
  return { mode, clientId, clientSecret, webhookId: value('PAYPAL_WEBHOOK_ID') };
}
