/**
 * Just enough of the Deno runtime for `tsc` to check the function entry points under Node. The edge
 * runtime supplies the real `Deno` namespace and resolves `npm:` specifiers itself; nothing imports
 * this file, so Deno never sees it.
 */
declare namespace Deno {
  export const env: { get(name: string): string | undefined; toObject(): Record<string, string> };
  export function serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}

declare module 'npm:@supabase/supabase-js@2.118.0' {
  export * from '@supabase/supabase-js';
}

declare module 'npm:pdf-lib@1.17.1' {
  export * from 'pdf-lib';
}

declare module 'npm:@anthropic-ai/sdk@0.132.1' {
  export { default } from '@anthropic-ai/sdk';
  export * from '@anthropic-ai/sdk';
}
