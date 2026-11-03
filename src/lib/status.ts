import { isObject, type Transport } from './config';
import { statesFor, type StateDef } from './objects';

export type StateValue = boolean | number | string;

const MAX_STRING = 4096;

function pick(root: Record<string, unknown>, path: string): unknown {
    let current: unknown = root;
    for (const key of path.split('.')) {
        if (!isObject(current) || !Object.hasOwn(current, key)) {
            return undefined;
        }
        current = current[key];
    }
    return current;
}

function fits(def: StateDef, value: unknown): value is StateValue {
    switch (def.type) {
        case 'boolean':
            return typeof value === 'boolean';
        case 'string':
            return typeof value === 'string' && value.length <= MAX_STRING;
        case 'number':
            return (
                typeof value === 'number' &&
                Number.isFinite(value) &&
                (def.min === undefined || value >= def.min) &&
                (def.max === undefined || value <= def.max)
            );
    }
}

/**
 * Turns FreeKiosk's status JSON (REST `data` or MQTT `state`) into state values keyed by the
 * relative state id. Missing fields are left out; fields with a wrong type or out of range are
 * left out and listed in `skipped`, so earlier valid values stay.
 *
 * @param raw the parsed status object; anything that is not a plain object yields `<root>` in `skipped`
 * @param transport decides which MQTT-only states are looked up
 */
export function mapStatus(raw: unknown, transport: Transport): { values: Map<string, StateValue>; skipped: string[] } {
    const values = new Map<string, StateValue>();
    if (!isObject(raw)) {
        return { values, skipped: ['<root>'] };
    }
    const skipped: string[] = [];
    for (const def of statesFor(transport)) {
        if (!def.source) {
            continue;
        }
        const value = pick(raw, def.source);
        if (value === undefined) {
            continue;
        }
        if (fits(def, value)) {
            values.set(def.id, value);
        } else {
            skipped.push(def.source);
        }
    }
    return { values, skipped };
}
