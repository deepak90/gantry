/** One-line logs with a project tag. Callers never pass secrets; errors are reduced to their message. */
export interface Logger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return error === undefined ? '' : String(error);
}

export function createLogger(tag: string, sink: (line: string) => void = (line) => console.log(line)): Logger {
  const stamp = () => new Date().toISOString().slice(11, 23);
  return {
    info: (message) => sink(`${stamp()} [${tag}] ${message}`),
    warn: (message, error) => sink(`${stamp()} [${tag}] WARN ${message}${error === undefined ? '' : `: ${reason(error)}`}`),
  };
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined };
