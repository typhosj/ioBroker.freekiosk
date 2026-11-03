import { createHash, timingSafeEqual } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { Aedes, type AedesPublishPacket, type Client } from 'aedes';
import type { ImageKind } from './commands';

export const STATE_MAX_BYTES = 64 * 1024;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Bytes a connection may send before its login succeeded. */
export const PRELOGIN_MAX_BYTES = 64 * 1024;

/** Distinct unknown topic ids, or refused addresses, reported before further ones are ignored silently. */
const UNKNOWN_MAX = 100;

const IMAGE_SUFFIXES = new Map<string, ImageKind>([
    ['image/screenshot', 'screenshot'],
    ['image/camera_front', 'cameraFront'],
    ['image/camera_back', 'cameraBack'],
]);

/** Settings the broker runs with. */
export interface BrokerOptions {
    /** TCP port; 0 picks a free one */
    port: number;
    /** First topic level of every tablet topic */
    baseTopic: string;
    /** Login of all tablets */
    user: string;
    /** Password of all tablets */
    password: string;
    /** Topic ids of the configured tablets */
    topicIds: string[];
}

/** Callbacks the broker reports to. */
export interface BrokerEvents {
    /** Parsed `state` message of a tablet */
    status(topicId: string, raw: unknown): void;
    /** Tablet went online or offline */
    online(topicId: string, online: boolean): void;
    /** Image payload of a tablet */
    image(topicId: string, kind: ImageKind, data: Buffer): void;
    /** Once per unknown topic id */
    unknownTablet(topicId: string): void;
    /** Once per tablet and reason */
    dropped(topicId: string, reason: string): void;
    /** Once per remote address whose MQTT login was refused */
    loginRefused(address: string): void;
    /** Server level failure */
    error(err: Error): void;
}

/**
 * Splits `<base>/<topicId>/<suffix>`; undefined for any other topic.
 *
 * @param baseTopic first topic level(s)
 * @param topic received topic
 */
export function parseTopic(baseTopic: string, topic: string): { topicId: string; suffix: string } | undefined {
    const prefix = `${baseTopic}/`;
    if (!topic.startsWith(prefix)) {
        return undefined;
    }
    const rest = topic.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) {
        return undefined;
    }
    return { topicId: rest.slice(0, slash), suffix: rest.slice(slash + 1) };
}

/**
 * SHA-256 of a value, so comparisons run over equal lengths.
 *
 * @param value text or bytes to hash
 */
function digest(value: string | Buffer): Buffer {
    return createHash('sha256').update(value).digest();
}

/**
 * Printable, bounded form of an untrusted topic id for log lines.
 *
 * @param text untrusted text
 */
function printable(text: string): string {
    return text.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
}

/**
 * 'readable' listener on every new connection until its login succeeded. aedes reads the socket
 * in paused mode ('readable' + read()), so a second 'readable' listener neither switches the
 * stream to flowing mode nor consumes bytes; it only looks at the received byte count.
 *
 * @param this the connection
 */
function preLoginGuard(this: Socket): void {
    if (this.bytesRead > PRELOGIN_MAX_BYTES) {
        this.destroy();
    }
}

/**
 * MQTT broker for FreeKiosk tablets. Requires a login, binds every client to the topic id it
 * first uses, keeps no retained messages, and hands status, availability and images to `events`.
 */
export class Broker {
    private readonly owner = new Map<string, Client>();
    private readonly boundTo = new WeakMap<Client, string>();
    /** Clients subscribed to their `set/#`; FreeKiosk subscribes only with remote control allowed. */
    private readonly listening = new WeakSet<Client>();
    private readonly availability = new Map<string, string>();
    private readonly lastOnline = new Map<string, boolean>();
    private readonly reported = new Set<string>();
    private readonly unknownSeen = new Set<string>();
    private readonly refusedSeen = new Set<string>();
    private readonly known: Set<string>;
    private readonly userHash: Buffer;
    private readonly passwordHash: Buffer;

    private constructor(
        private readonly aedes: Aedes,
        private readonly server: Server,
        private readonly sockets: Set<Socket>,
        private readonly opts: BrokerOptions,
        private readonly events: BrokerEvents,
    ) {
        this.known = new Set(opts.topicIds);
        this.userHash = digest(opts.user);
        this.passwordHash = digest(opts.password);

        aedes.authenticate = (client, username, password, done) => {
            const userOk = timingSafeEqual(digest(username ?? ''), this.userHash);
            const passwordOk = timingSafeEqual(digest(password ? password.toString() : ''), this.passwordHash);
            const ok = username !== undefined && password !== undefined && userOk && passwordOk;
            const conn = client.conn as Socket;
            if (ok) {
                conn.off('readable', preLoginGuard);
            } else {
                const address = conn.remoteAddress ?? 'unknown address';
                if (!this.refusedSeen.has(address) && this.refusedSeen.size < UNKNOWN_MAX) {
                    this.refusedSeen.add(address);
                    this.events.loginRefused(address);
                }
            }
            done(null, ok);
        };
        aedes.authorizePublish = (client, packet, done) => {
            if (!client) {
                done(null);
                return;
            }
            // The adapter consumes every message directly; the broker keeps nothing in memory.
            packet.retain = false;
            const parsed = parseTopic(this.opts.baseTopic, packet.topic);
            if (!parsed) {
                done(null); // e.g. Home Assistant discovery: accepted and ignored
                return;
            }
            if (!this.known.has(parsed.topicId)) {
                const name = printable(parsed.topicId);
                // Bounded: a client may invent any number of topic ids.
                if (!this.unknownSeen.has(name) && this.unknownSeen.size < UNKNOWN_MAX) {
                    this.unknownSeen.add(name);
                    this.events.unknownTablet(name);
                }
                done(null);
                return;
            }
            done(this.bind(client, parsed.topicId));
        };
        aedes.authorizeSubscribe = (client, subscription, done) => {
            const parsed = parseTopic(this.opts.baseTopic, subscription.topic);
            const allowed =
                parsed !== undefined &&
                parsed.suffix === 'set/#' &&
                this.known.has(parsed.topicId) &&
                this.bind(client, parsed.topicId) === null;
            done(null, allowed ? subscription : null);
        };
        aedes.on('subscribe', (subscriptions, client) => {
            // aedes reports a refused subscription with qos 128, outside the typed QoS range.
            if (subscriptions.some(s => (s.qos as number) !== 128 && s.topic === this.commandFilter(client))) {
                this.listening.add(client);
            }
        });
        aedes.on('unsubscribe', (topics, client) => {
            const filter = this.commandFilter(client);
            if (filter !== undefined && topics.includes(filter)) {
                this.listening.delete(client);
            }
        });
        aedes.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
            if (client) {
                this.onPublish(packet, client);
            }
        });
        // aedes is an EventEmitter whose typings omit 'error'; without a listener it would crash the adapter.
        (aedes as EventEmitter).on('error', (err: Error) => events.error(err));
        aedes.on('clientDisconnect', (client: Client) => {
            const topicId = this.boundTo.get(client);
            if (topicId !== undefined && this.owner.get(topicId) === client) {
                this.owner.delete(topicId);
                this.availability.delete(topicId);
                this.emitOnline(topicId);
            }
        });
    }

    /**
     * Starts the broker; rejects when the port cannot be bound.
     *
     * @param opts broker settings
     * @param events callbacks for tablet traffic
     */
    static async start(opts: BrokerOptions, events: BrokerEvents): Promise<Broker> {
        const aedes = await Aedes.createBroker();
        // aedes.close() ends only clients that sent CONNECT; close() destroys the rest itself.
        const sockets = new Set<Socket>();
        const server = createServer(socket => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
            // Registered before aedes' own listener, so the guard sees each chunk first.
            socket.on('readable', preLoginGuard);
            aedes.handle(socket);
        });
        server.maxConnections = opts.topicIds.length + 5;
        const broker = new Broker(aedes, server, sockets, opts, events);
        try {
            await new Promise<void>((resolve, reject) => {
                server.once('error', reject);
                server.listen(opts.port, () => {
                    server.off('error', reject);
                    resolve();
                });
            });
        } catch (err) {
            await new Promise<void>(resolve => aedes.close(() => resolve()));
            throw err;
        }
        server.on('error', err => events.error(err));
        return broker;
    }

    /** Port the server listens on */
    get port(): number {
        return (this.server.address() as AddressInfo).port;
    }

    /**
     * True while the tablet holds a connection and announced itself online.
     *
     * @param topicId tablet topic id
     */
    isOnline(topicId: string): boolean {
        return this.owner.has(topicId) && this.availability.get(topicId) === 'online';
    }

    /**
     * Publishes a command to `<base>/<topicId>/set/<entity>` with QoS 1, not retained. Rejects when
     * the tablet is offline or does not subscribe to its commands.
     *
     * @param topicId tablet topic id
     * @param entity command name
     * @param payload command value
     */
    async publish(topicId: string, entity: string, payload: string): Promise<void> {
        if (!this.isOnline(topicId)) {
            throw new Error('tablet is not connected');
        }
        const owner = this.owner.get(topicId);
        if (!owner || !this.listening.has(owner)) {
            throw new Error('tablet takes no commands; turn on "Allow remote control" in FreeKiosk');
        }
        await new Promise<void>((resolve, reject) => {
            this.aedes.publish(
                {
                    cmd: 'publish',
                    topic: `${this.opts.baseTopic}/${topicId}/set/${entity}`,
                    payload: Buffer.from(payload),
                    qos: 1,
                    retain: false,
                    dup: false,
                },
                err => (err ? reject(err) : resolve()),
            );
        });
    }

    /** Stops the broker and drops all clients. */
    async close(): Promise<void> {
        await new Promise<void>(resolve => this.aedes.close(() => resolve()));
        for (const socket of this.sockets) {
            socket.destroy();
        }
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    private commandFilter(client: Client): string | undefined {
        const topicId = this.boundTo.get(client);
        return topicId === undefined ? undefined : `${this.opts.baseTopic}/${topicId}/set/#`;
    }

    private bind(client: Client, topicId: string): Error | null {
        const bound = this.boundTo.get(client);
        if (bound !== undefined) {
            return bound === topicId ? null : new Error('client is bound to another topic id');
        }
        const current = this.owner.get(topicId);
        // The same client id reconnecting replaces its old session; a different one is refused.
        if (current && current !== client && current.id !== client.id) {
            return new Error('topic id is in use by another client');
        }
        this.boundTo.set(client, topicId);
        this.owner.set(topicId, client);
        return null;
    }

    // Known limit: mqtt-packet buffers a whole packet before aedes sees it, so the size limits
    // below apply after parsing. Before login a connection is closed after PRELOGIN_MAX_BYTES,
    // so an oversized packet is only possible for a client that logged in.
    private onPublish(packet: AedesPublishPacket, client: Client): void {
        const parsed = parseTopic(this.opts.baseTopic, packet.topic);
        // A late will of a replaced session no longer owns the topic id and is ignored.
        if (!parsed || !this.known.has(parsed.topicId) || this.owner.get(parsed.topicId) !== client) {
            return;
        }
        const { topicId, suffix } = parsed;
        const payload = Buffer.isBuffer(packet.payload) ? packet.payload : Buffer.from(packet.payload);
        const kind = IMAGE_SUFFIXES.get(suffix);
        if (!kind && suffix !== 'availability' && suffix !== 'state') {
            return; // unknown suffix: nothing to size-check or report
        }
        if (kind && !payload.length) {
            return; // FreeKiosk clears the retained image of a disabled stream; the last image stays
        }
        const limit = kind ? IMAGE_MAX_BYTES : STATE_MAX_BYTES;
        if (payload.length > limit) {
            const what = kind ? 'image' : 'state';
            this.once(`size-${what}:${topicId}`, () =>
                this.events.dropped(topicId, `${what} of ${payload.length} bytes is over the limit of ${limit}`),
            );
            return;
        }
        if (suffix === 'availability') {
            this.availability.set(topicId, payload.toString());
            this.emitOnline(topicId);
        } else if (suffix === 'state') {
            let raw: unknown;
            try {
                raw = JSON.parse(payload.toString());
            } catch {
                this.once(`json:${topicId}`, () => this.events.dropped(topicId, 'state is not valid JSON'));
                return;
            }
            this.events.status(topicId, raw);
        } else if (kind) {
            this.events.image(topicId, kind, payload);
        }
    }

    private emitOnline(topicId: string): void {
        const online = this.isOnline(topicId);
        if (this.lastOnline.get(topicId) !== online) {
            this.lastOnline.set(topicId, online);
            this.events.online(topicId, online);
        }
    }

    private once(key: string, report: () => void): void {
        if (!this.reported.has(key)) {
            this.reported.add(key);
            report();
        }
    }
}
