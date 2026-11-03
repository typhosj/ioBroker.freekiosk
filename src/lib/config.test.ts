import { expect } from 'chai';
import { MAX_DEVICES, validateConfig } from './config';

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
            { id: 'hall', name: 'Hall', transport: 'rest', host: '192.168.1.50', port: 8080, topicId: '' },
            { id: 'Kitchen', name: 'Kitchen', transport: 'mqtt', host: '', port: 0, topicId: 'kitchen' },
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
        ];
        const { config, errors } = run({ devices: rows });
        expect(config.devices.map(d => d.id)).to.deep.equal(['h', 'i']);
        expect(errors).to.have.length(7);
    });

    it('validates MQTT topic ids and keeps them unique', () => {
        const rows = [
            { ...mqtt, id: 'a', topicId: 'lobby/x' },
            { ...mqtt, id: 'b', topicId: 'lob+by' },
            { ...mqtt, id: 'c', topicId: 'lobby#' },
            { ...mqtt, id: 'd', topicId: 'lobby' },
            { ...mqtt, id: 'e', topicId: 'lobby' },
        ];
        const { config, errors } = run({ devices: rows });
        expect(config.devices.map(d => d.topicId)).to.deep.equal(['lobby']);
        expect(errors).to.have.length(4);
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

    it('treats a missing or broken device list as empty', () => {
        expect(run({ devices: undefined }).config.devices).to.deep.equal([]);
        expect(run({ devices: 'x' }).config.devices).to.deep.equal([]);
        expect(run({ devices: [null, 7, 'x'] }).config.devices).to.deep.equal([]);
    });
});
