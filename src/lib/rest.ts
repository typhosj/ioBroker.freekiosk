import { isIPv6 } from 'node:net';
import type { ImageKind, RestRequest } from './commands';
import { isObject } from './config';

export const STATUS_TIMEOUT_MS = 5_000;
export const COMMAND_TIMEOUT_MS = 10_000;
export const STATUS_MAX_BYTES = 256 * 1024;
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const TRIGGER_DELAY_MS = 500;
const ERROR_MAX_BYTES = 4096;

/** Where a tablet listens and the key it expects. */
export interface RestTarget {
    /** Hostname or IP address. */
    host: string;
    /** REST port. */
    port: number;
    /** API key; empty when the tablet needs none. */
    apiKey: string;
}

/** A non-2xx answer from the tablet, with FreeKiosk's error text where it sent one. */
export class HttpError extends Error {
    /**
     * @param status HTTP status code of the answer
     * @param message error text for logs
     */
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

const IMAGE_PATHS: Record<ImageKind, string> = {
    screenshot: '/api/screenshot',
    cameraFront: '/api/camera/photo?camera=front',
    cameraBack: '/api/camera/photo?camera=back',
};

async function request(
    target: RestTarget,
    req: RestRequest,
    signal: AbortSignal,
    timeoutMs: number,
    maxBytes: number,
): Promise<{ type: string; body: Buffer }> {
    const host = isIPv6(target.host) ? `[${target.host}]` : target.host;
    const headers: Record<string, string> = {};
    if (target.apiKey) {
        headers['X-Api-Key'] = target.apiKey;
    }
    if (req.body) {
        headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`http://${host}:${target.port}${req.path}`, {
        method: req.method,
        headers,
        body: req.body ? JSON.stringify(req.body) : undefined,
        redirect: 'error', // the API key must never follow a redirect to another origin
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (response.ok && maxBytes === 0) {
        await response.body?.cancel(); // a command answer is not needed, only its status
        return { type: '', body: Buffer.alloc(0) };
    }
    const body = await readLimited(response, response.ok ? maxBytes : ERROR_MAX_BYTES);
    if (!response.ok) {
        throw new HttpError(response.status, `HTTP ${response.status}: ${errorText(body)}`);
    }
    return { type: response.headers.get('content-type') ?? '', body };
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) {
        await response.body?.cancel();
        throw new Error(`response is larger than ${maxBytes} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body) {
        // Leaving the loop by throwing cancels the stream; an explicit cancel() would hit the lock.
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > maxBytes) {
                throw new Error(`response is larger than ${maxBytes} bytes`);
            }
            chunks.push(chunk);
        }
    }
    return Buffer.concat(chunks);
}

function errorText(body: Buffer): string {
    try {
        const parsed: unknown = JSON.parse(body.toString());
        if (isObject(parsed) && typeof parsed.error === 'string') {
            return parsed.error.slice(0, 200);
        }
    } catch {
        // not JSON: fall through to the generic text
    }
    return 'no error text';
}

/**
 * GET /api/status; resolves with FreeKiosk's `data` object.
 *
 * @param target tablet to ask
 * @param signal aborts the request when the adapter stops
 * @param timeoutMs request timeout
 */
export async function fetchStatus(
    target: RestTarget,
    signal: AbortSignal,
    timeoutMs = STATUS_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
    const { body } = await request(target, { method: 'GET', path: '/api/status' }, signal, timeoutMs, STATUS_MAX_BYTES);
    let parsed: unknown;
    try {
        parsed = JSON.parse(body.toString());
    } catch {
        throw new Error('status answer is not valid JSON'); // the parser message quotes the body
    }
    if (!isObject(parsed) || parsed.success !== true || !isObject(parsed.data)) {
        throw new Error('status answer has no success flag or no data object');
    }
    return parsed.data;
}

/**
 * Sends one command; resolves on HTTP 2xx.
 *
 * @param target tablet to command
 * @param req method, path and optional JSON body
 * @param signal aborts the request when the adapter stops
 * @param timeoutMs request timeout
 */
export async function sendRest(
    target: RestTarget,
    req: RestRequest,
    signal: AbortSignal,
    timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<void> {
    await request(target, req, signal, timeoutMs, 0);
}

/**
 * Downloads a screenshot (PNG) or camera photo (JPEG).
 *
 * @param target tablet to ask
 * @param kind which image to fetch
 * @param signal aborts the request when the adapter stops
 * @param timeoutMs request timeout
 */
export async function fetchImage(
    target: RestTarget,
    kind: ImageKind,
    signal: AbortSignal,
    timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<{ data: Buffer; ext: 'png' | 'jpg' }> {
    const { type, body } = await request(
        target,
        { method: 'GET', path: IMAGE_PATHS[kind] },
        signal,
        timeoutMs,
        IMAGE_MAX_BYTES,
    );
    if (type.startsWith('image/png')) {
        return { data: body, ext: 'png' };
    }
    if (type.startsWith('image/jpeg')) {
        return { data: body, ext: 'jpg' };
    }
    throw new Error(`tablet answered "${type.slice(0, 40)}", not an image`);
}

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
