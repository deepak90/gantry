/**
 * Canary for room-io.ts: the workaround leans on agents-js internals, so this fails when the
 * installed versions move off the pinned ones or the internals it uses disappear.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeLogger, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { muteStateMirror, PINNED_AGENTS_VERSION } from '../src/room-io.ts';

const require = createRequire(import.meta.url);
initializeLogger({ pretty: false, level: 'error' });

function packageRoot(name: string): string {
  let dir = dirname(require.resolve(name));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === name) return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json for ${name}`);
    dir = parent;
  }
}

const version = (name: string) => (JSON.parse(readFileSync(join(packageRoot(name), 'package.json'), 'utf8')) as { version: string }).version;

describe('the pinned LiveKit stack', () => {
  it('is the one room-io.ts was written against', () => {
    expect(version('@livekit/agents')).toBe(PINNED_AGENTS_VERSION);
    expect(version('@livekit/agents-plugin-openai')).toBe(PINNED_AGENTS_VERSION);
    expect(version('@livekit/agents-plugin-silero')).toBe(PINNED_AGENTS_VERSION);
    expect(version('@livekit/rtc-node')).toBe('1.1.0');
    expect(version('livekit-server-sdk')).toBe('2.19.1');
  });

  it('still lets a session start on a RoomIO set beforehand', () => {
    const source = readFileSync(join(packageRoot('@livekit/agents'), 'dist/voice/agent_session.js'), 'utf8');
    expect(source).toContain('room && !this._roomIO');
  });

  it("still mirrors state through RoomIO's own listener, which can be switched off", () => {
    const session = new voice.AgentSession({ vad: null, turnHandling: { turnDetection: 'manual' } });
    const roomIO = new voice.RoomIO({ agentSession: session, room: {} as Room });
    expect(muteStateMirror(session, roomIO)).toBe(true);
  });
});
