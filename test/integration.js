const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');
const mqtt = require('mqtt');
const { tests } = require('@iobroker/testing');
const restStatus = require('./fixtures/rest-status.json');
const mqttState = require('./fixtures/mqtt-state.json');

const DUMP = path.join(os.tmpdir(), 'freekiosk.0.json');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const OLD_JPEG = Buffer.from([0xff, 0xd8, 0xff, 1]);
const NEW_JPEG = Buffer.from([0xff, 0xd8, 0xff, 2]);

function call(fn, ...args) {
    return new Promise((resolve, reject) => fn(...args, (err, result) => (err ? reject(err) : resolve(result))));
}

async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(read, expected, timeoutMs) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
        last = await read();
        if (last === expected) {
            return;
        }
        await delay(300);
    }
    expect(last).to.equal(expected);
}

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('talks to a REST and an MQTT tablet', getHarness => {
            let server;
            const requests = [];
            // Front camera: the first photo is slow and old, every later one fast and new.
            const photos = { count: 0, active: 0, maxActive: 0 };

            before(async () => {
                server = http.createServer((req, res) => {
                    let body = '';
                    req.on('data', chunk => (body += chunk));
                    req.on('end', () => {
                        requests.push(`${req.method} ${req.url} ${body}`);
                        if (req.url === '/api/screenshot') {
                            res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
                        } else if (req.url === '/api/camera/photo?camera=front') {
                            const first = photos.count++ === 0;
                            photos.active++;
                            photos.maxActive = Math.max(photos.maxActive, photos.active);
                            setTimeout(
                                () => {
                                    photos.active--;
                                    res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(
                                        first ? OLD_JPEG : NEW_JPEG,
                                    );
                                },
                                first ? 1500 : 0,
                            );
                        } else if (req.url === '/api/reboot') {
                            res.writeHead(403, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: 'Remote control is disabled' }));
                        } else {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(
                                JSON.stringify(req.url === '/api/status' ? restStatus : { success: true, data: {} }),
                            );
                        }
                    });
                });
                await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            });
            after(() => server.close());

            it('creates objects, maps status, sends commands and writes a dump', async function () {
                this.timeout(60_000);
                const harness = getHarness();
                const mqttPort = await freePort();
                await harness.changeAdapterConfig('freekiosk', {
                    native: {
                        mqttPort,
                        mqttBaseTopic: 'freekiosk',
                        mqttUser: 'iob',
                        mqttPassword: 'secret',
                        restInterval: 5,
                        restApiKey: 'k3y',
                        devices: [
                            {
                                enabled: true,
                                name: 'Hall',
                                id: 'hall',
                                transport: 'rest',
                                host: '127.0.0.1',
                                port: server.address().port,
                                topicId: '',
                            },
                            {
                                enabled: true,
                                name: 'Kitchen',
                                id: 'kitchen',
                                transport: 'mqtt',
                                host: '',
                                port: 8080,
                                topicId: 'kitchen',
                            },
                        ],
                    },
                });
                // Differs-from-plain only shows that something was encrypted; the real proof of correct
                // encryption and decryption is the accepted REST key and the MQTT login further down.
                const stored = await call(
                    harness.objects.getObject.bind(harness.objects),
                    'system.adapter.freekiosk.0',
                );
                expect(stored.native.mqttPassword).to.be.a('string').and.not.equal('').and.not.equal('secret');
                expect(stored.native.restApiKey).to.be.a('string').and.not.equal('').and.not.equal('k3y');
                // Leftovers of an earlier version: an MQTT-only state of a tablet now on REST, and a state
                // with outdated metadata.
                const setObject = (id, obj) => call(harness.objects.setObject.bind(harness.objects), id, obj);
                const stale = {
                    type: 'state',
                    common: { name: 'x', type: 'boolean', role: 'state', read: true, write: false },
                    native: {},
                };
                await setObject('freekiosk.0.hall.sensors.motion', stale);
                await setObject('freekiosk.0.hall.battery.level', {
                    ...stale,
                    common: { ...stale.common, type: 'number' },
                });
                await harness.startAdapterAndWait();
                const get = async id => (await call(harness.states.getState.bind(harness.states), id))?.val;
                const ackOf = async id => (await call(harness.states.getState.bind(harness.states), id))?.ack;
                const set = (id, val) => call(harness.states.setState.bind(harness.states), id, { val, ack: false });

                await waitFor(() => get('freekiosk.0.hall.battery.level'), 85, 15_000);
                expect(await get('freekiosk.0.hall.info.online')).to.equal(true);
                const level = await call(
                    harness.objects.getObject.bind(harness.objects),
                    'freekiosk.0.hall.battery.level',
                );
                expect(level.common).to.include({ role: 'value.battery', unit: '%', name: 'Battery level' });

                // REST screenshot: downloaded, stored as PNG, path and time set, button acknowledged.
                await set('freekiosk.0.hall.commands.screenshot', true);
                await waitFor(
                    () => get('freekiosk.0.hall.images.screenshot'),
                    '/freekiosk.0/hall/screenshot.png',
                    10_000,
                );
                const file = await call(
                    harness.objects.readFile.bind(harness.objects),
                    'freekiosk.0',
                    'hall/screenshot.png',
                );
                expect(Buffer.from(file)).to.deep.equal(PNG);
                expect(await get('freekiosk.0.hall.images.screenshotTime')).to.be.a('number');
                expect(await ackOf('freekiosk.0.hall.commands.screenshot')).to.equal(true);

                // REST photos: one download per kind at a time, presses during it collapse into one more,
                // so the slow older photo cannot overwrite the newer one.
                await set('freekiosk.0.hall.commands.cameraFront', true);
                await waitFor(async () => photos.active, 1, 5_000);
                await set('freekiosk.0.hall.commands.cameraFront', true);
                await set('freekiosk.0.hall.commands.cameraFront', true);
                await waitFor(async () => photos.count === 2 && photos.active === 0, true, 10_000);
                await waitFor(async () => ackOf('freekiosk.0.hall.commands.cameraFront'), true, 5_000);
                await delay(1000); // no further download may follow
                const photo = await call(
                    harness.objects.readFile.bind(harness.objects),
                    'freekiosk.0',
                    'hall/cameraFront.jpg',
                );
                expect(Buffer.from(photo)).to.deep.equal(NEW_JPEG);
                expect(photos).to.include({ count: 2, maxActive: 1 });

                // REST 403: sent, refused, not acknowledged.
                await set('freekiosk.0.hall.commands.reboot', true);
                await waitFor(async () => requests.some(r => r.startsWith('POST /api/reboot')), true, 10_000);
                await delay(1000);
                expect(await ackOf('freekiosk.0.hall.commands.reboot')).to.equal(false);

                const tablet = await mqtt.connectAsync(`mqtt://127.0.0.1:${mqttPort}`, {
                    username: 'iob',
                    password: 'secret',
                    reconnectPeriod: 0,
                });
                try {
                    await tablet.publishAsync('freekiosk/kitchen/availability', 'online', { qos: 1, retain: true });
                    await tablet.publishAsync('freekiosk/kitchen/state', JSON.stringify(mqttState), { retain: true });
                    await waitFor(() => get('freekiosk.0.kitchen.sensors.motion'), true, 10_000);
                    await waitFor(() => get('freekiosk.0.info.connection'), true, 10_000);
                    // Without the set/# subscription ("Allow remote control" off) a command is not acknowledged.
                    await set('freekiosk.0.kitchen.audio.volume', 10);
                    await delay(1000);
                    expect(await ackOf('freekiosk.0.kitchen.audio.volume')).to.equal(false);
                    await tablet.subscribeAsync('freekiosk/kitchen/set/#');

                    await set('freekiosk.0.hall.screen.brightness', 40);
                    await waitFor(async () => requests.includes('POST /api/brightness {"value":40}'), true, 10_000);
                    const received = new Promise(resolve =>
                        tablet.once('message', (topic, payload) => resolve(`${topic} ${payload}`)),
                    );
                    await set('freekiosk.0.kitchen.screen.on', false);
                    expect(await received).to.equal('freekiosk/kitchen/set/screen OFF');
                    await waitFor(
                        async () =>
                            (await call(harness.states.getState.bind(harness.states), 'freekiosk.0.kitchen.screen.on'))
                                ?.ack,
                        true,
                        5_000,
                    );
                } finally {
                    tablet.end(true);
                }
                await waitFor(() => get('freekiosk.0.kitchen.info.online'), false, 10_000);
                expect(await get('freekiosk.0.info.connection')).to.equal(false);
                // Offline: dropped, not acknowledged.
                await set('freekiosk.0.kitchen.screen.on', true);
                await delay(1000);
                expect(await ackOf('freekiosk.0.kitchen.screen.on')).to.equal(false);

                const list = await call(harness.objects.getObjectList.bind(harness.objects), {
                    startkey: 'freekiosk.0.',
                    endkey: 'freekiosk.0.香',
                });
                const dump = {};
                for (const row of list.rows) {
                    dump[row.id] = row.value;
                }
                fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2));
                expect(dump).to.have.property('freekiosk.0.kitchen.sensors.motion');
                expect(dump).not.to.have.property('freekiosk.0.hall.sensors.motion');
            });
        });
    },
});
