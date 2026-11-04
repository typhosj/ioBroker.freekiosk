import { isObject } from './guards';
import type { StateValue } from './status';

/** Camera or screen capture a REST tablet fetches directly. */
export type ImageKind = 'screenshot' | 'cameraFront' | 'cameraBack';

/** One HTTP request to FreeKiosk's REST API. */
export interface RestRequest {
    /** HTTP method */
    method: 'GET' | 'POST';
    /** Path below the tablet's base URL */
    path: string;
    /** JSON body, absent when the request has none */
    body?: Record<string, unknown>;
}

/** What one write turns into on each transport. */
export interface Command {
    /** REST request, absent when the REST API has no route for this state */
    rest?: RestRequest;
    /** MQTT entity and payload */
    mqtt?: {
        /** Entity name in the MQTT topic */
        entity: string;
        /** Payload published to the entity */
        payload: string;
    };
    /** REST tablets fetch this image directly instead of sending a request */
    image?: ImageKind;
    /** Value the state is acknowledged with after success */
    ackValue: StateValue;
}

/** A command, or the reason the write is rejected. */
export type CommandResult =
    /** The command to send */
    | { command: Command }
    /** The reason the write is rejected */
    | { error: string };

export const MAX_TEXT_BYTES = 4096;
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const KEY_RE = /^[A-Za-z0-9_]{1,32}$/;
const COMBO_RE = /^[A-Za-z0-9_]{1,16}(\+[A-Za-z0-9_]{1,16}){0,4}$/;
const MODES = new Set(['webview', 'external_app', 'media_player']);

const BUTTONS = new Map<string, { rest?: string; mqtt: string; image?: ImageKind }>([
    ['commands.reload', { rest: '/api/reload', mqtt: 'reload' }],
    ['commands.wake', { rest: '/api/wake', mqtt: 'wake' }],
    ['commands.reboot', { rest: '/api/reboot', mqtt: 'reboot' }],
    ['commands.clearCache', { rest: '/api/clearCache', mqtt: 'clear_cache' }],
    ['commands.lock', { rest: '/api/lock', mqtt: 'lock' }],
    ['commands.restartUi', { rest: '/api/restart-ui', mqtt: 'restart_ui' }],
    ['commands.audioStop', { rest: '/api/audio/stop', mqtt: 'audio_stop' }],
    ['commands.audioBeep', { rest: '/api/audio/beep', mqtt: 'audio_beep' }],
    ['commands.rotationStart', { rest: '/api/rotation/start', mqtt: 'rotation_start' }],
    ['commands.rotationStop', { rest: '/api/rotation/stop', mqtt: 'rotation_stop' }],
    ['commands.screenshot', { mqtt: 'screenshot_capture', image: 'screenshot' }],
    ['commands.cameraFront', { mqtt: 'camera_capture_front', image: 'cameraFront' }],
    ['commands.cameraBack', { mqtt: 'camera_capture_back', image: 'cameraBack' }],
    ['remote.up', { rest: '/api/remote/up', mqtt: 'remote_up' }],
    ['remote.down', { rest: '/api/remote/down', mqtt: 'remote_down' }],
    ['remote.left', { rest: '/api/remote/left', mqtt: 'remote_left' }],
    ['remote.right', { rest: '/api/remote/right', mqtt: 'remote_right' }],
    ['remote.select', { rest: '/api/remote/select', mqtt: 'remote_select' }],
    ['remote.back', { rest: '/api/remote/back', mqtt: 'remote_back' }],
    ['remote.home', { rest: '/api/remote/home', mqtt: 'remote_home' }],
    ['remote.menu', { rest: '/api/remote/menu', mqtt: 'remote_menu' }],
    ['remote.playPause', { rest: '/api/remote/playpause', mqtt: 'remote_playpause' }],
]);

const SWITCHES = new Map<string, { rest?: [on: string, off: string]; mqtt: string }>([
    ['screen.on', { rest: ['/api/screen/on', '/api/screen/off'], mqtt: 'screen' }],
    ['screen.screensaver', { rest: ['/api/screensaver/on', '/api/screensaver/off'], mqtt: 'screensaver' }],
    ['sensors.motionAlwaysOn', { mqtt: 'motion_always_on' }],
    ['images.screenshotAuto', { mqtt: 'screenshot_auto' }],
    ['images.cameraAuto', { mqtt: 'camera_auto' }],
]);

const LEVELS = new Map<string, { min: number; max: number; rest?: string; mqtt: string }>([
    ['screen.brightness', { min: 0, max: 100, rest: '/api/brightness', mqtt: 'brightness' }],
    ['audio.volume', { min: 0, max: 100, rest: '/api/volume', mqtt: 'volume' }],
    ['images.screenshotInterval', { min: 5, max: 3600, mqtt: 'screenshot_interval' }],
    ['images.cameraInterval', { min: 5, max: 3600, mqtt: 'camera_interval' }],
]);

const TEXTS = new Map<string, { rest: string; field: string; mqtt: string }>([
    ['commands.tts', { rest: '/api/tts', field: 'text', mqtt: 'tts' }],
    ['commands.toast', { rest: '/api/toast', field: 'text', mqtt: 'toast' }],
    ['commands.executeJs', { rest: '/api/js', field: 'code', mqtt: 'execute_js' }],
    ['remote.text', { rest: '/api/remote/text', field: 'text', mqtt: 'keyboard_text' }],
]);

function commandFor(
    rest: RestRequest | undefined,
    entity: string,
    payload: string,
    ackValue: StateValue,
): CommandResult {
    return { command: { rest, mqtt: { entity, payload }, ackValue } };
}

function withText(value: unknown, build: (text: string) => CommandResult): CommandResult {
    if (typeof value !== 'string' || !value.trim()) {
        return { error: 'expects a non-empty text' };
    }
    if (Buffer.byteLength(value) > MAX_TEXT_BYTES) {
        return { error: `text is longer than ${MAX_TEXT_BYTES} bytes` };
    }
    return build(value);
}

function parseObject(text: string): Record<string, unknown> | undefined {
    try {
        const parsed: unknown = JSON.parse(text);
        return isObject(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function isHttpUrl(value: unknown): value is string {
    return typeof value === 'string' && /^https?:\/\//i.test(value) && URL.canParse(value);
}

function audioPlay(text: string): CommandResult {
    const spec = text.trimStart().startsWith('{') ? parseObject(text) : { url: text.trim() };
    if (!spec) {
        return { error: 'expects a URL or JSON {"url": ..., "loop": ..., "volume": ...}' };
    }
    const { url, loop = false, volume = 50 } = spec;
    if (!isHttpUrl(url)) {
        return { error: 'needs an http(s) URL' };
    }
    if (typeof loop !== 'boolean') {
        return { error: 'loop must be true or false' };
    }
    if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
        return { error: 'volume must be an integer 0-100' };
    }
    const body = { url, loop, volume };
    return commandFor({ method: 'POST', path: '/api/audio/play', body }, 'audio_play', JSON.stringify(body), text);
}

function displayMode(text: string): CommandResult {
    const spec = parseObject(text);
    if (!spec || typeof spec.mode !== 'string' || !MODES.has(spec.mode)) {
        return {
            error: 'expects JSON such as {"mode":"webview","url":"https://..."}; mode is webview, external_app or media_player',
        };
    }
    const body: Record<string, unknown> = { mode: spec.mode };
    if (spec.url !== undefined) {
        if (!isHttpUrl(spec.url)) {
            return { error: 'url must be an http(s) URL' };
        }
        body.url = spec.url;
    }
    if (spec.package !== undefined) {
        if (typeof spec.package !== 'string' || !PACKAGE_RE.test(spec.package)) {
            return { error: 'package must be an Android package name such as com.example.app' };
        }
        body.package = spec.package;
    }
    return commandFor({ method: 'POST', path: '/api/mode', body }, 'mode', JSON.stringify(body), text);
}

/**
 * Translates a user write on a relative state id into what each transport sends.
 *
 * @param id State id relative to the tablet's device, e.g. `screen.on`
 * @param value The value written by the user
 */
export function buildCommand(id: string, value: unknown): CommandResult {
    const button = BUTTONS.get(id);
    if (button) {
        if (value !== true) {
            return { error: 'write true to trigger' };
        }
        return {
            command: {
                rest: button.rest ? { method: 'POST', path: button.rest } : undefined,
                mqtt: { entity: button.mqtt, payload: 'PRESS' },
                image: button.image,
                ackValue: true,
            },
        };
    }
    const toggle = SWITCHES.get(id);
    if (toggle) {
        if (typeof value !== 'boolean') {
            return { error: 'expects true or false' };
        }
        const rest: RestRequest | undefined = toggle.rest
            ? { method: 'POST', path: toggle.rest[value ? 0 : 1] }
            : undefined;
        return commandFor(rest, toggle.mqtt, value ? 'ON' : 'OFF', value);
    }
    const level = LEVELS.get(id);
    if (level) {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < level.min || value > level.max) {
            return { error: `expects an integer ${level.min}-${level.max}` };
        }
        const rest: RestRequest | undefined = level.rest
            ? { method: 'POST', path: level.rest, body: { value } }
            : undefined;
        return commandFor(rest, level.mqtt, String(value), value);
    }
    const plain = TEXTS.get(id);
    if (plain) {
        return withText(value, text =>
            commandFor({ method: 'POST', path: plain.rest, body: { [plain.field]: text } }, plain.mqtt, text, text),
        );
    }
    switch (id) {
        case 'webview.url':
            return withText(value, text => {
                const url = text.trim();
                if (!isHttpUrl(url)) {
                    return { error: 'needs an http(s) URL' };
                }
                // Sent trimmed, acknowledged with the value as written.
                return commandFor({ method: 'POST', path: '/api/url', body: { url } }, 'url', url, text);
            });
        case 'commands.launchApp':
            return withText(value, text => {
                if (!PACKAGE_RE.test(text)) {
                    return { error: 'expects an Android package name such as com.example.app' };
                }
                const body = { package: text };
                return commandFor({ method: 'POST', path: '/api/app/launch', body }, 'launch_app', text, text);
            });
        case 'commands.audioPlay':
            return withText(value, audioPlay);
        case 'commands.mode':
            return withText(value, displayMode);
        case 'remote.key':
            if (typeof value !== 'string' || !KEY_RE.test(value)) {
                return { error: 'expects a key name such as enter, a or f5' };
            }
            return commandFor(
                { method: 'GET', path: `/api/remote/keyboard/${encodeURIComponent(value)}` },
                'keyboard_key',
                value,
                value,
            );
        case 'remote.combo':
            if (typeof value !== 'string' || !COMBO_RE.test(value)) {
                return { error: 'expects a combination such as ctrl+c' };
            }
            return commandFor(
                { method: 'GET', path: `/api/remote/keyboard?map=${encodeURIComponent(value)}` },
                'keyboard_combo',
                value,
                value,
            );
    }
    return { error: 'is not a command' };
}
