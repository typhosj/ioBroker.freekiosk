import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DEVICES, normalizeTopicId, validateConfig } from './config';

const base = {
    mqttPort: 1886,
    mqttBaseTopic: 'freekiosk',
    mqttUser: 'iob',
    mqttPassword: 'pw',
    restInterval: 30,
    restApiKey: '',
};
const rest = {
    enabled: true,
    name: 'Hall',
    id: 'hall',
    transport: 'rest',
    host: '192.168.1.50',
    port: 8080,
    topicId: '',
};
const mqtt = { enabled: true, name: 'Kitchen', id: 'kitchen', transport: 'mqtt', host: '', port: 8080, topicId: '' };

function run(native: Record<string, unknown>): ReturnType<typeof validateConfig> {
    return validateConfig({ ...base, ...native });
}

describe('config', () => {
    it('accepts a REST and an MQTT tablet and defaults the topic id to the lowercased id', () => {
        const { config, errors } = run({ devices: [rest, { ...mqtt, id: 'Kitchen' }] });
        expect(errors).to.deep.equal([]);
        expect(config.devices).to.deep.equal([
            { id: 'hall', name: 'Hall', transport: 'rest', host: '192.168.1.50', port: 8080 },
            { id: 'Kitchen', name: 'Kitchen', transport: 'mqtt', topicId: 'kitchen' },
        ]);
    });

    it('skips disabled rows silently', () => {
        const { config, errors } = run({ devices: [{ ...rest, enabled: false }] });
        expect(config.devices).to.have.length(0);
        expect(errors).to.deep.equal([]);
    });

    it('rejects bad, reserved and duplicate ids', () => {
        const rows = [
            { ...rest, id: '' },
            { ...rest, id: 'a.b' },
            { ...rest, id: 'Küche' },
            { ...rest, id: 'x'.repeat(33) },
            { ...rest, id: 'info' },
            { ...rest, id: 'hall' },
            { ...rest, id: 'HALL' },
        ];
        const { config, errors } = run({ devices: rows });
        expect(config.devices.map(d => d.id)).to.deep.equal(['hall']);
        expect(errors).to.have.length(6);
        expect(errors.at(-1)).to.contain('duplicate');
    });

    it('validates REST host and port', () => {
        const rows = [
            { ...rest, id: 'a', host: 'http://tablet' },
            { ...rest, id: 'b', host: 'tablet/x' },
            { ...rest, id: 'c', host: '' },
            { ...rest, id: 'd', port: 0 },
            { ...rest, id: 'e', port: 65536 },
            { ...rest, id: 'f', port: Number.NaN },
            { ...rest, id: 'g', port: 1.5 },
            { ...rest, id: 'h', host: 'tablet-1.lan', port: 65535 },
            { ...rest, id: 'i', host: 'fe80::1', port: 1 },
            // isIP accepts a zone, but fetch cannot build a URL from it
            { ...rest, id: 'j', host: 'fe80::1%wlan0' },
        ];
        const { config, errors } = run({ devices: rows });
        expect(config.devices.map(d => d.id)).to.deep.equal(['h', 'i']);
        expect(errors).to.have.length(8);
    });

    it('normalizes MQTT topic ids to lowercase a-z, 0-9, _ and - and keeps them unique', () => {
        const rows = [
            { ...mqtt, id: 'a', topicId: 'KFTRPWI' },
            { ...mqtt, id: 'b', topicId: ' Wall Display ' },
            { ...mqtt, id: 'c', topicId: 'lobby/x+y#' },
            { ...mqtt, id: 'd', topicId: 'Küche' },
            { ...mqtt, id: 'E-1', topicId: '' },
            { ...mqtt, id: 'f', topicId: 'kftrpwi' },
        ];
        const { config, errors } = run({ devices: rows });
        expect(config.devices.map(d => (d.transport === 'mqtt' ? d.topicId : d.host))).to.deep.equal([
            'kftrpwi',
            'wall_display',
            'lobby_x_y_',
            'k_che',
            'e-1',
        ]);
        expect(errors).to.deep.equal(['Tablet "Kitchen" skipped: duplicate MQTT topic ID "kftrpwi"']);
        expect(normalizeTopicId(' Wall Display ')).to.equal('wall_display');
    });

    it('accepts a 64-character topic id and rejects 65 characters', () => {
        const rows = [
            { ...mqtt, id: 'a', topicId: 't'.repeat(64) },
            { ...mqtt, id: 'b', topicId: 'u'.repeat(65) },
        ];
        const { config, errors } = run({ devices: rows });
        expect(config.devices.map(d => d.id)).to.deep.equal(['a']);
        expect(errors).to.have.length(1);
        expect(errors[0]).to.contain('topic ID');
    });

    it('skips rows with an unknown or missing transport', () => {
        const { config, errors } = run({
            devices: [
                { ...rest, id: 'a', transport: 'http' },
                { ...rest, id: 'b', transport: undefined },
                { ...rest, id: 'c' },
            ],
        });
        expect(config.devices.map(d => d.id)).to.deep.equal(['c']);
        expect(errors).to.have.length(2);
        for (const message of errors) {
            expect(message).to.contain('transport must be REST or MQTT');
        }
    });

    it('skips MQTT tablets without broker credentials but keeps REST tablets', () => {
        const { config, errors } = run({ mqttUser: '', devices: [rest, mqtt] });
        expect(config.devices.map(d => d.id)).to.deep.equal(['hall']);
        expect(errors.join(' ')).to.contain('user and password');
    });

    it('skips MQTT tablets on an invalid broker port or base topic', () => {
        for (const bad of [
            { mqttPort: 0 },
            { mqttPort: 70000 },
            { mqttPort: '1886' },
            { mqttBaseTopic: '' },
            { mqttBaseTopic: '/fk' },
            { mqttBaseTopic: 'f+k' },
            { mqttBaseTopic: 'fk/' },
            { mqttBaseTopic: 'f#k' },
        ]) {
            const { config, errors } = run({ ...bad, devices: [mqtt] });
            expect(config.devices, JSON.stringify(bad)).to.have.length(0);
            expect(errors, JSON.stringify(bad)).to.have.length(1);
        }
    });

    it('clamps the REST interval and replaces invalid values with 30', () => {
        const cases: Array<[unknown, number, number]> = [
            [0, 5, 0],
            [4, 5, 0],
            [3601, 3600, 0],
            [12.6, 13, 0],
            [Number.POSITIVE_INFINITY, 30, 1],
            [Number.NaN, 30, 1],
            ['30', 30, 1],
            [undefined, 30, 1],
        ];
        for (const [value, expected, errorCount] of cases) {
            const { config, errors } = run({ restInterval: value, devices: [] });
            expect(config.restInterval, String(value)).to.equal(expected);
            expect(errors, String(value)).to.have.length(errorCount);
        }
    });

    it('uses only the first MAX_DEVICES rows', () => {
        const rows = Array.from({ length: MAX_DEVICES + 3 }, (_, i) => ({ ...rest, id: `t${i}` }));
        const { config, errors } = run({ devices: rows });
        expect(config.devices).to.have.length(MAX_DEVICES);
        expect(errors).to.have.length(1);
    });

    it('agrees with the validators of the admin page', () => {
        type Item = { validator?: string };
        const page = JSON.parse(readFileSync(join(__dirname, '../../admin/jsonConfig.json'), 'utf8')) as {
            items: {
                tabTablets: { items: { devices: { items: Item[] } } };
                tabMqtt: { items: Record<string, Item> };
            };
        };
        // jsonConfig runs a validator as a function body: `data` is the table row (or, outside the
        // table, the whole settings), `globalData` the whole settings, `arrayIndex` the row index.
        type Check = (data: unknown, globalData: unknown, arrayIndex: number) => boolean;
        const compile = (items: Item[]): Check[] =>
            items
                .filter(item => item.validator)
                .map(item => new Function('data', 'globalData', 'arrayIndex', `return ${item.validator}`) as Check);
        const columnChecks = compile(page.items.tabTablets.items.devices.items);
        const fieldChecks = compile(Object.values(page.items.tabMqtt.items));
        expect(fieldChecks).to.have.length(3);
        const savable = (native: Record<string, unknown>): boolean => {
            const rows = native.devices as unknown[];
            return (
                fieldChecks.every(check => check(native, native, -1)) &&
                rows.every((row, index) => columnChecks.every(check => check(row, native, index)))
            );
        };
        const cases: Record<string, unknown>[] = [
            ...[
                '192.168.1.50',
                '::1',
                '2001:db8::1',
                '::ffff:192.168.1.5',
                '1::2::3',
                ':::',
                '12345::1',
                'g::1',
                '::1]/x[',
                '1.2.3.4:8080',
            ].map(host => ({ devices: [{ ...rest, host }] })),
            { devices: [rest, { ...rest, id: 'Hall' }] },
            { devices: [rest, { ...rest, id: 'HALL', enabled: false }] },
            { devices: [mqtt, { ...mqtt, id: 'other', topicId: 'kitchen' }] },
            { devices: [mqtt, { ...mqtt, id: 'other', topicId: 'Kitchen' }] },
            {
                devices: [
                    { ...mqtt, topicId: 'KFTRPWI' },
                    { ...mqtt, id: 'other', topicId: 'k f' },
                ],
            },
            {
                devices: [
                    { ...mqtt, topicId: 'K F' },
                    { ...mqtt, id: 'other', topicId: 'k/f' },
                ],
            },
            { devices: [{ ...mqtt, topicId: 'x'.repeat(65) }] },
            { devices: [mqtt, { ...rest, id: 'other', topicId: 'kitchen' }] },
            ...['', ' ', '/x', 'x/', 'a+b', 'a/#', 'home/tablets'].map(mqttBaseTopic => ({
                mqttBaseTopic,
                devices: [mqtt],
            })),
            { mqttBaseTopic: '#', devices: [rest] },
            { mqttUser: ' ', devices: [mqtt] },
            { mqttPassword: '', devices: [mqtt] },
            { mqttUser: '', mqttPassword: '', devices: [rest, { ...mqtt, enabled: false }] },
        ];
        for (const native of cases) {
            const full = { ...base, ...native };
            expect(savable(full), JSON.stringify(native)).to.equal(validateConfig(full).errors.length === 0);
        }
        const rows = [
            rest,
            { ...rest, id: 'a-b_C9' },
            { ...rest, id: 'info' },
            { ...rest, id: 'a b' },
            { ...rest, id: 'ä' },
            { ...rest, id: 'x'.repeat(33) },
            { ...rest, id: '' },
            { ...rest, host: 'tablet-1.lan' },
            { ...rest, host: 'fe80::1' },
            { ...rest, host: 'fe80::1%wlan0' },
            { ...rest, host: 'http://tablet' },
            { ...rest, host: 'tablet/x' },
            { ...rest, host: 'tab_let' },
            { ...rest, host: '' },
            mqtt,
            { ...mqtt, topicId: 'my_tablet' },
            { ...mqtt, topicId: 'a/b' },
            { ...mqtt, topicId: 'a b' },
            { ...mqtt, topicId: 'a+b' },
        ];
        for (const row of rows) {
            const runtime = run({ devices: [row] }).config.devices.length === 1;
            expect(savable({ ...base, devices: [row] }), JSON.stringify(row)).to.equal(runtime);
        }
    });

    it('treats a missing or broken device list as empty', () => {
        expect(run({ devices: undefined }).config.devices).to.deep.equal([]);
        expect(run({ devices: 'x' }).config.devices).to.deep.equal([]);
        const broken = run({ devices: [null, 7, 'x', [rest], rest] });
        expect(broken.config.devices.map(d => d.id)).to.deep.equal(['hall']);
        expect(broken.errors).to.deep.equal([]);
    });
});
