// Async mutex (Promise-chain based) — replaces the busy-wait synchronous lock
// in the old scheduler.ts (acquireFileLockSync used `while (fileLock.held) {}`
// which blocked the Electron main-process event loop).

export type LockedFn = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Creates a serializing mutex.
 * All calls to the returned `locked()` function are queued and run one at a
 * time in FIFO order, regardless of how long each async operation takes.
 */
export function createMutex(): LockedFn {
  let chain: Promise<void> = Promise.resolve();

  return async function locked<T>(fn: () => Promise<T>): Promise<T> {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const prev = chain;
    chain = gate;
    await prev;
    try {
      return await fn();
    } finally {
      resolve();
    }
  };
}
