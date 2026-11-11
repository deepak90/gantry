/**
 * Live clients for the convergence suites (edit paths, library drops, plan edits): booted the way the
 * app boots them (production project factory and snapshot package builder), with every sync state and
 * warning kept, and a settle that also waits for the STM to stop recording.
 */
import type { ProjectModel } from '@bryntum/gantt';
import type { LoadProjectResult } from '@collab/shared';
import { createProjectModel, toInlineDataPackage } from '../../src/gantt/project';
import type { InMemoryRelay } from '../../src/sync/in-memory-relay';
import { RevisionSync, type SyncState } from '../../src/sync/revision-sync';
import type { RevisionTransport } from '../../src/sync/transport';
import { PROJECT_ID, sleep } from './helpers';

export interface Peer {
  id: string;
  project: ProjectModel;
  sync: RevisionSync;
  states: SyncState[];
  warnings: string[];
}

export async function join(relay: InMemoryRelay, id: string, load: LoadProjectResult, transport: RevisionTransport = relay.connect(id)): Promise<Peer> {
  const project = createProjectModel();
  const states: SyncState[] = [];
  const warnings: string[] = [];
  const sync = new RevisionSync(project, transport, {
    sessionId: id,
    projectId: PROJECT_ID,
    prepareSnapshot: toInlineDataPackage,
    onState: (state) => states.push(state),
    onWarning: (message) => warnings.push(message),
    backoff: { initialMs: 10, maxMs: 40 },
  });
  await sync.init(load);
  return { id, project, sync, states, warnings };
}

export function dispose(peer: Peer): void {
  peer.sync.dispose();
  peer.project.destroy();
}

const QUIET_MS = 40;

/**
 * Waits until every client applied the whole log, has nothing to submit and nothing recording, and the
 * relay stayed idle for QUIET_MS (follow-up revisions such as data corrections are recorded right
 * after a revision is applied). Fails at once when a client goes out of sync.
 */
export async function settlePeers(relay: InMemoryRelay, clients: Peer[], timeoutMs: number): Promise<void> {
  const started = performance.now();
  let quietSince: number | undefined;
  let seen = -1;
  while (performance.now() - started < timeoutMs) {
    await Promise.all(clients.map((peer) => peer.sync.whenApplied()));
    await sleep(10);
    const broken = clients.find((peer) => peer.sync.state.status === 'error');
    if (broken) {
      throw new Error(`${broken.id} fell out of sync: ${broken.sync.state.error}`);
    }
    const idle =
      relay.inFlight === 0 &&
      relay.heldCount === 0 &&
      relay.revisionCount === seen &&
      clients.every(
        (peer) =>
          peer.sync.state.pending === 0 &&
          !peer.sync.hasBufferedRevisions &&
          peer.sync.state.lastRevision === relay.currentRevisionNo &&
          !(peer.project.stm as unknown as { isRecording: boolean }).isRecording,
      );
    seen = relay.revisionCount;
    if (!idle) {
      quietSince = undefined;
    } else if (quietSince === undefined) {
      quietSince = performance.now();
    } else if (performance.now() - quietSince >= QUIET_MS) {
      return;
    }
  }
  throw new Error(
    `settle() timed out at relay revision ${relay.currentRevisionNo}: ` +
      JSON.stringify(clients.map((peer) => [peer.id, peer.sync.state])),
  );
}
