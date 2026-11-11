/**
 * The people on the call, after Remy's tile on the call bar: each person's initials in their cursor
 * color, never a face. A ring in that color while they speak, which grows with their voice; a crossed-out
 * microphone while they are muted; "AI voice" under a simulated person.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRef, type CSSProperties } from 'react';
import { useLevel } from '../rails/RailFaces';
import type { CallSession } from './session';
import { tilesOf, type CallPerson, type Tile } from './view';

const EASE = [0.22, 1, 0.36, 1] as const;

function PersonTile({ tile, level }: { tile: Tile; level(): number }) {
  const face = useRef<HTMLSpanElement>(null);
  // The ring and the light behind the initials follow the voice on every frame, without a render.
  useLevel(face, () => (tile.speaking ? level() : level() * 0.5));
  return (
    <span
      ref={face}
      className={`rail-face-frame is-you is-md call-face${tile.speaking ? ' is-speaking' : ''}`}
      style={{ '--ring': tile.color, '--face-ink': tile.ink } as CSSProperties}
      aria-hidden="true"
    >
      <span className="rail-face-aura" />
      <span className="call-ring" />
      <span className="rail-face">{tile.initials}</span>
      {tile.muted && (
        <span className="call-muted">
          <i className="fa fa-microphone-slash" />
        </span>
      )}
    </span>
  );
}

export function CallTiles({ session, people }: { session: CallSession; people: readonly CallPerson[] }) {
  const reduce = useReducedMotion();
  const tiles = tilesOf(people);
  return (
    <AnimatePresence initial={false}>
      {tiles.map((tile) => (
        <motion.div
          key={tile.identity}
          className={`rail-call-tile call-tile${tile.speaking ? ' is-speaking' : ''}`}
          role="group"
          aria-label={tile.title}
          title={tile.title}
          data-testid={`call-tile-${tile.identity}`}
          data-speaking={tile.speaking}
          data-muted={tile.muted}
          data-local={tile.isLocal}
          initial={reduce ? false : { opacity: 0, scale: 0.6, width: 0 }}
          animate={{ opacity: 1, scale: 1, width: 'auto' }}
          exit={{ opacity: 0, scale: 0.7, width: 0 }}
          transition={{ duration: reduce ? 0 : 0.42, ease: EASE }}
        >
          <PersonTile tile={tile} level={() => session.level(tile.identity)} />
          <span className="rail-call-name">
            {tile.label}
            {tile.tag && <span className="rail-tag call-tag">{tile.tag}</span>}
          </span>
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
