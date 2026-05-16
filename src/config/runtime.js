import { getConfig } from "./index.js";

function readConfig(getter, fallback) {
    try {
        return getter(getConfig()) ?? fallback;
    } catch {
        return fallback;
    }
}

export function getRuntimeNodeEnv() {
    return readConfig(config => config.nodeEnv, process.env.NODE_ENV || "dev");
}

export function getRuntimeInstanceId() {
    return readConfig(config => config.instance?.id, process.env.INSTANCE_ID || null);
}

export function isRuntimeTestEnv() {
    return getRuntimeNodeEnv() === "test";
}
