import * as utils from '@iobroker/adapter-core';
import { Broker } from './lib/broker';
import { buildCommand, type ImageKind } from './lib/commands';
import { validateConfig, type DeviceConfig, type InstanceConfig } from './lib/config';
import { CHANNELS, mqttOnlyIds, statesFor, type StateDef } from './lib/objects';
import { fetchImage, fetchStatus, HttpError, Poller, sendRest, type RestTarget } from './lib/rest';
import { latestOnly } from './lib/latest';
import { mapStatus } from './lib/status';

interface Tablet {
    config: DeviceConfig;
    online: boolean;
    failLogged: boolean;
    poller?: Poller;
    submitStatus: (raw: unknown) => void;
}

function errorText(err: unknown): string {
    if (!(err instanceof Error)) {
        return String(err);
    }
    const cause: unknown = err.cause;
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
    return typeof code === 'string' ? `${err.message} (${code})` : err.message;
}

function commonOf(def: StateDef): ioBroker.StateCommon {
    const common: ioBroker.StateCommon = {
        name: def.name,
        type: def.type,
        role: def.role,
        read: def.read,
        write: def.write,
    };
    if (def.unit !== undefined) {
        common.unit = def.unit;
    }
    if (def.min !== undefined) {
        common.min = def.min;
    }
    if (def.max !== undefined) {
        common.max = def.max;
    }
    return common;
}

class Freekiosk extends utils.Adapter {
    private settings?: InstanceConfig;
    private readonly tablets = new Map<string, Tablet>();
    private readonly byTopic = new Map<string, Tablet>();
    private broker?: Broker;
    private stopping = false;
    private readonly abort = new AbortController();

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'freekiosk' });
        this.on('ready', () => {
            this.onReady().catch(async err => {
                this.log.error(
                    `Start failed: ${errorText(err)}; the adapter stays idle until the instance is restarted`,
                );
                await this.stopAll();
            });
        });
        this.on('unload', callback => {
            void this.onUnload(callback);
        });
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);
        const { config, errors } = validateConfig(this.config as unknown as Record<string, unknown>);
        for (const message of errors) {
            this.log.error(message);
        }
        this.settings = config;
        if (!config.devices.length) {
            this.log.warn('No valid tablet configured; add one in the instance settings.');
            return;
        }
        for (const device of config.devices) {
            const tablet: Tablet = {
                config: device,
                online: false,
                failLogged: false,
                submitStatus: latestOnly(
                    raw => this.applyStatus(tablet, raw),
                    err => this.log.warn(`${device.name}: status not stored: ${errorText(err)}`),
                ),
            };
            this.tablets.set(device.id, tablet);
            if (device.transport === 'mqtt') {
                this.byTopic.set(device.topicId, tablet);
            }
            await this.createObjects(device);
            if (this.stopping) {
                return;
            }
        }
        if (this.byTopic.size) {
            await this.startBroker(config);
            if (this.stopping) {
                return;
            }
        }
        for (const tablet of this.tablets.values()) {
            if (tablet.config.transport === 'rest') {
                this.startPolling(tablet, config.restInterval);
            }
        }
        if (this.stopping) {
            return;
        }
        this.on('stateChange', (id, state) => {
            this.onStateChange(id, state).catch(err => this.log.error(`Command ${id} failed: ${errorText(err)}`));
        });
        for (const tablet of this.tablets.values()) {
            for (const def of statesFor(tablet.config.transport).filter(s => s.write)) {
                await this.subscribeStatesAsync(`${tablet.config.id}.${def.id}`);
                if (this.stopping) {
                    return;
                }
            }
        }
    }

    private async createObjects(device: DeviceConfig): Promise<void> {
        await this.extendObjectAsync(device.id, { type: 'device', common: { name: device.name }, native: {} });
        const defs = statesFor(device.transport);
        for (const channel of new Set(defs.map(def => def.id.split('.')[0]))) {
            await this.setObjectNotExistsAsync(`${device.id}.${channel}`, {
                type: 'channel',
                common: { name: CHANNELS[channel] },
                native: {},
            });
        }
        for (const def of defs) {
            await this.setObjectNotExistsAsync(`${device.id}.${def.id}`, {
                type: 'state',
                common: commonOf(def),
                native: {},
            });
        }
        if (device.transport === 'rest') {
            for (const id of mqttOnlyIds()) {
                const full = `${device.id}.${id}`;
                if (await this.getObjectAsync(full)) {
                    await this.delObjectAsync(full);
                }
            }
        }
        await this.setStateAsync(`${device.id}.info.transport`, device.transport, true);
        await this.setStateAsync(`${device.id}.info.online`, false, true);
    }

    private target(tablet: Tablet): RestTarget {
        return { host: tablet.config.host, port: tablet.config.port, apiKey: this.settings?.restApiKey ?? '' };
    }

    private startPolling(tablet: Tablet, intervalSec: number): void {
        tablet.poller = new Poller(() => this.pollOnce(tablet, intervalSec), intervalSec * 1000, {
            set: (fn, ms) => this.setTimeout(fn, ms),
            clear: handle => this.clearTimeout(handle as ioBroker.Timeout),
        });
        tablet.poller.start();
    }

    private async pollOnce(tablet: Tablet, intervalSec: number): Promise<void> {
        const { name, host } = tablet.config;
        try {
            const status = await fetchStatus(this.target(tablet), this.abort.signal);
            if (this.stopping) {
                return;
            }
            if (!tablet.online) {
                this.log.info(`${name} (${host}) is reachable`);
            }
            tablet.failLogged = false;
            await this.setOnline(tablet, true);
            await this.applyStatus(tablet, status);
        } catch (err) {
            if (this.stopping) {
                return;
            }
            if (err instanceof HttpError && err.status === 401) {
                this.log.error(`${name} (${host}) rejected the API key; polling stops until the instance restarts`);
                tablet.poller?.stop();
            } else if (!tablet.failLogged) {
                this.log.warn(`${name} (${host}) not reachable: ${errorText(err)}; retrying every ${intervalSec} s`);
                tablet.failLogged = true;
            } else {
                this.log.debug(`${name} (${host}) still not reachable: ${errorText(err)}`);
            }
            await this.setOnline(tablet, false);
        }
    }

    private async startBroker(config: InstanceConfig): Promise<void> {
        const tabletOf = (topicId: string): Tablet | undefined => this.byTopic.get(topicId);
        try {
            const broker = await Broker.start(
                {
                    port: config.mqttPort,
                    baseTopic: config.mqttBaseTopic,
                    user: config.mqttUser,
                    password: config.mqttPassword,
                    topicIds: [...this.byTopic.keys()],
                },
                {
                    status: (topicId, raw) => {
                        const tablet = tabletOf(topicId);
                        if (tablet && !this.stopping) {
                            tablet.submitStatus(raw);
                        }
                    },
                    online: (topicId, online) => {
                        const tablet = tabletOf(topicId);
                        if (tablet && !this.stopping) {
                            this.log.info(`${tablet.config.name} ${online ? 'connected' : 'disconnected'} (MQTT)`);
                            this.setOnline(tablet, online).catch(err =>
                                this.log.warn(`${tablet.config.name}: ${errorText(err)}`),
                            );
                        }
                    },
                    image: (topicId, kind, data) => {
                        const tablet = tabletOf(topicId);
                        if (tablet && !this.stopping) {
                            this.storeImage(tablet, kind, data, 'jpg').catch(err =>
                                this.log.warn(`${tablet.config.name}: image not stored: ${errorText(err)}`),
                            );
                        }
                    },
                    unknownTablet: topicId =>
                        this.log.info(`Tablet "${topicId}" connected but is not in the device table`),
                    dropped: (topicId, reason) => this.log.warn(`${topicId}: message dropped, ${reason}`),
                    error: err => this.log.error(`MQTT broker: ${errorText(err)}`),
                },
            );
            if (this.stopping) {
                await broker.close();
                return;
            }
            this.broker = broker;
            this.log.info(`MQTT broker listening on port ${config.mqttPort}`);
        } catch (err) {
            this.log.error(
                `MQTT broker could not start on port ${config.mqttPort}: ${errorText(err)}. MQTT tablets stay offline; check the port in the instance settings.`,
            );
        }
    }

    private async applyStatus(tablet: Tablet, raw: unknown): Promise<void> {
        if (this.stopping) {
            return;
        }
        const { values, skipped } = mapStatus(raw, tablet.config.transport);
        if (skipped.length) {
            this.log.debug(`${tablet.config.name}: skipped status fields ${skipped.join(', ')}`);
        }
        for (const [id, value] of values) {
            if (this.stopping) {
                return;
            }
            await this.setStateChangedAsync(`${tablet.config.id}.${id}`, value, true);
        }
        await this.setStateAsync(`${tablet.config.id}.info.lastUpdate`, Date.now(), true);
    }

    private async setOnline(tablet: Tablet, online: boolean): Promise<void> {
        if (this.stopping || tablet.online === online) {
            return;
        }
        tablet.online = online;
        await this.setStateAsync(`${tablet.config.id}.info.online`, online, true);
        const all = [...this.tablets.values()].every(t => t.online);
        await this.setStateAsync('info.connection', all, true);
    }

    private async storeImage(tablet: Tablet, kind: ImageKind, data: Buffer, ext: 'png' | 'jpg'): Promise<void> {
        const file = `${tablet.config.id}/${kind}.${ext}`;
        await this.writeFileAsync(this.namespace, file, data);
        await this.setStateAsync(`${tablet.config.id}.images.${kind}`, `/${this.namespace}/${file}`, true);
        await this.setStateAsync(`${tablet.config.id}.images.${kind}Time`, Date.now(), true);
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || this.stopping) {
            return;
        }
        const relative = id.slice(this.namespace.length + 1);
        const dot = relative.indexOf('.');
        const tablet = this.tablets.get(relative.slice(0, dot));
        if (!tablet) {
            return;
        }
        const stateId = relative.slice(dot + 1);
        const { name, transport } = tablet.config;
        const built = buildCommand(stateId, state.val);
        if ('error' in built) {
            this.log.warn(`${name} ${stateId}: ${built.error}; nothing sent`);
            return;
        }
        if (!tablet.online) {
            this.log.warn(`${name} is offline; ${stateId} not sent`);
            return;
        }
        const command = built.command;
        try {
            if (transport === 'rest') {
                if (command.rest) {
                    await sendRest(this.target(tablet), command.rest, this.abort.signal);
                } else if (command.image) {
                    const image = await fetchImage(this.target(tablet), command.image, this.abort.signal);
                    await this.storeImage(tablet, command.image, image.data, image.ext);
                } else {
                    this.log.warn(`${name}: ${stateId} is not available over REST`);
                    return;
                }
                tablet.poller?.trigger();
            } else {
                if (!command.mqtt || !this.broker) {
                    this.log.warn(`${name}: ${stateId} is not available over MQTT`);
                    return;
                }
                await this.broker.publish(tablet.config.topicId, command.mqtt.entity, command.mqtt.payload);
            }
            await this.setStateAsync(id, command.ackValue, true);
            this.log.debug(`${name}: ${stateId} sent`);
        } catch (err) {
            if (this.stopping) {
                return;
            }
            if (err instanceof HttpError && err.status === 403) {
                this.log.warn(`${name}: remote control is disabled in FreeKiosk; ${stateId} not executed`);
            } else {
                this.log.warn(`${name}: ${stateId} failed: ${errorText(err)}`);
            }
        }
    }

    /** Stops all work and closes the broker; safe to call twice. */
    private async stopAll(): Promise<void> {
        this.stopping = true;
        this.abort.abort();
        for (const tablet of this.tablets.values()) {
            tablet.poller?.stop();
        }
        const broker = this.broker;
        this.broker = undefined;
        await broker?.close();
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            await this.stopAll();
            for (const tablet of this.tablets.values()) {
                await this.setStateAsync(`${tablet.config.id}.info.online`, false, true);
            }
            await this.setStateAsync('info.connection', false, true);
        } catch (err) {
            this.log.error(`Unload: ${errorText(err)}`);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Freekiosk(options);
} else {
    (() => new Freekiosk())();
}
