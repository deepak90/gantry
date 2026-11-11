/**
 * place-snippet: where a library piece belongs in a group of the plan, decided by Claude.
 * POST { project_id, snippet, group, dropped_after, precedent } with the user's JWT →
 * 200 { after_id, before_id, reason, source: 'model' }; 503 MODEL_NOT_CONFIGURED without a key (the
 * browser then places it by its own rules). See _shared/placement.ts.
 */
import Anthropic from 'npm:@anthropic-ai/sdk@0.132.1';
import { createPlacementHandler, type AskModel } from '../_shared/placement.ts';
import { isProjectMember, resolveUser } from '../_shared/supabase.ts';

const key = Deno.env.get('ANTHROPIC_API_KEY');
/** Interactive (a drop waits on it): the most capable model at low effort; PLACEMENT_MODEL overrides it. */
const model = Deno.env.get('PLACEMENT_MODEL') || 'claude-opus-5-5';

const ask: AskModel | null = key
  ? async ({ system, user, schema }) => {
      const client = new Anthropic({ apiKey: key });
      const response = await client.messages.create({
        model,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      } as never);
      const textBlock = (response.content as { type: string; text?: string }[]).find((block) => block.type === 'text');
      if (!textBlock?.text) throw new Error(`No answer (stop reason ${String((response as { stop_reason?: string }).stop_reason)})`);
      return textBlock.text;
    }
  : null;

Deno.serve(
  createPlacementHandler({
    env: { get: (name) => Deno.env.get(name) },
    resolveUser,
    isMember: isProjectMember,
    ask,
    log: (message, error) => console.error(`[place-snippet] ${message}`, error),
  }),
);
