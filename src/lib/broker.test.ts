import { expect } from 'chai';
import type { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { connectAsync, type IClientOptions, type MqttClient } from 'mqtt';
import { Broker, parseTopic, STATE_MAX_BYTES, type BrokerEvents } from './broker';

type Call = [string, ...unknown[]];

function recorder(): { calls: Call[]; events: BrokerEvents } {
    const calls: Call[] = [];
    const events: BrokerEvents = {
        status: (...a) => calls.push(['status', ...a]),
        online: (...a) => calls.push(['online', ...a]),
        image: (...a) => calls.push(['image', ...a]),
        unknownTablet: (...a) => calls.push(['unknownTablet', ...a]),
        dropped: (...a) => calls.push(['dropped', ...a]),
        loginRefused: (...a) => calls.push(['loginRefused', ...a]),
        error: (...a) => calls.push(['error', ...a]),
    };
    return { calls, events };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
        if (Date.now() > end) {
            throw new Error('condition not reached');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function aedesOf(broker: Broker): EventEmitter {
    return (broker as unknown as { aedes: EventEmitter }).aedes;
}

async function rejection(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (err) {
        return String(err);
    }
    throw new Error('expected a rejection');
}

function willPacket(topic: string, payload: string): Record<string, unknown> {
    return { cmd: 'publish', topic, payload: Buffer.from(payload), qos: 1, retain: false, dup: false };
}

describe('parseTopic', () => {
    it('splits base, topic id and suffix', () => {
        expect(parseTopic('freekiosk', 'freekiosk/lobby/state')).to.deep.equal({ topicId: 'lobby', suffix: 'state' });
        expect(parseTopic('a/b', 'a/b/lobby/image/screenshot')).to.deep.equal({
            topicId: 'lobby',
            suffix: 'image/screenshot',
        });
        for (const topic of [
            'freekiosk/lobby',
            'freekiosk//state',
            'freekiosk/lobby/',
            'other/lobby/state',
            'freekiosklobby/state',
        ]) {
            expect(parseTopic('freekiosk', topic), topic).to.equal(undefined);
        }
    });
});

describe('Broker', () => {
    let broker: Broker;
    let rec: ReturnType<typeof recorder>;
    const clients: MqttClient[] = [];

    async function tablet(options: IClientOptions = {}): Promise<MqttClient> {
        const client = await connectAsync(`mqtt://127.0.0.1:${broker.port}`, {
            username: 'iob',
            password: 'secret',
            reconnectPeriod: 0,
            protocolVersion: 4,
            ...options,
        });
        clients.push(client);
        return client;
    }

    beforeEach(async () => {
        rec = recorder();
        broker = await Broker.start(
            { port: 0, baseTopic: 'freekiosk', user: 'iob', password: 'secret', topicIds: ['kitchen', 'hall'] },
            rec.events,
        );
    });
    afterEach(async () => {
        for (const client of clients.splice(0)) {
            client.end(true);
        }
        await broker.close();
    });

    it('refuses a wrong login and anonymous clients', async () => {
        for (const options of [{ password: 'wrong' }, { username: undefined, password: undefined }]) {
            let refused = false;
            try {
                await tablet(options);
            } catch {
                refused = true;
            }
            expect(refused, JSON.stringify(options)).to.equal(true);
        }
        // Reported once per address, without user or password.
        expect(rec.calls.filter(c => c[0] === 'loginRefused')).to.have.length(1);
        expect(String(rec.calls.find(c => c[0] === 'loginRefused')?.[1])).to.match(/127\.0\.0\.1$/);
        expect(JSON.stringify(rec.calls)).not.to.contain('wrong');
        expect(JSON.stringify(rec.calls)).not.to.contain('iob');
    });

    it('reports availability and parsed state, and offline on disconnect', async () => {
        const client = await tablet();
        await client.publishAsync('freekiosk/kitchen/availability', 'online', { retain: true, qos: 1 });
        await client.publishAsync('freekiosk/kitchen/state', JSON.stringify({ battery: { level: 7 } }));
        await until(() => rec.calls.some(c => c[0] === 'status'));
        expect(rec.calls).to.deep.include(['online', 'kitchen', true]);
        expect(rec.calls).to.deep.include(['status', 'kitchen', { battery: { level: 7 } }]);
        expect(broker.isOnline('kitchen')).to.equal(true);
        client.end(true);
        await until(() => !broker.isOnline('kitchen'));
        expect(rec.calls.at(-1)).to.deep.equal(['online', 'kitchen', false]);
    });

    it('goes offline on the last will', async () => {
        const client = await tablet({
            will: { topic: 'freekiosk/kitchen/availability', payload: Buffer.from('offline'), qos: 1, retain: true },
        });
        await client.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen'));
        client.stream.destroy();
        await until(() => !broker.isOnline('kitchen'));
    });

    it('hands images over and drops oversize payloads once', async () => {
        const client = await tablet();
        await client.publishAsync('freekiosk/kitchen/image/camera_front', Buffer.from([1, 2]));
        await until(() => rec.calls.some(c => c[0] === 'image'));
        expect(rec.calls).to.deep.include(['image', 'kitchen', 'cameraFront', Buffer.from([1, 2])]);
        const big = 'x'.repeat(STATE_MAX_BYTES + 1);
        await client.publishAsync('freekiosk/kitchen/state', big);
        await client.publishAsync('freekiosk/kitchen/state', big);
        await client.publishAsync('freekiosk/kitchen/state', '{broken');
        await until(() => rec.calls.filter(c => c[0] === 'dropped').length === 2);
        expect(rec.calls.filter(c => c[0] === 'status')).to.have.length(0);
    });

    it('ignores the empty payload FreeKiosk sends to clear a disabled image stream', async () => {
        const client = await tablet();
        await client.publishAsync('freekiosk/kitchen/image/screenshot', Buffer.alloc(0), { retain: true });
        await client.publishAsync('freekiosk/kitchen/image/camera_back', Buffer.from([9]));
        await until(() => rec.calls.some(c => c[0] === 'image'));
        expect(rec.calls.filter(c => c[0] === 'image')).to.deep.equal([
            ['image', 'kitchen', 'cameraBack', Buffer.from([9])],
        ]);
    });

    it('ignores unknown tablets and foreign topics without disconnecting', async () => {
        const client = await tablet();
        await client.publishAsync('freekiosk/garage/state', '{}');
        await client.publishAsync('freekiosk/garage/state', '{}');
        await client.publishAsync('homeassistant/sensor/freekiosk_1/battery/config', '{}', { retain: true });
        await until(() => rec.calls.some(c => c[0] === 'unknownTablet'));
        expect(rec.calls.filter(c => c[0] === 'unknownTablet')).to.deep.equal([['unknownTablet', 'garage']]);
        expect(client.connected).to.equal(true);
    });

    it('closes a client that publishes to a $SYS/ topic, as the aedes default does', async () => {
        const client = await tablet();
        const closed = new Promise<void>(resolve => client.once('close', resolve));
        client.publish('$SYS/broker/clients/connected', '1');
        await closed;
    });

    it('binds a client to one topic id', async () => {
        const kitchen = await tablet({ clientId: 'freekiosk_a' });
        await kitchen.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen'));
        const closed = new Promise<void>(resolve => kitchen.once('close', resolve));
        kitchen.publish('freekiosk/hall/state', '{}');
        await closed;
        expect(rec.calls.filter(c => c[0] === 'status')).to.have.length(0);
    });

    it('refuses a second client on a bound topic id but lets the same client id take over', async () => {
        const first = await tablet({ clientId: 'freekiosk_a' });
        await first.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen'));
        const intruder = await tablet({ clientId: 'freekiosk_b' });
        const closed = new Promise<void>(resolve => intruder.once('close', resolve));
        intruder.publish('freekiosk/kitchen/availability', 'online');
        await closed;
        expect(broker.isOnline('kitchen')).to.equal(true);
        const again = await tablet({ clientId: 'freekiosk_a' });
        await again.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen') && again.connected);
        // A will of the replaced session that arrives this late must not overwrite availability.
        // Over the wire aedes publishes it before the new session can announce itself, so the
        // late delivery is injected on the broker's aedes instance.
        aedesOf(broker).emit('publish', willPacket('freekiosk/kitchen/availability', 'offline'), { id: 'freekiosk_a' });
        expect(broker.isOnline('kitchen')).to.equal(true);
    });

    it('reports aedes errors instead of crashing', () => {
        aedesOf(broker).emit('error', new Error('boom'));
        expect(rec.calls.filter(c => c[0] === 'error').map(c => String(c[1]))).to.deep.equal(['Error: boom']);
    });

    it('delivers commands only to the own set topic', async () => {
        const client = await tablet();
        await client.publishAsync('freekiosk/kitchen/availability', 'online');
        // mqtt.js rejects a SUBACK with a refused topic (QoS 128) and attaches the packet to the error.
        const granted = await client
            .subscribeAsync(['freekiosk/kitchen/set/#', 'freekiosk/hall/set/#', '#'])
            .catch((err: unknown) => {
                const packet = (err as { packet?: { granted?: number[] } }).packet;
                if (!packet?.granted) {
                    throw err;
                }
                return packet.granted.map(qos => ({ qos }));
            });
        expect(granted[0].qos).not.to.equal(128);
        expect(granted.slice(1).map(g => g.qos)).to.deep.equal([128, 128]);
        const received = new Promise<[string, string]>(resolve =>
            client.once('message', (topic, payload) => resolve([topic, payload.toString()])),
        );
        await until(() => broker.isOnline('kitchen'));
        await broker.publish('kitchen', 'screen', 'OFF');
        expect(await received).to.deep.equal(['freekiosk/kitchen/set/screen', 'OFF']);
    });

    it('refuses commands while the tablet does not subscribe to them', async () => {
        const client = await tablet();
        await client.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen'));
        // FreeKiosk subscribes to set/# only with "Allow remote control" on.
        expect(await rejection(broker.publish('kitchen', 'screen', 'OFF'))).to.contain('Allow remote control');
        await client.subscribeAsync('freekiosk/kitchen/set/#');
        await broker.publish('kitchen', 'screen', 'OFF');
        await client.unsubscribeAsync('freekiosk/kitchen/set/#');
        expect(await rejection(broker.publish('kitchen', 'screen', 'OFF'))).to.contain('Allow remote control');
    });

    it('ignores oversize payloads on unknown suffixes', async () => {
        const client = await tablet();
        await client.publishAsync('freekiosk/kitchen/whatever', 'x'.repeat(70 * 1024));
        await client.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen'));
        expect(rec.calls.filter(c => c[0] === 'dropped')).to.have.length(0);
    });

    it('reports at most 100 distinct unknown tablets', async () => {
        const client = await tablet();
        for (let i = 0; i < 105; i++) {
            await client.publishAsync(`freekiosk/ghost${i}/state`, '{}');
        }
        await client.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen'));
        expect(rec.calls.filter(c => c[0] === 'unknownTablet')).to.have.length(100);
    });

    it('is not online after a reconnect until it announces itself again', async () => {
        const first = await tablet({ clientId: 'freekiosk_a' });
        await first.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen'));
        first.end(true);
        await until(() => !broker.isOnline('kitchen'));
        const again = await tablet({ clientId: 'freekiosk_a' });
        await again.subscribeAsync('freekiosk/kitchen/set/#');
        expect(broker.isOnline('kitchen')).to.equal(false);
        await again.publishAsync('freekiosk/kitchen/availability', 'online');
        await until(() => broker.isOnline('kitchen'));
    });

    it('closes a connection that sends more than the pre-login budget', async () => {
        const socket = connect(broker.port, '127.0.0.1');
        socket.on('error', () => undefined); // the broker may reset while we still write
        let closed = false;
        socket.on('close', () => (closed = true));
        await new Promise<void>(resolve => socket.once('connect', resolve));
        // CONNECT fixed header declaring 100,000,000 bytes remaining length, then 128 KB of it.
        socket.write(Buffer.from([0x10, 0x80, 0xc2, 0xd7, 0x2f]));
        socket.write(Buffer.alloc(128 * 1024));
        try {
            await until(() => closed, 1500);
        } finally {
            socket.destroy();
        }
        await tablet();
    });

    it('closes at once while a connection has not sent CONNECT yet', async () => {
        const socket = connect(broker.port, '127.0.0.1');
        socket.on('error', () => undefined);
        await new Promise<void>(resolve => socket.once('connect', resolve));
        const started = Date.now();
        try {
            await broker.close();
        } finally {
            socket.destroy();
        }
        expect(Date.now() - started).to.be.below(1000);
        // afterEach closes the broker again
        broker = await Broker.start(
            { port: 0, baseTopic: 'freekiosk', user: 'iob', password: 'secret', topicIds: ['kitchen'] },
            rec.events,
        );
    });

    it('rejects start on a port already in use', async () => {
        let code = '';
        try {
            await Broker.start(
                { port: broker.port, baseTopic: 'freekiosk', user: 'iob', password: 'secret', topicIds: ['kitchen'] },
                recorder().events,
            );
        } catch (err) {
            code = (err as NodeJS.ErrnoException).code ?? '';
        }
        expect(code).to.equal('EADDRINUSE');
    });

    it('refuses to publish to an offline tablet', async () => {
        expect(await rejection(broker.publish('hall', 'reload', 'PRESS'))).to.contain('not connected');
    });
});
