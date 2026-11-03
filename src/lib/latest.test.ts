import { expect } from 'chai';
import { latestOnly } from './latest';

interface Job {
    value: number;
    resolve: () => void;
    reject: (err: Error) => void;
}

function setup(): { submit: (v: number) => void; jobs: Job[]; errors: unknown[]; maxParallel: () => number } {
    const jobs: Job[] = [];
    const errors: unknown[] = [];
    let running = 0;
    let max = 0;
    const submit = latestOnly<number>(
        value =>
            new Promise<void>((resolve, reject) => {
                running++;
                max = Math.max(max, running);
                jobs.push({
                    value,
                    resolve: () => {
                        running--;
                        resolve();
                    },
                    reject: err => {
                        running--;
                        reject(err);
                    },
                });
            }),
        err => errors.push(err),
    );
    return { submit, jobs, errors, maxParallel: () => max };
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('latestOnly', () => {
    it('runs immediately when idle', () => {
        const { submit, jobs } = setup();
        submit(1);
        expect(jobs.map(j => j.value)).to.deep.equal([1]);
    });

    it('runs only the newest value submitted while busy, never two at once', async () => {
        const { submit, jobs, maxParallel } = setup();
        submit(1);
        submit(2);
        submit(3);
        expect(jobs).to.have.length(1);
        jobs[0].resolve();
        await tick();
        expect(jobs.map(j => j.value)).to.deep.equal([1, 3]);
        jobs[1].resolve();
        await tick();
        expect(jobs).to.have.length(2);
        expect(maxParallel()).to.equal(1);
    });

    it('goes idle after the pending run and runs the next value at once', async () => {
        const { submit, jobs } = setup();
        submit(1);
        jobs[0].resolve();
        await tick();
        submit(2);
        expect(jobs.map(j => j.value)).to.deep.equal([1, 2]);
    });

    it('reports a rejection and still runs the pending value', async () => {
        const { submit, jobs, errors } = setup();
        submit(1);
        submit(2);
        const boom = new Error('boom');
        jobs[0].reject(boom);
        await tick();
        expect(errors).to.deep.equal([boom]);
        expect(jobs.map(j => j.value)).to.deep.equal([1, 2]);
    });
});
