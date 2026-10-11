/**
 * Share one live subscription per key. The first subscriber starts it, the last unsubscribe stops it, so several
 * components (or a StrictMode remount) can ask for the same conversation without duplicating its events.
 */
export const makeSharedSubscriptions = <K>(start: (key: K) => () => void) => {
  const live = new Map<K, { count: number; stop: () => void }>();
  return (key: K): (() => void) => {
    const existing = live.get(key);
    if (existing === undefined) {
      live.set(key, { count: 1, stop: start(key) });
    } else {
      existing.count += 1;
    }
    let released = false;
    return () => {
      const entry = live.get(key);
      if (released || entry === undefined) {
        return;
      }
      released = true;
      entry.count -= 1;
      if (entry.count === 0) {
        live.delete(key);
        entry.stop();
      }
    };
  };
};
