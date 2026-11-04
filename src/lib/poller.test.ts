import { expect } from 'chai';
import { Poller, TRIGGER_DELAY_MS, type TimerApi } from './poller';

function fakeTimers(): { api: TimerApi; pending: Map<number, { fn: () => void; ms: number }>; fire: () => number } {
    const pending = new Map<number, { fn: () => void; ms: number }>();
    let next = 1;
    return {
        pending,
        api: {
            set: (fn, ms) => {
                pending.set(next, { fn, ms });
                return next++;
            },
            clear: handle => pending.delete(handle as number),
        },
        fire: () => {
            const [handle, timer] = [...pending][0];
            pending.delete(handle);
            timer.fn();
            return timer.ms;
        },
    };
}

describe('Poller', () => {
    function deferred(): { promise: Promise<void>; resolve: () => void } {
        let resolve!: () => void;
        const promise = new Promise<void>(r => (resolve = r));
        return { promise, resolve };
    }
    const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

    it('runs at once, then once per interval, never overlapping', async () => {
        const timers = fakeTimers();
        let runs = 0;
        let current = deferred();
        const poller = new Poller(() => (runs++, current.promise), 30_000, timers.api);
        poller.start();
        expect(timers.fire()).to.equal(0);
        expect(runs).to.equal(1);
        expect(timers.pending.size).to.equal(0); // no rearm while the run is pending
        current.resolve();
        await flush();
        expect([...timers.pending.values()].map(t => t.ms)).to.deep.equal([30_000]);
        current = deferred();
        timers.fire();
        expect(runs).to.equal(2);
    });

    it('runs once more right after a run when triggered during it', async () => {
        const timers = fakeTimers();
        const current = deferred();
        const poller = new Poller(() => current.promise, 30_000, timers.api);
        poller.start();
        timers.fire();
        poller.trigger();
        poller.trigger();
        current.resolve();
        await flush();
        expect([...timers.pending.values()].map(t => t.ms)).to.deep.equal([0]);
    });

    it('moves the next run forward when triggered while idle', async () => {
        const timers = fakeTimers();
        const poller = new Poller(() => Promise.resolve(), 30_000, timers.api);
        poller.start();
        timers.fire();
        await flush();
        poller.trigger();
        expect([...timers.pending.values()].map(t => t.ms)).to.deep.equal([TRIGGER_DELAY_MS]);
    });

    it('does not rearm after stop, even when stopped during a run', async () => {
        const timers = fakeTimers();
        const current = deferred();
        const poller = new Poller(() => current.promise, 30_000, timers.api);
        poller.start();
        timers.fire();
        poller.stop();
        poller.trigger();
        current.resolve();
        await flush();
        expect(timers.pending.size).to.equal(0);
    });

    it('keeps polling when a run throws', async () => {
        const timers = fakeTimers();
        const poller = new Poller(() => Promise.reject(new Error('boom')), 30_000, timers.api);
        poller.start();
        timers.fire();
        await flush();
        expect(timers.pending.size).to.equal(1);
    });
});
