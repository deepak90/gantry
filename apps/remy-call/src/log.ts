/**
 * One JSON line per event on stdout: `REMY {"event":…,"t":…}`. The job runs in a child process
 * that shares the worker's stdout, so a test harness can follow a call by reading these lines.
 */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`REMY ${JSON.stringify({ event, t: Date.now(), ...fields })}\n`);
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}
