export const MAX_STREAM_FRAME_CHARS = 1024 * 1024;

function releaseReader(reader) {
  try { reader?.releaseLock?.(); } catch { /* cancellation may still be settling */ }
}

export class ReaderDeadlineError extends Error {
  constructor(label = "Upstream stream") {
    super(`${label} timed out`);
    this.name = "ReaderDeadlineError";
    this.code = "upstream_stream_timeout";
  }
}

function signalAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : "Request aborted");
  error.name = "AbortError";
  return error;
}

/** Read once without letting a non-cooperative stream outlive an absolute deadline. */
export async function readReaderWithDeadline(reader, { signal, deadlineAt, label = "Upstream stream" } = {}) {
  if (signal?.aborted) throw signalAbortError(signal);
  const remaining = Number(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new ReaderDeadlineError(label);

  let timer;
  let abortHandler;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ReaderDeadlineError(label)), Math.min(remaining, 2_147_483_647));
  });
  const races = [reader.read(), timeoutPromise];
  if (signal) {
    races.push(new Promise((_, reject) => {
      abortHandler = () => reject(signalAbortError(signal));
      signal.addEventListener("abort", abortHandler, { once: true });
    }));
  }

  try {
    return await Promise.race(races);
  } finally {
    clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener?.("abort", abortHandler);
  }
}

/**
 * Start cancelling an upstream reader without making a terminal response or
 * downstream cancellation wait on a non-cooperative underlying source.
 */
export function cancelReaderBestEffort(reader, reason) {
  let cancellation;
  try {
    cancellation = reader?.cancel?.(reason);
  } catch {
    releaseReader(reader);
    return;
  }

  // A native reader becomes releasable as soon as cancel closes the stream.
  // Retry after settlement for implementations that keep it locked longer.
  releaseReader(reader);
  Promise.resolve(cancellation).catch(() => {}).finally(() => releaseReader(reader));
}
