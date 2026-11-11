/**
 * The hosted site's way in (App.tsx, when HOSTED): the screens of the entry flow (entry.ts), then the workspace on
 * the visitor's session, kept while the tab is visible (lease.ts). Nothing here signs in with a password: the demo
 * accounts and their sign-in screen are not part of a hosted build.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { StatusScreen } from '../app/StatusScreen';
import { Workspace, type HostedWorkspace } from '../app/Workspace';
import { readHostedConfig } from '../hosted';
import { CopyEntry, type EntryDeps, type EntryState } from './entry';
import { joinTokenOf, sessionCodeOf, withoutParams } from './invite';
import { LeaseClock, LeaseKeeper } from './lease';
import { report, reportError } from './report';
import { claimCopy, joinCopy, joinCopyByCode, loadAppFlags, namesTaken, releaseCopy, touchCopy, type CopyClient } from './rpc';
import { BusyScreen, RefusedScreen, ResetScreen, WaitScreen, WelcomeScreen } from './screens';
import { forgetCopy, readStoredCopy, storeCopy } from './store';

/** The real steps: Supabase's anonymous sign-in and the session's functions, this tab's storage and address. */
export function copyEntryDeps(client: SupabaseClient): EntryDeps {
  const rpc = client as unknown as CopyClient;
  return {
    async getSession() {
      const { data } = await client.auth.getSession();
      return data.session;
    },
    async signInAnonymously(captchaToken) {
      const { data, error } = await client.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
      if (error) throw new Error(error.message);
      if (!data.session) throw new Error('The sign-in did not start a session.');
      return data.session;
    },
    // This tab's sign-in only (a teammate tab keeps its own, in its own storage).
    async signOut() {
      const { error } = await client.auth.signOut({ scope: 'local' });
      if (error) throw new Error(error.message);
    },
    claimCopy: (name) => claimCopy(rpc, name),
    joinCopy: (token, name) => joinCopy(rpc, token, name),
    joinCopyByCode: (code, name) => joinCopyByCode(rpc, code, name),
    namesTaken: (token) => namesTaken(rpc, token),
    touchCopy: (projectId) => touchCopy(rpc, projectId),
    releaseCopy: (projectId) => releaseCopy(rpc, projectId),
    loadFlags: () => loadAppFlags(rpc),
    readCopy: (userId) => readStoredCopy(userId),
    writeCopy: (userId, copy) => storeCopy(userId, copy),
    forgetCopy: () => forgetCopy(),
    joinToken: joinTokenOf(window.location.search),
    joinCode: sessionCodeOf(window.location.search),
    clearInvite: () => window.history.replaceState(window.history.state, '', withoutParams(window.location.href, ['join', 'code'])),
    report,
  };
}

export function CopyGate({ client }: { client: SupabaseClient }) {
  const entry = useMemo(() => new CopyEntry(copyEntryDeps(client)), [client]);
  const state = useSyncExternalStore(entry.subscribe, entry.getState);
  const siteKey = useMemo(() => readHostedConfig().turnstileSiteKey, []);

  useEffect(() => {
    void entry.start();
  }, [entry]);
  // Signed out somewhere else (the anonymous session ended): back to the start.
  useEffect(() => {
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') entry.signedOut();
    });
    return () => subscription.unsubscribe();
  }, [client, entry]);

  switch (state.kind) {
    case 'checking':
      return <StatusScreen title="Opening Gantry…" />;
    case 'working':
      return <StatusScreen title={state.title} />;
    case 'welcome':
      return (
        <WelcomeScreen
          mode={state.mode}
          signedIn={state.signedIn}
          again={state.again}
          error={state.error}
          taken={state.taken}
          code={state.code}
          name={state.name}
          siteKey={siteKey}
          onGo={(token, name, code) => void entry.go(token, name, code)}
          onChooseOwn={() => entry.chooseOwn()}
          onChooseCode={() => entry.chooseCode()}
        />
      );
    case 'busy':
      return <BusyScreen onRetry={() => void entry.newCopy()} />;
    case 'reset':
      return <ResetScreen onNewCopy={() => void entry.newCopy()} />;
    case 'refused':
      return <RefusedScreen message={state.message} onOwn={() => void entry.newCopy()} />;
    case 'wait':
      return <WaitScreen key={state.until} until={state.until} reason={state.reason} onDone={() => void entry.afterWait()} />;
    case 'error':
      return (
        <StatusScreen
          tone="error"
          title="Could not open your session"
          message={state.message}
          actions={
            <button type="button" className="button is-primary" onClick={() => void entry.retry()}>
              Try again
            </button>
          }
        />
      );
    case 'ready':
      return <CopyWorkspace key={state.generation} client={client} ready={state} entry={entry} />;
  }
}

type Ready = Extract<EntryState, { kind: 'ready' }>;

/** The workspace on the session, and the lease kept while it is open. */
function CopyWorkspace({ client, ready, entry }: { client: SupabaseClient; ready: Ready; entry: CopyEntry }) {
  const { copy, flags } = ready;
  const lease = useMemo(() => new LeaseClock(copy.leaseUntil), [copy]);
  useEffect(() => {
    const keeper = new LeaseKeeper({
      touch: async () => (await touchCopy(client as unknown as CopyClient, copy.projectId)).leaseUntil,
      onGone: () => entry.leaseLost(),
      onError: (error) => reportError('touch', error),
      onLease: lease.set,
      leaseUntil: copy.leaseUntil,
    });
    keeper.start();
    return () => keeper.stop();
  }, [client, copy, entry, lease]);

  const hosted = useMemo<HostedWorkspace>(
    () => ({
      copy,
      flags,
      lease,
      accessToken: async () => (await client.auth.getSession()).data.session?.access_token ?? null,
      startOver: () => void entry.startOver(),
      newCopy: () => void entry.leave(),
    }),
    [client, copy, flags, entry, lease],
  );
  return <Workspace client={client} session={ready.session} hosted={hosted} />;
}
