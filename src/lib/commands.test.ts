import { expect } from 'chai';
import { STATES } from './objects';
import { buildCommand, MAX_TEXT_BYTES, type Command } from './commands';

function ok(id: string, value: unknown): Command {
    const result = buildCommand(id, value);
    if ('error' in result) {
        throw new Error(`${id}: ${result.error}`);
    }
    return result.command;
}

function error(id: string, value: unknown): string {
    const result = buildCommand(id, value);
    expect(result, `${id} = ${JSON.stringify(value)}`).to.have.property('error');
    return (result as { error: string }).error;
}

describe('commands', () => {
    it('has a command for every writable state', () => {
        const samples: Record<string, unknown> = {
            'commands.launchApp': 'com.example.app',
            'commands.audioPlay': 'https://example.com/a.mp3',
            'commands.mode': '{"mode":"webview"}',
            'webview.url': 'https://example.com/',
            'remote.key': 'enter',
            'remote.combo': 'ctrl+c',
        };
        for (const def of STATES.filter(s => s.write)) {
            const value =
                samples[def.id] ?? (def.type === 'boolean' ? true : def.type === 'number' ? (def.min ?? 0) : 'hello');
            const command = ok(def.id, value);
            expect(command.mqtt, def.id).to.not.equal(undefined);
            if (!def.mqttOnly) {
                expect(command.rest ?? command.image, def.id).to.not.equal(undefined);
            }
        }
    });

    it('rejects ids that are not commands', () => {
        expect(error('battery.level', 1)).to.contain('not a command');
        expect(error('__proto__', true)).to.contain('not a command');
    });

    it('maps buttons, and only on true', () => {
        expect(ok('commands.reload', true)).to.deep.equal({
            rest: { method: 'POST', path: '/api/reload' },
            mqtt: { entity: 'reload', payload: 'PRESS' },
            image: undefined,
            ackValue: true,
        });
        expect(ok('remote.playPause', true).rest?.path).to.equal('/api/remote/playpause');
        expect(ok('remote.playPause', true).mqtt?.entity).to.equal('remote_playpause');
        const shot = ok('commands.screenshot', true);
        expect([shot.rest, shot.image, shot.mqtt?.entity]).to.deep.equal([
            undefined,
            'screenshot',
            'screenshot_capture',
        ]);
        for (const value of [false, 1, 'true', null]) {
            error('commands.reload', value);
        }
    });

    it('maps switches', () => {
        expect(ok('screen.on', false)).to.deep.equal({
            rest: { method: 'POST', path: '/api/screen/off' },
            mqtt: { entity: 'screen', payload: 'OFF' },
            ackValue: false,
        });
        expect(ok('screen.screensaver', true).rest?.path).to.equal('/api/screensaver/on');
        expect(ok('sensors.motionAlwaysOn', true)).to.deep.include({
            rest: undefined,
            mqtt: { entity: 'motion_always_on', payload: 'ON' },
        });
        error('screen.on', 'ON');
        error('screen.on', 1);
    });

    it('maps levels with integer range checks', () => {
        expect(ok('screen.brightness', 0)).to.deep.equal({
            rest: { method: 'POST', path: '/api/brightness', body: { value: 0 } },
            mqtt: { entity: 'brightness', payload: '0' },
            ackValue: 0,
        });
        expect(ok('audio.volume', 100).rest?.body).to.deep.equal({ value: 100 });
        expect(ok('images.screenshotInterval', 5).mqtt).to.deep.equal({ entity: 'screenshot_interval', payload: '5' });
        expect(ok('images.cameraInterval', 3600).rest).to.equal(undefined);
        for (const value of [-1, 101, 1.5, '50', Number.NaN, null]) {
            error('screen.brightness', value);
        }
        error('images.screenshotInterval', 4);
        error('images.screenshotInterval', 3601);
    });

    it('maps text commands and bounds their size', () => {
        expect(ok('commands.tts', 'Hallo')).to.deep.equal({
            rest: { method: 'POST', path: '/api/tts', body: { text: 'Hallo' } },
            mqtt: { entity: 'tts', payload: 'Hallo' },
            ackValue: 'Hallo',
        });
        expect(ok('commands.executeJs', 'location.reload()').rest?.body).to.deep.equal({ code: 'location.reload()' });
        ok('commands.toast', 'ä'.repeat(MAX_TEXT_BYTES / 2));
        error('commands.toast', 'ä'.repeat(MAX_TEXT_BYTES / 2 + 1));
        error('commands.toast', '   ');
        error('commands.toast', 5);
    });

    it('navigates only to http(s) URLs', () => {
        expect(ok('webview.url', ' https://x/y ')).to.deep.equal({
            rest: { method: 'POST', path: '/api/url', body: { url: 'https://x/y' } },
            mqtt: { entity: 'url', payload: 'https://x/y' },
            ackValue: ' https://x/y ', // acknowledged as written, not as sent
        });
        expect(ok('webview.url', 'HTTP://x').mqtt?.payload).to.equal('HTTP://x');
        for (const value of ['javascript:alert(1)', 'file:///sdcard/a.html', 'x', 'http://', '', 5]) {
            error('webview.url', value);
        }
    });

    it('validates app package names', () => {
        expect(ok('commands.launchApp', 'com.spotify.music').rest?.body).to.deep.equal({
            package: 'com.spotify.music',
        });
        for (const value of ['spotify', 'com..x', '1com.x', 'com.x/../y']) {
            error('commands.launchApp', value);
        }
    });

    it('accepts a URL or JSON for audioPlay', () => {
        expect(ok('commands.audioPlay', 'https://x/a.mp3').rest?.body).to.deep.equal({
            url: 'https://x/a.mp3',
            loop: false,
            volume: 50,
        });
        expect(ok('commands.audioPlay', 'https://x/a.mp3').mqtt?.payload).to.equal(
            '{"url":"https://x/a.mp3","loop":false,"volume":50}',
        );
        const json = ok('commands.audioPlay', '{"url":"http://x/a.mp3","loop":true,"volume":20}');
        expect(json.mqtt?.payload).to.equal('{"url":"http://x/a.mp3","loop":true,"volume":20}');
        for (const value of [
            'ftp://x/a.mp3',
            '{"url":"http://x","volume":101}',
            '{"url":"http://x","loop":"yes"}',
            '{broken',
            '[]',
        ]) {
            error('commands.audioPlay', value);
        }
    });

    it('validates the display mode JSON', () => {
        expect(ok('commands.mode', '{"mode":"external_app","package":"com.x.y"}').rest?.body).to.deep.equal({
            mode: 'external_app',
            package: 'com.x.y',
        });
        expect(ok('commands.mode', '{"mode":"webview","url":"https://x","extra":1}').mqtt?.payload).to.equal(
            '{"mode":"webview","url":"https://x"}',
        );
        for (const value of [
            'webview',
            '{"mode":"kiosk"}',
            '{"mode":"webview","url":5}',
            '{"mode":"webview","url":"file:///sdcard/a.html"}',
            '{"mode":"webview","url":"javascript:alert(1)"}',
            '{"mode":"external_app","package":"x"}',
        ]) {
            error('commands.mode', value);
        }
    });

    it('maps keyboard keys and combos with escaping', () => {
        expect(ok('remote.key', 'f5')).to.deep.include({
            rest: { method: 'GET', path: '/api/remote/keyboard/f5' },
            mqtt: { entity: 'keyboard_key', payload: 'f5' },
        });
        expect(ok('remote.combo', 'ctrl+shift+t').rest?.path).to.equal('/api/remote/keyboard?map=ctrl%2Bshift%2Bt');
        for (const value of ['../status', 'a b', '', 'x'.repeat(33)]) {
            error('remote.key', value);
        }
        for (const value of ['ctrl+', '+c', 'a+b+c+d+e+f', 'ctrl c']) {
            error('remote.combo', value);
        }
        expect(ok('remote.text', 'hello world').rest).to.deep.equal({
            method: 'POST',
            path: '/api/remote/text',
            body: { text: 'hello world' },
        });
    });
});
