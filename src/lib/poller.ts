export const TRIGGER_DELAY_MS = 500;

/** Timer functions of the adapter, injected so tests can fake them. */
export interface TimerApi {
    /** Starts a one-shot timer. */
    set(fn: () => void, ms: number): unknown;
    /** Cancels a timer returned by `set`. */
    clear(handle: unknown): void;
}

/**
 * Runs `run` at once and then `intervalMs` after each run ended, so runs never overlap.
 * `trigger()` pulls the next run forward (debounced); `stop()` prevents any further run.
 */
export class Poller {
    private handle: unknown;
    private running = false;
    private again = false;
    private stopped = false;

    /**
     * @param run one poll cycle; reports its own errors
     * @param intervalMs pause between the end of a run and the next one
     * @param timers timer functions
     */
    constructor(
        private readonly run: () => Promise<void>,
        private readonly intervalMs: number,
        private readonly timers: TimerApi,
    ) {}

    /** Schedules the first run at once. */
    start(): void {
        this.schedule(0);
    }

    /** Pulls the next run forward, or queues one more if a run is active. */
    trigger(): void {
        if (this.running) {
            this.again = true;
        } else {
            this.schedule(TRIGGER_DELAY_MS);
        }
    }

    /** Prevents any further run. */
    stop(): void {
        this.stopped = true;
        if (this.handle !== undefined) {
            this.timers.clear(this.handle);
            this.handle = undefined;
        }
    }

    private schedule(ms: number): void {
        if (this.stopped) {
            return;
        }
        if (this.handle !== undefined) {
            this.timers.clear(this.handle);
        }
        this.handle = this.timers.set(() => {
            this.handle = undefined;
            void this.tick();
        }, ms);
    }

    private async tick(): Promise<void> {
        this.running = true;
        try {
            await this.run();
        } catch {
            // run() reports its own errors; the loop must survive them
        } finally {
            this.running = false;
        }
        const again = this.again;
        this.again = false;
        this.schedule(again ? 0 : this.intervalMs);
    }
}
