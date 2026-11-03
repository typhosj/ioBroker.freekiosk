import { isIP } from 'node:net';

export type Transport = 'rest' | 'mqtt';

/** One validated tablet row. */
export interface DeviceConfig {
    /** Object ID segment, unique case-insensitively */
    id: string;
    /** Display name, falls back to the ID */
    name: string;
    /** How the tablet is reached */
    transport: Transport;
    /** REST only */
    host: string;
    /** REST only, 0 for MQTT */
    port: number;
    /** MQTT only, empty for REST */
    topicId: string;
}

/** Validated instance settings. */
export interface InstanceConfig {
    /** MQTT broker port */
    mqttPort: number;
    /** Root topic for all MQTT tablets */
    mqttBaseTopic: string;
    /** MQTT broker user */
    mqttUser: string;
    /** MQTT broker password */
    mqttPassword: string;
    /** REST poll interval in seconds */
    restInterval: number;
    /** API key for REST tablets, empty when unset */
    restApiKey: string;
    /** Usable tablets only */
    devices: DeviceConfig[];
}

export const MAX_DEVICES = 50;
const DEFAULT_INTERVAL = 30;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_IDS = new Set(['info']);
const HOSTNAME_RE =
    /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const TOPIC_LEVEL_RE = /^[^/+#\s]{1,64}$/;

/**
 * True for a plain, non-null, non-array object.
 *
 * @param value Any value from the native settings or a payload
 */
export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function port(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
}

function interval(value: unknown, errors: string[]): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`REST poll interval "${String(value)}" is invalid, using ${DEFAULT_INTERVAL} s`);
        return DEFAULT_INTERVAL;
    }
    return Math.min(3600, Math.max(5, Math.round(value)));
}

function baseTopic(value: unknown): string | undefined {
    const topic = text(value);
    return topic && !/[+#]/.test(topic) && !topic.startsWith('/') && !topic.endsWith('/') ? topic : undefined;
}

/**
 * Validates the instance's native settings. Invalid tablets are dropped with a message in
 * `errors`; the remaining configuration is always usable.
 *
 * @param native The instance's native settings as read from the adapter object
 */
export function validateConfig(native: Record<string, unknown>): { config: InstanceConfig; errors: string[] } {
    const errors: string[] = [];
    const mqttPort = port(native.mqttPort);
    const mqttBaseTopic = baseTopic(native.mqttBaseTopic);
    const mqttUser = text(native.mqttUser);
    const mqttPassword = typeof native.mqttPassword === 'string' ? native.mqttPassword : '';
    let mqttProblem = '';
    if (mqttPort === undefined) {
        mqttProblem = `MQTT port "${String(native.mqttPort)}" is invalid`;
    } else if (mqttBaseTopic === undefined) {
        mqttProblem = 'MQTT base topic must not be empty or contain +, # or a leading/trailing /';
    } else if (!mqttUser || !mqttPassword) {
        mqttProblem = 'MQTT user and password are required';
    }

    const config: InstanceConfig = {
        mqttPort: mqttPort ?? 1886,
        mqttBaseTopic: mqttBaseTopic ?? 'freekiosk',
        mqttUser,
        mqttPassword,
        restInterval: interval(native.restInterval, errors),
        restApiKey: typeof native.restApiKey === 'string' ? native.restApiKey.trim() : '',
        devices: [],
    };

    const rows = Array.isArray(native.devices) ? native.devices : [];
    if (rows.length > MAX_DEVICES) {
        errors.push(`Only the first ${MAX_DEVICES} tablets are used`);
    }
    const ids = new Set<string>();
    const topics = new Set<string>();
    let mqttSkipped = false;
    for (const [index, row] of rows.slice(0, MAX_DEVICES).entries()) {
        if (!isObject(row) || row.enabled === false) {
            continue;
        }
        const id = text(row.id);
        const name = text(row.name) || id || `row ${index + 1}`;
        const skip = (reason: string): void => {
            errors.push(`Tablet "${name}" skipped: ${reason}`);
        };
        if (!ID_RE.test(id) || RESERVED_IDS.has(id)) {
            skip('object ID must be 1-32 characters A-Z, a-z, 0-9, _ or - and not "info"');
            continue;
        }
        if (ids.has(id.toLowerCase())) {
            skip(`duplicate object ID "${id}"`);
            continue;
        }
        if (row.transport === 'rest') {
            const host = text(row.host);
            const restPort = port(row.port);
            // An IPv6 zone (fe80::1%wlan0) passes isIP, but no URL can be built from it.
            if (host.includes('%') || (!isIP(host) && !HOSTNAME_RE.test(host))) {
                skip('host must be a hostname or IP address without http://, path or IPv6 zone');
                continue;
            }
            if (restPort === undefined) {
                skip(`port "${String(row.port)}" is invalid`);
                continue;
            }
            config.devices.push({ id, name, transport: 'rest', host, port: restPort, topicId: '' });
        } else if (row.transport === 'mqtt') {
            if (mqttProblem) {
                mqttSkipped = true;
                continue;
            }
            const topicId = text(row.topicId) || id.toLowerCase();
            if (!TOPIC_LEVEL_RE.test(topicId)) {
                skip('MQTT topic ID must not contain /, +, # or spaces');
                continue;
            }
            if (topics.has(topicId)) {
                skip(`duplicate MQTT topic ID "${topicId}"`);
                continue;
            }
            topics.add(topicId);
            config.devices.push({ id, name, transport: 'mqtt', host: '', port: 0, topicId });
        } else {
            skip('transport must be REST or MQTT');
            continue;
        }
        ids.add(id.toLowerCase());
    }
    if (mqttSkipped) {
        errors.push(`MQTT tablets skipped: ${mqttProblem}`);
    }
    return { config, errors };
}
