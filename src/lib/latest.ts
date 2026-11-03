/**
 * Wraps an async job so at most one run is in flight and at most one value waits.
 * A value submitted while busy replaces the waiting one (latest wins).
 *
 * @param run - Job to run per value
 * @param onError - Receives a rejection of `run`; the waiting value still runs afterwards
 */
export function latestOnly<T>(run: (value: T) => Promise<void>, onError: (err: unknown) => void): (value: T) => void {
    let busy = false;
    let pending: { value: T } | undefined;
    const start = (value: T): void => {
        busy = true;
        run(value)
            .catch(onError)
            .finally(() => {
                busy = false;
                const next = pending;
                pending = undefined;
                if (next) {
                    start(next.value);
                }
            });
    };
    return value => {
        if (busy) {
            pending = { value };
        } else {
            start(value);
        }
    };
}
