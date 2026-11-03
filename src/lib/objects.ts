import type { Transport } from './config';

/** One ioBroker state the adapter creates for each tablet. */
export interface StateDef {
    /** Relative to the tablet's device object, `<channel>.<state>` */
    id: string;
    /** Display name in the object tree */
    name: string;
    /** `common.type` */
    type: 'boolean' | 'number' | 'string';
    /** `common.role` */
    role: string;
    /** `common.read` */
    read: boolean;
    /** `common.write` */
    write: boolean;
    /** `common.unit` */
    unit?: string;
    /** `common.min` */
    min?: number;
    /** `common.max` */
    max?: number;
    /** Dotted path in FreeKiosk's status JSON; absent for states the adapter writes itself */
    source?: string;
    /** Only MQTT tablets get this state */
    mqttOnly?: boolean;
}

export const CHANNELS: Record<string, string> = {
    info: 'Information',
    battery: 'Battery',
    screen: 'Screen',
    webview: 'Web view',
    wifi: 'Wi-Fi',
    sensors: 'Sensors',
    audio: 'Audio',
    system: 'System',
    images: 'Images',
    commands: 'Commands',
    remote: 'Remote control',
};

const ro = { read: true, write: false };
const rw = { read: true, write: true };
const button = (id: string, name: string): StateDef => ({
    id,
    name,
    type: 'boolean',
    role: 'button',
    read: false,
    write: true,
});
const command = (id: string, name: string, role = 'text'): StateDef => ({
    id,
    name,
    type: 'string',
    role,
    read: false,
    write: true,
});

export const STATES: StateDef[] = [
    { id: 'info.online', name: 'Tablet reachable', type: 'boolean', role: 'indicator.reachable', ...ro },
    { id: 'info.lastUpdate', name: 'Last status received', type: 'number', role: 'date', ...ro },
    { id: 'info.transport', name: 'Transport', type: 'string', role: 'text', ...ro },
    {
        id: 'info.version',
        name: 'FreeKiosk version',
        type: 'string',
        role: 'info.firmware',
        ...ro,
        source: 'device.version',
    },
    { id: 'info.model', name: 'Model', type: 'string', role: 'info.model', ...ro, source: 'device.model' },
    {
        id: 'info.manufacturer',
        name: 'Manufacturer',
        type: 'string',
        role: 'text',
        ...ro,
        source: 'device.manufacturer',
    },
    {
        id: 'info.android',
        name: 'Android version',
        type: 'string',
        role: 'text',
        ...ro,
        source: 'device.androidVersion',
    },
    { id: 'info.ip', name: 'IP address', type: 'string', role: 'info.ip', ...ro, source: 'device.ip' },
    {
        id: 'info.deviceOwner',
        name: 'Device owner',
        type: 'boolean',
        role: 'indicator',
        ...ro,
        source: 'device.isDeviceOwner',
    },
    { id: 'info.kioskMode', name: 'Kiosk mode', type: 'boolean', role: 'indicator', ...ro, source: 'device.kioskMode' },
    {
        id: 'battery.level',
        name: 'Battery level',
        type: 'number',
        role: 'value.battery',
        ...ro,
        unit: '%',
        min: 0,
        max: 100,
        source: 'battery.level',
    },
    { id: 'battery.charging', name: 'Charging', type: 'boolean', role: 'indicator', ...ro, source: 'battery.charging' },
    {
        id: 'battery.temperature',
        name: 'Battery temperature',
        type: 'number',
        role: 'value.temperature',
        ...ro,
        unit: '°C',
        source: 'battery.temperature',
    },
    { id: 'screen.on', name: 'Screen on', type: 'boolean', role: 'switch.power', ...rw, source: 'screen.on' },
    {
        id: 'screen.brightness',
        name: 'Brightness',
        type: 'number',
        role: 'level.brightness',
        ...rw,
        unit: '%',
        min: 0,
        max: 100,
        source: 'screen.brightness',
    },
    {
        id: 'screen.screensaverActive',
        name: 'Screensaver showing',
        type: 'boolean',
        role: 'indicator',
        ...ro,
        source: 'screen.screensaverActive',
    },
    { id: 'screen.screensaver', name: 'Screensaver enabled', type: 'boolean', role: 'switch.enable', ...rw },
    {
        id: 'screen.autoBrightness',
        name: 'Auto brightness',
        type: 'boolean',
        role: 'indicator',
        ...ro,
        source: 'autoBrightness.enabled',
    },
    { id: 'webview.url', name: 'URL', type: 'string', role: 'text.url', ...rw, source: 'webview.currentUrl' },
    { id: 'webview.loading', name: 'Loading', type: 'boolean', role: 'indicator', ...ro, source: 'webview.loading' },
    {
        id: 'webview.canGoBack',
        name: 'Can go back',
        type: 'boolean',
        role: 'indicator',
        ...ro,
        source: 'webview.canGoBack',
    },
    {
        id: 'webview.rotation',
        name: 'URL rotation running',
        type: 'boolean',
        role: 'indicator',
        ...ro,
        source: 'rotation.enabled',
    },
    { id: 'wifi.ssid', name: 'SSID', type: 'string', role: 'text', ...ro, source: 'wifi.ssid' },
    {
        id: 'wifi.rssi',
        name: 'Signal strength',
        type: 'number',
        role: 'value.rssi',
        ...ro,
        unit: 'dBm',
        source: 'wifi.signalStrength',
    },
    {
        id: 'wifi.signalLevel',
        name: 'Signal level',
        type: 'number',
        role: 'value',
        ...ro,
        unit: '%',
        min: 0,
        max: 100,
        source: 'wifi.signalLevel',
    },
    {
        id: 'sensors.light',
        name: 'Ambient light',
        type: 'number',
        role: 'value.brightness',
        ...ro,
        unit: 'lx',
        min: 0,
        source: 'sensors.light',
    },
    {
        id: 'sensors.proximity',
        name: 'Proximity',
        type: 'number',
        role: 'value.distance',
        ...ro,
        unit: 'cm',
        min: 0,
        source: 'sensors.proximity',
    },
    {
        id: 'sensors.motion',
        name: 'Motion detected',
        type: 'boolean',
        role: 'sensor.motion',
        ...ro,
        source: 'webview.motionDetected',
        mqttOnly: true,
    },
    {
        id: 'sensors.motionAlwaysOn',
        name: 'Always-on motion detection',
        type: 'boolean',
        role: 'switch.enable',
        ...rw,
        source: 'device.motionAlwaysOn',
        mqttOnly: true,
    },
    {
        id: 'audio.volume',
        name: 'Volume',
        type: 'number',
        role: 'level.volume',
        ...rw,
        unit: '%',
        min: 0,
        max: 100,
        source: 'audio.volume',
    },
    {
        id: 'system.memoryUsedPercent',
        name: 'Memory used',
        type: 'number',
        role: 'value',
        ...ro,
        unit: '%',
        min: 0,
        max: 100,
        source: 'memory.usedPercent',
    },
    {
        id: 'system.storageAvailable',
        name: 'Storage available',
        type: 'number',
        role: 'value',
        ...ro,
        unit: 'MB',
        min: 0,
        source: 'storage.availableMB',
    },
    { id: 'images.screenshot', name: 'Screenshot file', type: 'string', role: 'text.url', ...ro },
    { id: 'images.screenshotTime', name: 'Screenshot taken', type: 'number', role: 'date', ...ro },
    { id: 'images.cameraFront', name: 'Front camera photo file', type: 'string', role: 'text.url', ...ro },
    { id: 'images.cameraFrontTime', name: 'Front camera photo taken', type: 'number', role: 'date', ...ro },
    { id: 'images.cameraBack', name: 'Back camera photo file', type: 'string', role: 'text.url', ...ro },
    { id: 'images.cameraBackTime', name: 'Back camera photo taken', type: 'number', role: 'date', ...ro },
    {
        id: 'images.screenshotAuto',
        name: 'Publish screenshots periodically',
        type: 'boolean',
        role: 'switch.enable',
        ...rw,
        source: 'images.screenshotAuto',
        mqttOnly: true,
    },
    {
        id: 'images.cameraAuto',
        name: 'Publish camera photos periodically',
        type: 'boolean',
        role: 'switch.enable',
        ...rw,
        source: 'images.cameraAuto',
        mqttOnly: true,
    },
    {
        id: 'images.screenshotInterval',
        name: 'Screenshot interval',
        type: 'number',
        role: 'level.timer',
        ...rw,
        unit: 's',
        min: 5,
        max: 3600,
        source: 'images.screenshotInterval',
        mqttOnly: true,
    },
    {
        id: 'images.cameraInterval',
        name: 'Camera photo interval',
        type: 'number',
        role: 'level.timer',
        ...rw,
        unit: 's',
        min: 5,
        max: 3600,
        source: 'images.cameraInterval',
        mqttOnly: true,
    },
    button('commands.reload', 'Reload page'),
    button('commands.wake', 'Wake from screensaver'),
    button('commands.reboot', 'Reboot tablet'),
    button('commands.clearCache', 'Clear web cache'),
    button('commands.lock', 'Lock screen'),
    button('commands.restartUi', 'Restart FreeKiosk UI'),
    button('commands.audioStop', 'Stop audio'),
    button('commands.audioBeep', 'Beep'),
    button('commands.rotationStart', 'Start URL rotation'),
    button('commands.rotationStop', 'Stop URL rotation'),
    button('commands.screenshot', 'Take screenshot'),
    button('commands.cameraFront', 'Take front camera photo'),
    button('commands.cameraBack', 'Take back camera photo'),
    command('commands.tts', 'Speak text', 'media.tts'),
    command('commands.toast', 'Show toast'),
    command('commands.launchApp', 'Launch app (package name)'),
    command('commands.executeJs', 'Run JavaScript in the page'),
    command('commands.audioPlay', 'Play audio (URL or JSON)'),
    command('commands.mode', 'Display mode (JSON)', 'json'),
    button('remote.up', 'Up'),
    button('remote.down', 'Down'),
    button('remote.left', 'Left'),
    button('remote.right', 'Right'),
    button('remote.select', 'Select'),
    button('remote.back', 'Back'),
    button('remote.home', 'Home'),
    button('remote.menu', 'Menu'),
    button('remote.playPause', 'Play/pause'),
    command('remote.key', 'Press key'),
    command('remote.combo', 'Press key combination'),
    command('remote.text', 'Type text'),
];

/**
 * States a tablet with this transport gets.
 *
 * @param transport `'mqtt'` gets every state, `'rest'` skips the MQTT-only ones
 */
export function statesFor(transport: Transport): StateDef[] {
    return transport === 'mqtt' ? STATES : STATES.filter(s => !s.mqttOnly);
}

/** States that only MQTT tablets have; removed when a tablet switches to REST. */
export function mqttOnlyIds(): string[] {
    return STATES.filter(s => s.mqttOnly).map(s => s.id);
}
