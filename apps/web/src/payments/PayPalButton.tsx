/**
 * PayPal's own button (JS SDK v6), drawn by PayPal, for a payment the payer approves in PayPal's window. Never a copy of
 * it: where no PayPal window follows, the page shows a button of its own (PayPal's terms and the truth agree on that).
 */
import { useEffect, useRef, useState } from 'react';

interface PayPalSession {
  start(options: { presentationMode: 'auto' }, order: Promise<{ orderId: string }>): Promise<unknown>;
}

interface PayPalSdk {
  createPayPalOneTimePaymentSession(handlers: { onApprove(data: { orderId: string }): unknown; onCancel(): void; onError(error: unknown): void }): PayPalSession | Promise<PayPalSession>;
}

declare global {
  interface Window {
    paypal?: { createInstance(options: { clientId: string; components: string[]; pageType: string }): Promise<PayPalSdk> };
  }
}

const SCRIPT = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
let loading: Promise<void> | null = null;

/** PayPal's script, fetched once. Called early too, so the button is there the moment it is allowed. */
export function loadPayPalSdk(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    if (window.paypal) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.async = true;
    script.src = SCRIPT;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('PayPal’s button could not be loaded.'));
    };
    document.head.append(script);
  });
  return loading;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'PayPal could not complete this payment.');

export interface PayPalButtonProps {
  clientId: string;
  /** Called on the press, not awaited first: PayPal's window must open inside the click. */
  createOrder(): Promise<{ orderId: string }>;
  onApprove(orderId: string): unknown;
  onCancel(): void;
  onError(message: string): void;
  testId: string;
}

export function PayPalButton({ clientId, createOrder, onApprove, onCancel, onError, testId }: PayPalButtonProps) {
  const slot = useRef<HTMLDivElement>(null);
  const handlers = useRef({ createOrder, onApprove, onCancel, onError });
  handlers.current = { createOrder, onApprove, onCancel, onError };
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    let button: HTMLElement | null = null;
    let press: (() => void) | null = null;
    void (async () => {
      try {
        await loadPayPalSdk();
        const sdk = await window.paypal!.createInstance({ clientId, components: ['paypal-payments'], pageType: 'checkout' });
        const session = await sdk.createPayPalOneTimePaymentSession({
          onApprove: (data) => handlers.current.onApprove(data.orderId),
          onCancel: () => handlers.current.onCancel(),
          onError: (error) => handlers.current.onError(messageOf(error)),
        });
        if (!live || !slot.current) return;
        button = document.createElement('paypal-button');
        button.setAttribute('type', 'pay');
        button.className = 'paypal-gold';
        press = () => void session.start({ presentationMode: 'auto' }, handlers.current.createOrder()).catch((error: unknown) => handlers.current.onError(messageOf(error)));
        button.addEventListener('click', press);
        slot.current.append(button);
        setReady(true);
      } catch (error) {
        if (live) handlers.current.onError(messageOf(error));
      }
    })();
    return () => {
      live = false;
      if (button && press) button.removeEventListener('click', press);
      button?.remove();
    };
  }, [clientId]);

  return <div ref={slot} className="pay-modal-paypal" data-testid={testId} data-ready={ready} />;
}
