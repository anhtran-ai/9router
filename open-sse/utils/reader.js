function releaseReader(reader) {
  try { reader?.releaseLock?.(); } catch { /* cancellation may still be settling */ }
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
