/**
 * Builds Messages API server-sent-event streams, so the mock model and the replay of a recorded
 * live run go through the real SDK stream parser (MessageStream) exactly like a live response.
 */
export type MockBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  /** Reasoning or a progress note, as the API returns them by default: empty, with a signature. */
  | { type: 'thinking'; thinking?: string };

export interface MockTurn {
  blocks: MockBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  /** The tokens the response says it used (default: none). */
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_5m?: number; cache_creation_1h?: number };
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size));
  return out.length ? out : [''];
}

/** The SSE events of one assistant message, as a list of separately flushable strings. */
export function sseEvents(turn: MockTurn, model: string, id: string): string[] {
  const used = turn.usage ?? {};
  const write5m = used.cache_creation_5m ?? 0;
  const write1h = used.cache_creation_1h ?? 0;
  const events: string[] = [
    event('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: used.input_tokens ?? 0,
          output_tokens: 0,
          cache_read_input_tokens: used.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: write5m + write1h,
          ...(turn.usage ? { cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h } } : {}),
        },
      },
    }),
  ];
  turn.blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      events.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }));
      if (block.thinking) events.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }));
      events.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `sig-${index}` } }));
    } else if (block.type === 'text') {
      events.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
      for (const piece of block.text.match(/\S+\s*|\s+/g) ?? ['']) {
        events.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }));
      }
    } else {
      events.push(event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }));
      for (const piece of chunks(JSON.stringify(block.input), 24)) {
        events.push(event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: piece } }));
      }
    }
    events.push(event('content_block_stop', { type: 'content_block_stop', index }));
  });
  events.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: turn.stop_reason, stop_sequence: null }, usage: { output_tokens: used.output_tokens ?? 0 } }));
  events.push(event('message_stop', { type: 'message_stop' }));
  return events;
}

/** A streaming Response that flushes each piece with a small delay (to look like a model typing). */
export function streamingResponse(pieces: string[], delayMs: number): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(piece));
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_local' } });
}

/** Splits a recorded SSE body back into its events. */
export function splitSse(text: string): string[] {
  return text
    .split(/\n\n/)
    .filter((part) => part.trim().length > 0)
    .map((part) => `${part}\n\n`);
}
