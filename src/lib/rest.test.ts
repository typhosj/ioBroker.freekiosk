import { expect } from 'chai';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    fetchImage,
    fetchStatus,
    HttpError,
    Poller,
    sendRest,
    STATUS_MAX_BYTES,
    TRIGGER_DELAY_MS,
    type RestTarget,
    type TimerApi,
} from './rest';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

let server: Server;
let handler: Handler;
let target: RestTarget;
const never = new AbortController().signal;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected a rejection');
}

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

describe('rest client', () => {
    before(async () => {
        server = createServer((req, res) => {
            let body = '';
            req.on('data', chunk => (body += String(chunk)));
            req.on('end', () => handler(req, body, res));
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port, apiKey: 'k3y' };
    });
    after(() => {
        server.closeAllConnections();
        server.close();
    });

    it('returns the data of a successful status and sends the API key', async () => {
        let key: string | undefined;
        handler = (req, _body, res) => {
            key = req.headers['x-api-key'] as string;
            expect(req.url).to.equal('/api/status');
            json(res, 200, { success: true, data: { battery: { level: 5 } }, timestamp: 1 });
        };
        expect(await fetchStatus(target, never)).to.deep.equal({ battery: { level: 5 } });
        expect(key).to.equal('k3y');
    });

    it('omits the API key header when none is set', async () => {
        let headers: IncomingMessage['headers'] = {};
        handler = (req, _body, res) => {
            headers = req.headers;
            json(res, 200, { success: true, data: {} });
        };
        await fetchStatus({ ...target, apiKey: '' }, never);
        expect(headers).not.to.have.property('x-api-key');
    });

    it('turns 401 into an HttpError', async () => {
        handler = (_req, _body, res) => json(res, 401, { success: false, error: 'Invalid or missing API key' });
        const err = await rejection(fetchStatus(target, never));
        expect(err).to.be.instanceOf(HttpError);
        expect((err as HttpError).status).to.equal(401);
        expect((err as HttpError).message).to.contain('Invalid or missing API key');
    });

    it('rejects broken JSON, success false and a missing data object', async () => {
        for (const send of [
            (res: ServerResponse) => res.writeHead(200).end('{broken'),
            (res: ServerResponse) => json(res, 200, { success: false, error: 'x' }),
            (res: ServerResponse) => json(res, 200, { success: true, data: [] }),
        ]) {
            handler = (_req, _body, res) => send(res);
            expect(await rejection(fetchStatus(target, never))).to.be.instanceOf(Error);
        }
    });

    it('keeps the response body out of the JSON error', async () => {
        handler = (_req, _body, res) => res.writeHead(200).end('secret-token {broken');
        expect(String(await rejection(fetchStatus(target, never)))).not.to.contain('secret-token');
    });

    it('makes the error text of FreeKiosk printable and bounded', async () => {
        handler = (_req, _body, res) =>
            json(res, 500, { success: false, error: `bad\nline\u001b[31m\u0000${'x'.repeat(300)}` });
        const message = (await rejection(fetchStatus(target, never))) as HttpError;
        expect(message.message).to.equal(`HTTP 500: bad?line?[31m?${'x'.repeat(200 - 14)}`);
    });

    it('refuses redirects so the API key stays on the tablet', async () => {
        handler = (req, _body, res) => {
            if (req.url === '/api/status') {
                res.writeHead(302, { Location: '/api/status-real' }).end();
            } else {
                json(res, 200, { success: true, data: { ok: true } });
            }
        };
        expect(await rejection(fetchStatus(target, never))).to.be.instanceOf(Error);
    });

    it('rejects a streamed body over the limit without Content-Length', async () => {
        handler = (_req, _body, res) => {
            res.writeHead(200);
            for (let i = 0; i < 5; i++) {
                res.write('x'.repeat(STATUS_MAX_BYTES / 4));
            }
            res.end();
        };
        expect(String(await rejection(fetchStatus(target, never)))).to.contain('larger than');
    });

    it('accepts a command answer larger than the error limit', async () => {
        handler = (_req, _body, res) => res.writeHead(200).end('x'.repeat(10_000));
        await sendRest(target, { method: 'POST', path: '/api/reload' }, never);
    });

    it('rejects a status body over the size limit', async () => {
        handler = (_req, _body, res) => res.writeHead(200).end('x'.repeat(STATUS_MAX_BYTES + 1));
        expect(String(await rejection(fetchStatus(target, never)))).to.contain('larger than');
    });

    it('times out a tablet that does not answer', async () => {
        handler = () => undefined;
        const started = Date.now();
        expect(await rejection(fetchStatus(target, never, 100))).to.be.instanceOf(Error);
        expect(Date.now() - started).to.be.lessThan(2000);
    });

    it('aborts when the adapter stops', async () => {
        handler = () => undefined;
        const controller = new AbortController();
        const pending = rejection(fetchStatus(target, controller.signal));
        controller.abort();
        expect(await pending).to.be.instanceOf(Error);
    });

    it('posts command bodies and reports 403', async () => {
        let seen = '';
        handler = (req, body, res) => {
            seen = `${req.method} ${req.url} ${req.headers['content-type']} ${body}`;
            json(res, 200, { success: true, data: {} });
        };
        await sendRest(target, { method: 'POST', path: '/api/brightness', body: { value: 40 } }, never);
        expect(seen).to.equal('POST /api/brightness application/json {"value":40}');
        await sendRest(target, { method: 'GET', path: '/api/remote/keyboard?map=ctrl%2Bc' }, never);
        expect(seen).to.equal('GET /api/remote/keyboard?map=ctrl%2Bc undefined ');
        handler = (_req, _body, res) => json(res, 403, { success: false, error: 'Remote control is disabled' });
        expect(
            ((await rejection(sendRest(target, { method: 'POST', path: '/api/reload' }, never))) as HttpError).status,
        ).to.equal(403);
    });

    it('downloads images and maps the content type', async () => {
        handler = (req, _body, res) => {
            const png = req.url === '/api/screenshot';
            res.writeHead(200, { 'Content-Type': png ? 'image/png' : 'image/jpeg' }).end(Buffer.from([1, 2, 3]));
        };
        expect(await fetchImage(target, 'screenshot', never)).to.deep.equal({
            data: Buffer.from([1, 2, 3]),
            ext: 'png',
        });
        let url = '';
        handler = (req, _body, res) => {
            url = req.url ?? '';
            res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.from([9]));
        };
        expect((await fetchImage(target, 'cameraFront', never)).ext).to.equal('jpg');
        expect(url).to.equal('/api/camera/photo?camera=front');
        handler = (_req, _body, res) => json(res, 503, { success: false, error: 'Screenshot not available' });
        expect(((await rejection(fetchImage(target, 'screenshot', never))) as HttpError).status).to.equal(503);
        handler = (_req, _body, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>');
        expect(String(await rejection(fetchImage(target, 'screenshot', never)))).to.contain('not an image');
    });

    it('brackets IPv6 hosts', async () => {
        const v6 = createServer((_req, res) => json(res, 200, { success: true, data: { ok: true } }));
        await new Promise<void>(resolve => v6.listen(0, '::1', resolve));
        try {
            const port = (v6.address() as AddressInfo).port;
            expect(await fetchStatus({ host: '::1', port, apiKey: '' }, never)).to.deep.equal({ ok: true });
        } finally {
            v6.close();
        }
    });
});

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
