/**
 * A short name for a thread, from its first message, as the assistant gives it once it has answered
 * there (people start a conversation without naming it; until then it shows the message's first
 * words). One small request; any failure keeps the first words. What it used comes back with it, so
 * the hosted site can count what it cost.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { usageOf, type TokenUsage } from '../llm/pricing';
import { supportsServerFallback } from './brain';

const TITLE_PROMPT =
  'You name conversations in a construction scheduling app. Reply with a title of 3 to 6 words for the conversation that starts with the message below: plain words in sentence case, the subject only, no quotes and no period.';

/** The model's answer as a title: one line, no quotes or trailing punctuation, 1-8 words and at most 60 characters. */
export function cleanTitle(text: string): string | null {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;
  const title = line
    .replace(/^(title|name)\s*:\s*/i, '')
    .replace(/^["'“‘*]+|["'”’*]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = title.split(' ').filter(Boolean).length;
  if (words === 0 || words > 8 || title.length > 60) return null;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The title (null: keep the first words) and the tokens the request used. */
export async function titleFromFirstMessage(client: Anthropic, model: string, message: string): Promise<{ title: string | null; usage: TokenUsage }> {
  const response = await client.beta.messages.create({
    model,
    max_tokens: 1024,
    system: TITLE_PROMPT,
    messages: [{ role: 'user', content: message.slice(0, 500) }],
    output_config: { effort: 'low' },
    ...(supportsServerFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  });
  const usage = usageOf(response.usage);
  if (response.stop_reason === 'refusal') return { title: null, usage };
  const text = response.content
    .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join(' ');
  return { title: cleanTitle(text), usage };
}
