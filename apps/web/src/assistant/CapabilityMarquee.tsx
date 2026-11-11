/**
 * The assistant's start page: two rows of what it can do, drifting in opposite directions. A row
 * pauses while the pointer or keyboard focus is on it. Picking a card
 * swaps the rows for that topic's questions, which arrive one after another; a question is only sent
 * when it is picked. Under reduced motion the rows stand still and scroll sideways instead.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';
import type { Capability } from './capabilities';
import '../styles/marquee.css';
import { ASSISTANT_NAME } from './identity';

const SPRING = { type: 'spring', stiffness: 340, damping: 32 } as const;

function CapabilityCard({ capability, onPick, hidden = false }: { capability: Capability; onPick(capability: Capability): void; hidden?: boolean }) {
  return (
    <button
      type="button"
      className="marquee-card"
      onClick={() => onPick(capability)}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      data-testid={hidden ? undefined : 'capability-card'}
    >
      <span className="marquee-icon" aria-hidden="true">
        <i className={capability.icon === 'paypal' ? 'fa-brands fa-paypal' : `fa fa-${capability.icon}`} />
      </span>
      <span className="marquee-text">
        <strong>{capability.label}</strong>
        <span>{capability.preview}</span>
      </span>
    </button>
  );
}

function MarqueeRow({ cards, direction, onPick }: { cards: readonly Capability[]; direction: 'left' | 'right'; onPick(capability: Capability): void }) {
  return (
    <div className="marquee-row" role="group" aria-label={`What ${ASSISTANT_NAME} can do`}>
      <div className={`marquee-track is-${direction}`}>
        {cards.map((capability) => (
          <CapabilityCard key={capability.label} capability={capability} onPick={onPick} />
        ))}
        {/* The same cards again, so the loop has no seam; hidden from assistive tech and the keyboard. */}
        {cards.map((capability) => (
          <CapabilityCard key={`again-${capability.label}`} capability={capability} onPick={onPick} hidden />
        ))}
      </div>
    </div>
  );
}

export interface CapabilityMarqueeProps {
  rows: readonly [readonly Capability[], readonly Capability[]];
  /** Sends a question to the assistant. */
  onAsk(prompt: string): void;
}

export function CapabilityMarquee({ rows, onAsk }: CapabilityMarqueeProps) {
  const [topic, setTopic] = useState<Capability | null>(null);
  const reduce = useReducedMotion();
  return (
    <div className="marquee" data-testid="capability-marquee">
      <AnimatePresence mode="wait" initial={false}>
        {topic ? (
          <motion.div
            key={topic.label}
            className="marquee-topic"
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            <button type="button" className="button is-quiet is-sm marquee-back" onClick={() => setTopic(null)}>
              <i className="fa fa-arrow-left" aria-hidden="true" /> Other topics
            </button>
            <p className="marquee-topic-title">
              <i className={topic.icon === 'paypal' ? 'fa-brands fa-paypal' : `fa fa-${topic.icon}`} aria-hidden="true" /> {topic.label}
            </p>
            <ul className="marquee-questions">
              {topic.questions.map((question, index) => (
                <motion.li
                  key={question.label}
                  initial={reduce ? false : { opacity: 0, y: 10, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ ...SPRING, delay: reduce ? 0 : 0.06 + index * 0.09 }}
                >
                  <button type="button" className="marquee-question" onClick={() => onAsk(question.prompt)} data-testid="capability-question">
                    <span>{question.label}</span>
                    <i className="fa fa-arrow-up" aria-hidden="true" />
                  </button>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        ) : (
          <motion.div key="rows" className="marquee-rows" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <MarqueeRow cards={rows[0]} direction="left" onPick={setTopic} />
            <MarqueeRow cards={rows[1]} direction="right" onPick={setTopic} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
