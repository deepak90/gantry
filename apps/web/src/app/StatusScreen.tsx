import type { ReactNode } from 'react';
import { GantryMark } from './GantryMark';

export interface StatusScreenProps {
  title: string;
  message?: string;
  tone?: 'info' | 'error';
  actions?: ReactNode;
}

/** Full-page card for the loading, configuration and failure states of the shell. */
export function StatusScreen({ title, message, tone = 'info', actions }: StatusScreenProps) {
  return (
    <div className="status-screen" data-testid="status-screen" data-tone={tone}>
      <div className={`status-card status-card-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
        <div className="status-heading">
          <span className="app-logo" aria-hidden="true">
            <GantryMark />
          </span>
          <h1>{title}</h1>
          {tone === 'info' && <span className="status-spinner" aria-hidden="true" />}
        </div>
        {message && <p className="status-message">{message}</p>}
        {actions && <div className="status-actions">{actions}</div>}
      </div>
    </div>
  );
}
