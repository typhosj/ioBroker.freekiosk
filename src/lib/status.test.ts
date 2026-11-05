import { expect } from 'chai';
import restStatus from '../../test/fixtures/rest-status.json';
import mqttState from '../../test/fixtures/mqtt-state.json';
import { mapStatus } from './status';

describe('status', () => {
    it('maps the REST status', () => {
        // Captured from a Fire HD 10 with FreeKiosk 2.1.0-beta.1, addresses replaced. It has no
        // proximity sensor and reports -1, which is out of range and left out.
        const { values, skipped } = mapStatus(restStatus.data, 'rest');
        expect(skipped).to.deep.equal(['sensors.proximity']);
        expect(Object.fromEntries(values)).to.deep.equal({
            'info.version': '2.1.0-beta.1',
            'info.model': 'KFTRPWI',
            'info.manufacturer': 'Amazon',
            'info.android': '9',
            'info.ip': '192.168.1.50',
            'info.deviceOwner': false,
            'info.kioskMode': true,
            'battery.level': 100,
            'battery.charging': true,
            'battery.temperature': 34,
            'screen.on': true,
            'screen.brightness': 100,
            'screen.screensaverActive': true,
            'screen.autoBrightness': false,
            'webview.url': 'http://192.168.1.10:8082/vis-2/?main#index',
            'webview.loading': false,
            'webview.canGoBack': false,
            'webview.rotation': false,
            'wifi.ssid': 'WiFi (location off)',
            'wifi.rssi': -55,
            'wifi.signalLevel': 99,
            'sensors.light': 99,
            'audio.volume': 0,
            'system.memoryUsedPercent': 59,
            'system.storageAvailable': 18044,
        });
    });

    it('maps the MQTT-only fields for MQTT tablets only', () => {
        const mqtt = mapStatus(mqttState, 'mqtt').values;
        expect(mqtt.get('sensors.motion')).to.equal(true);
        expect(mqtt.get('sensors.motionAlwaysOn')).to.equal(false);
        expect(mqtt.get('images.screenshotAuto')).to.equal(false);
        expect(mqtt.get('images.screenshotEnabled')).to.equal(true);
        expect(mqtt.get('images.cameraEnabled')).to.equal(false);
        expect(mqtt.get('images.cameraInterval')).to.equal(300);
        expect(mqtt.get('webview.rotation')).to.equal(true);
        const rest = mapStatus(mqttState, 'rest').values;
        expect(rest.has('sensors.motion')).to.equal(false);
        expect(rest.has('images.screenshotAuto')).to.equal(false);
    });

    it('leaves missing fields out and reports wrong types and ranges', () => {
        const raw = {
            battery: { level: 101, charging: 'yes', temperature: null },
            screen: { brightness: Number.NaN, on: 1 },
            wifi: { ssid: 'x'.repeat(5000), signalLevel: -1 },
            images: { screenshotInterval: 4 },
        };
        const { values, skipped } = mapStatus(raw, 'mqtt');
        expect(values.size).to.equal(0);
        expect(skipped).to.have.members([
            'battery.level',
            'battery.charging',
            'battery.temperature',
            'screen.on',
            'screen.brightness',
            'wifi.ssid',
            'wifi.signalLevel',
            'images.screenshotInterval',
        ]);
    });

    it('accepts the inclusive range limits and rejects one step beyond', () => {
        const low = mapStatus({ battery: { level: 0 }, images: { screenshotInterval: 5 } }, 'mqtt');
        expect(Object.fromEntries(low.values)).to.deep.equal({ 'battery.level': 0, 'images.screenshotInterval': 5 });
        const high = mapStatus({ battery: { level: 100 }, images: { screenshotInterval: 3600 } }, 'mqtt');
        expect(Object.fromEntries(high.values)).to.deep.equal({
            'battery.level': 100,
            'images.screenshotInterval': 3600,
        });
        const beyond = mapStatus({ images: { screenshotInterval: 3601 } }, 'mqtt');
        expect(beyond.values.size).to.equal(0);
        expect(beyond.skipped).to.deep.equal(['images.screenshotInterval']);
    });

    it('rejects a status that is not an object', () => {
        for (const raw of [null, undefined, 7, 'x', []]) {
            const { values, skipped } = mapStatus(raw, 'rest');
            expect(values.size).to.equal(0);
            expect(skipped).to.deep.equal(['<root>']);
        }
    });

    it('does not walk into inherited properties', () => {
        const { values } = mapStatus({ battery: Object.create({ level: 50 }) }, 'rest');
        expect(values.has('battery.level')).to.equal(false);
    });
});
