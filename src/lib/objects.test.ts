import { expect } from 'chai';
import { CHANNELS, STATES, mqttOnlyIds, statesFor } from './objects';

describe('objects', () => {
    it('has unique ids inside known channels', () => {
        const ids = STATES.map(s => s.id);
        expect(new Set(ids).size).to.equal(ids.length);
        for (const id of ids) {
            expect(CHANNELS, id).to.have.property(id.split('.')[0]);
            expect(id.split('.'), id).to.have.length(2);
        }
    });

    it('keeps role rules the object check enforces', () => {
        for (const s of STATES) {
            if (s.role === 'button') {
                expect([s.type, s.read, s.write], s.id).to.deep.equal(['boolean', false, true]);
            }
            if (s.role === 'value' || s.role.startsWith('value.') || s.role.startsWith('level.')) {
                expect(s.type, s.id).to.equal('number');
            }
            if (s.role.startsWith('level.') || s.role.startsWith('switch')) {
                expect(s.write, s.id).to.equal(true);
            }
            if (s.role === 'text' || s.role === 'text.url') {
                expect(s.type, s.id).to.equal('string');
            }
        }
    });

    it('gives every timestamp the unit ms', () => {
        const dates = STATES.filter(s => s.role === 'date');
        expect(dates.map(s => s.id)).to.have.members([
            'info.lastUpdate',
            'images.screenshotTime',
            'images.cameraFrontTime',
            'images.cameraBackTime',
        ]);
        for (const s of dates) {
            expect([s.type, s.unit], s.id).to.deep.equal(['number', 'ms']);
        }
    });

    it('creates MQTT-only states only for MQTT tablets', () => {
        const restIds = statesFor('rest').map(s => s.id);
        expect(mqttOnlyIds()).to.have.members([
            'sensors.motion',
            'sensors.motionAlwaysOn',
            'images.screenshotEnabled',
            'images.cameraEnabled',
            'images.screenshotAuto',
            'images.cameraAuto',
            'images.screenshotInterval',
            'images.cameraInterval',
        ]);
        expect(mqttOnlyIds()).to.have.length(8);
        for (const id of mqttOnlyIds()) {
            expect(restIds).not.to.include(id);
        }
        expect(statesFor('mqtt')).to.have.length(STATES.length);
    });
});
