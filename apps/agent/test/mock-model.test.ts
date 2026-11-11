/**
 * The scripted model reads what the person typed, not the context the browser sends with it: the
 * approval mode, the selected tasks and the action used to land inside the utterance, so "prepare
 * the fix" was taken as a question about approvals (the "<approval_mode>" tag matched /approv/).
 */
import { describe, expect, it } from 'vitest';
import { decide } from '../src/llm/mock-model';

const said = (words: string, context = '') => ({
  messages: [{ role: 'user', content: `<utterance speaker="Priya Mehta">${words}${context}</utterance>` }],
});

const CONTEXT = '\n<approval_mode>{"mode":"confirm_all"}</approval_mode>\n<selected_tasks>[{"id":15,"name":"Erect structural steel frame"}]</selected_tasks>';

const toolNames = (turn: ReturnType<typeof decide>) => turn.blocks.flatMap((block) => (block.type === 'tool_use' ? [block.name] : []));
const replyText = (turn: ReturnType<typeof decide>) =>
  turn.blocks.flatMap((block) => (block.type === 'tool_use' && block.name === 'reply' ? [String((block.input as { text: string }).text)] : [])).join(' ');

describe('the scripted model hears the words, not the context', () => {
  it('treats "prepare the fix" as a request to prepare it, with or without context', () => {
    for (const context of ['', CONTEXT]) {
      const turn = decide(said('Yes, prepare the fix', context));
      // Nothing was looked at in this conversation yet, so it offers to look first.
      expect(replyText(turn)).toMatch(/not looked at the rentals yet/);
    }
  });

  it('still answers who pays', () => {
    expect(replyText(decide(said('Who approves this?', CONTEXT)))).toMatch(/Anyone who sees costs pays with one press/);
  });

  it('turns what someone asks for into working days of cover, and leaves the dates to the tool', () => {
    const asked = (words: string) => decide(said(words)).blocks.flatMap((block) => (block.type === 'tool_use' && block.name === 'rental_options' ? [block.input] : []))[0];
    expect(asked('Pad it a day either side')).toMatchObject({ pad_before_days: 1, pad_after_days: 1 });
    expect(asked('Two days before and one day after')).toMatchObject({ pad_before_days: 2, pad_after_days: 1 });
    expect(asked('Keep it one spare day at the end')).toMatchObject({ pad_before_days: 0, pad_after_days: 1 });
  });
});
