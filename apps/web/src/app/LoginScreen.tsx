import { useState, type FormEvent } from 'react';
import { signInWithPassword, type AuthClient } from '../supabase/auth';
import { GantryMark } from './GantryMark';

export interface DemoLogin {
  label: string;
  email: string;
  password: string;
}

/** The two accounts supabase/seed.sql creates on the local stack (mirrors SEED_MEMBERS in packages/shared). */
export const DEMO_LOGINS: readonly DemoLogin[] = [
  { label: 'Chris Hale', email: 'pm@demo.local', password: 'demo-pm-2026' },
  { label: 'Deepak Jayaram', email: 'cm@demo.local', password: 'demo-cm-2026' },
];

export interface LoginScreenProps {
  client: AuthClient;
}

/** Email + password sign-in; the auth state change is picked up by `useSession()` in the shell. */
export function LoginScreen({ client }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithPassword(client, email.trim(), password);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const fill = (login: DemoLogin) => {
    setEmail(login.email);
    setPassword(login.password);
    setError(null);
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit} aria-label="Sign in">
        <div className="login-heading">
          <span className="app-logo" aria-hidden="true">
            <GantryMark />
          </span>
          <h1>Gantry</h1>
        </div>
        <p className="login-lead">Sign in with your project account.</p>
        <label className="field">
          <span className="field-label">Email</span>
          <input
            className="input"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p className="note is-danger login-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="button is-primary is-lg is-block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="login-demo">
          <p>Sign in as:</p>
          <div className="login-demo-buttons">
            {DEMO_LOGINS.map((login) => (
              <button
                key={login.email}
                type="button"
                className="button"
                data-testid={`demo-login-${login.email.split('@')[0]}`}
                onClick={() => fill(login)}
              >
                <strong>{login.label}</strong>
              </button>
            ))}
          </div>
        </div>
      </form>
    </div>
  );
}
