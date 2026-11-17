// Typed reads of a stack's config block, failing at synth with the key's name when a value is missing or mistyped.

import { StackConfig } from './app-context';

function describe(stackConfig: StackConfig, key: string): string {
    return `Stack.${stackConfig.ShortStackName}.${key}`;
}

export function configString(stackConfig: StackConfig, key: string, fallback?: string): string {
    const value = stackConfig[key] ?? fallback;
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`[config] ${describe(stackConfig, key)} must be a non-empty string`);
    }
    return value;
}

export function configNumber(stackConfig: StackConfig, key: string, fallback?: number): number {
    const value = stackConfig[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`[config] ${describe(stackConfig, key)} must be a number`);
    }
    return value;
}

export function configBoolean(stackConfig: StackConfig, key: string, fallback: boolean): boolean {
    const value = stackConfig[key] ?? fallback;
    if (typeof value !== 'boolean') throw new Error(`[config] ${describe(stackConfig, key)} must be true or false`);
    return value;
}

export function configStringList(stackConfig: StackConfig, key: string, fallback: string[] = []): string[] {
    const value = stackConfig[key] ?? fallback;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
        throw new Error(`[config] ${describe(stackConfig, key)} must be a list of strings`);
    }
    return value as string[];
}

export function configNumberList(stackConfig: StackConfig, key: string, fallback: number[] = []): number[] {
    const value = stackConfig[key] ?? fallback;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
        throw new Error(`[config] ${describe(stackConfig, key)} must be a list of numbers`);
    }
    return value as number[];
}

/** Extra environment variables for a Lambda, e.g. `{ "DETECTOR": "acpds_yolo" }`. */
export function configEnvironment(stackConfig: StackConfig, key = 'Environment'): Record<string, string> {
    const value = stackConfig[key] ?? {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`[config] ${describe(stackConfig, key)} must be an object of strings`);
    }
    for (const [name, item] of Object.entries(value)) {
        if (typeof item !== 'string') throw new Error(`[config] ${describe(stackConfig, key)}.${name} must be a string`);
    }
    return value as Record<string, string>;
}
