export interface PollStatusVerificationHandle<T> {
  kind: 'poll-status';
  description?: string;
  poll: () => Promise<T>;
  isVerified: (value: T) => boolean;
  isFailure?: (value: T) => boolean;
}

export type LaunchVerificationHandle<T> = PollStatusVerificationHandle<T>;

export interface PollVerificationOptions {
  intervalMs: number;
  timeoutMs: number;
}

export type PollVerificationResult<T> =
  | { status: 'verified'; value: T }
  | { status: 'failed'; value: T }
  | { status: 'timed_out' };

export function createPollStatusVerificationHandle<T>(
  handle: PollStatusVerificationHandle<T>,
): LaunchVerificationHandle<T> {
  return handle;
}

export async function pollVerificationHandle<T>(
  handle: LaunchVerificationHandle<T>,
  options: PollVerificationOptions,
): Promise<PollVerificationResult<T>> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await handle.poll();
    if (handle.isVerified(value)) return { status: 'verified', value };
    if (handle.isFailure?.(value)) return { status: 'failed', value };
    if (Date.now() >= deadline) return { status: 'timed_out' };
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
