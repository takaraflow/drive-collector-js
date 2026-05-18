import dns from "dns/promises";
import http from "http";
import https from "https";
import net from "net";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const USER_AGENT = "drive-collector/4 external-offline-download";
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const UNSUPPORTED_SCHEME_PATTERN = /\b(?:magnet|ed2k|ipfs|ipns|ftp|sftp|smb|file|data|javascript):[^\s<>"'`]*/gi;
const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "www.t.me", "www.telegram.me"]);

export class ExternalUrlPolicyError extends Error {
    constructor(message, code = "EXTERNAL_URL_POLICY_REJECTED") {
        super(message);
        this.name = "ExternalUrlPolicyError";
        this.code = code;
    }
}

function stripTrailingPunctuation(value) {
    return String(value || "").replace(/[),.;\]}]+$/g, "");
}

function parseUrlOrNull(value) {
    try {
        return new URL(stripTrailingPunctuation(value));
    } catch {
        return null;
    }
}

export function redactUrlForDisplay(value) {
    const url = parseUrlOrNull(value);
    if (!url) return "";
    const pathname = decodeSafe(url.pathname || "/");
    const displayPath = pathname.length > 80 ? `${pathname.slice(0, 77)}...` : pathname;
    return `${url.protocol}//${url.host}${displayPath}`;
}

export function urlFingerprint(value) {
    const url = parseUrlOrNull(value);
    if (!url) return "invalid-url";
    const hash = crypto.createHash("sha256").update(url.pathname + url.search).digest("hex").slice(0, 12);
    return `${url.hostname}:${hash}`;
}

export function buildRetainedExternalUrlSourceRef(source = {}) {
    const originalUrl = source.finalUrl || source.url || source.displayUrl || "";
    return {
        displayUrl: source.displayUrl || redactUrlForDisplay(originalUrl),
        fingerprint: source.fingerprint || urlFingerprint(originalUrl),
        fileName: source.fileName || "download.bin",
        fileSize: Number.isFinite(source.fileSize) ? source.fileSize : 0,
        contentType: source.contentType || null,
        probedAt: source.probedAt || null,
        retainedAt: Date.now()
    };
}

export function extractExternalHttpUrls(text = "") {
    const matches = String(text).match(HTTP_URL_PATTERN) || [];
    const urls = [];
    for (const raw of matches) {
        const url = parseUrlOrNull(raw);
        if (!url) continue;
        if (TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) continue;
        if (isTorrentHttpUrl(url)) continue;
        urls.push(url.toString());
    }
    return [...new Set(urls)];
}

export function findUnsupportedExternalLinks(text = "") {
    const unsupported = new Set();
    const schemeMatches = String(text).match(UNSUPPORTED_SCHEME_PATTERN) || [];
    schemeMatches.forEach(item => unsupported.add(stripTrailingPunctuation(item)));

    const httpMatches = String(text).match(HTTP_URL_PATTERN) || [];
    for (const raw of httpMatches) {
        const url = parseUrlOrNull(raw);
        if (url && isTorrentHttpUrl(url)) unsupported.add(url.toString());
    }

    return [...unsupported];
}

export function sanitizeExternalFileName(input, fallback = "download.bin") {
    const decoded = decodeSafe(input || "");
    const base = path.basename(decoded).trim();
    const cleaned = base
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .replace(/[<>:"/\\|?*]+/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^\.+/, "")
        .replace(/\.+$/, "")
        .slice(0, 180)
        .trim();

    return cleaned || fallback;
}

export function buildExternalLocalFileName(taskId, fileName) {
    const safeTaskId = String(taskId || "task").replace(/[^A-Za-z0-9_-]/g, "");
    const safeFileName = sanitizeExternalFileName(fileName || "download.bin");
    return sanitizeExternalFileName(`${safeTaskId}-${safeFileName}`);
}

export async function probeExternalUrl(input, options = {}) {
    const fetchImpl = options.fetchImpl;
    const originalUrl = normalizeExternalUrl(input);
    const response = await requestExternalUrl(originalUrl, {
        ...options,
        fetchImpl,
        method: "HEAD",
        rangeProbe: false
    }).catch(async (error) => {
        if (error?.code === "EXTERNAL_URL_HTTP_STATUS") {
            return await requestExternalUrl(originalUrl, {
                ...options,
                fetchImpl,
                method: "GET",
                rangeProbe: true
            });
        }
        throw error;
    });

    await response.response?.body?.cancel?.().catch?.(() => {});
    const headers = response.response.headers;
    const contentLength = parseContentLength(headers);
    const fileName = resolveExternalFileName(response.finalUrl, headers);
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
    if (contentLength > maxBytes) {
        throw new ExternalUrlPolicyError("External file is larger than the configured limit", "EXTERNAL_URL_TOO_LARGE");
    }

    return {
        url: originalUrl.toString(),
        finalUrl: response.finalUrl.toString(),
        displayUrl: redactUrlForDisplay(response.finalUrl),
        fileName,
        fileSize: contentLength,
        contentType: headers.get("content-type") || null,
        probedAt: Date.now()
    };
}

export async function openExternalUrlStream(input, options = {}) {
    const response = await requestExternalUrl(normalizeExternalUrl(input), {
        ...options,
        fetchImpl: options.fetchImpl,
        method: "GET",
        rangeProbe: false
    });
    const contentLength = parseContentLength(response.response.headers);
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
    if (contentLength > maxBytes) {
        await response.response.body?.cancel?.().catch(() => {});
        throw new ExternalUrlPolicyError("External file is larger than the configured limit", "EXTERNAL_URL_TOO_LARGE");
    }
    return {
        response: response.response,
        finalUrl: response.finalUrl,
        contentLength,
        contentType: response.response.headers.get("content-type") || null
    };
}

async function requestExternalUrl(inputUrl, options = {}) {
    const fetchImpl = options.fetchImpl;
    const lookupImpl = options.lookupImpl || dns.lookup;
    const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : DEFAULT_MAX_REDIRECTS;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const method = options.method || "GET";

    let currentUrl = normalizeExternalUrl(inputUrl);
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        const addresses = await assertUrlNetworkSafe(currentUrl, { lookupImpl });
        const response = await requestWithPinnedNetwork(fetchImpl, currentUrl, {
            method,
            redirect: "manual",
            headers: {
                "user-agent": USER_AGENT,
                "accept": "*/*",
                ...(options.rangeProbe ? { "range": "bytes=0-0" } : {})
            }
        }, {
            timeoutMs,
            addresses,
            requestImpl: options.requestImpl
        });

        if (isRedirectStatus(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel?.().catch(() => {});
            if (!location) {
                throw new ExternalUrlPolicyError("External URL redirect is missing Location", "EXTERNAL_URL_BAD_REDIRECT");
            }
            currentUrl = normalizeExternalUrl(new URL(location, currentUrl));
            continue;
        }

        if (!response.ok && response.status !== 206) {
            await response.body?.cancel?.().catch(() => {});
            throw new ExternalUrlPolicyError(`External URL returned HTTP ${response.status}`, "EXTERNAL_URL_HTTP_STATUS");
        }

        return { response, finalUrl: currentUrl };
    }

    throw new ExternalUrlPolicyError("External URL has too many redirects", "EXTERNAL_URL_TOO_MANY_REDIRECTS");
}

function normalizeExternalUrl(input) {
    const url = input instanceof URL ? new URL(input.toString()) : parseUrlOrNull(input);
    if (!url) {
        throw new ExternalUrlPolicyError("Invalid external URL", "EXTERNAL_URL_INVALID");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ExternalUrlPolicyError("Only HTTP/HTTPS links are supported", "EXTERNAL_URL_UNSUPPORTED_SCHEME");
    }
    if (url.username || url.password) {
        throw new ExternalUrlPolicyError("External URL credentials are not supported", "EXTERNAL_URL_CREDENTIALS");
    }
    if (!url.hostname) {
        throw new ExternalUrlPolicyError("External URL hostname is required", "EXTERNAL_URL_HOST_REQUIRED");
    }
    if (isTorrentHttpUrl(url)) {
        throw new ExternalUrlPolicyError("Torrent links are not supported", "EXTERNAL_URL_P2P_UNSUPPORTED");
    }
    url.hash = "";
    return url;
}

async function assertUrlNetworkSafe(url, { lookupImpl }) {
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
        throw new ExternalUrlPolicyError("Localhost URLs are not allowed", "EXTERNAL_URL_PRIVATE_HOST");
    }

    const ipVersion = net.isIP(hostname);
    const addresses = ipVersion
        ? [{ address: hostname, family: ipVersion }]
        : await lookupImpl(hostname, { all: true, verbatim: true });

    if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new ExternalUrlPolicyError("External URL hostname could not be resolved", "EXTERNAL_URL_DNS_FAILED");
    }

    for (const entry of addresses) {
        if (isBlockedIp(entry.address)) {
            throw new ExternalUrlPolicyError("External URL resolves to a private or reserved network", "EXTERNAL_URL_PRIVATE_HOST");
        }
    }

    return addresses.map(entry => ({
        address: entry.address,
        family: entry.family || net.isIP(entry.address)
    }));
}

function isTorrentHttpUrl(url) {
    return decodeSafe(url.pathname).toLowerCase().endsWith(".torrent");
}

function decodeSafe(value) {
    try {
        return decodeURIComponent(String(value || ""));
    } catch {
        return String(value || "");
    }
}

function parseContentLength(headers) {
    const contentRange = headers.get("content-range");
    const rangeMatch = contentRange && contentRange.match(/\/(\d+)$/);
    if (rangeMatch) {
        const total = Number.parseInt(rangeMatch[1], 10);
        if (Number.isFinite(total)) return total;
    }

    const contentLength = Number.parseInt(headers.get("content-length") || "0", 10);
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
}

function resolveExternalFileName(url, headers) {
    const fromDisposition = parseContentDispositionFileName(headers.get("content-disposition"));
    if (fromDisposition) return sanitizeExternalFileName(fromDisposition);

    const pathName = decodeSafe(url.pathname || "");
    const fromPath = path.basename(pathName);
    return sanitizeExternalFileName(fromPath, "download.bin");
}

function parseContentDispositionFileName(value) {
    if (!value) return null;
    const starMatch = value.match(/filename\*\s*=\s*([^;]+)/i);
    if (starMatch) {
        const raw = starMatch[1].trim().replace(/^"|"$/g, "");
        const encoded = raw.includes("''") ? raw.split("''").slice(1).join("''") : raw;
        return decodeSafe(encoded);
    }

    const quotedMatch = value.match(/filename\s*=\s*"([^"]+)"/i);
    if (quotedMatch) return quotedMatch[1];

    const plainMatch = value.match(/filename\s*=\s*([^;]+)/i);
    return plainMatch ? plainMatch[1].trim() : null;
}

function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function requestWithPinnedNetwork(fetchImpl, url, init, options = {}) {
    if (options.requestImpl) {
        return await options.requestImpl(url, init, options);
    }
    if (fetchImpl) {
        return await fetchWithTimeout(fetchImpl, url, init, options.timeoutMs);
    }
    return await nodeRequestWithPinnedLookup(url, init, options);
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new ExternalUrlPolicyError("External URL request timed out", "EXTERNAL_URL_TIMEOUT");
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function nodeRequestWithPinnedLookup(url, init, options = {}) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === "https:" ? https : http;
        const addresses = options.addresses || [];
        const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        let settled = false;

        const lookup = (_hostname, lookupOptions, callback) => {
            if (typeof lookupOptions === "function") {
                callback = lookupOptions;
                lookupOptions = {};
            }

            if (lookupOptions?.all) {
                callback(null, addresses.map(entry => ({ address: entry.address, family: entry.family })));
                return;
            }

            const requestedFamily = lookupOptions?.family;
            const selected = addresses.find(entry => entry.family === requestedFamily) || addresses[0];
            if (!selected) {
                callback(new ExternalUrlPolicyError("External URL hostname could not be resolved", "EXTERNAL_URL_DNS_FAILED"));
                return;
            }
            callback(null, selected.address, selected.family);
        };

        const request = transport.request(url, {
            method: init.method,
            headers: init.headers,
            timeout: timeoutMs,
            lookup,
            servername: url.hostname
        }, response => {
            settled = true;
            resolve(createResponseAdapter(response));
        });

        request.on("timeout", () => {
            request.destroy(new ExternalUrlPolicyError("External URL request timed out", "EXTERNAL_URL_TIMEOUT"));
        });
        request.on("error", error => {
            if (!settled) reject(error);
        });
        request.end();
    });
}

function createResponseAdapter(response) {
    const status = response.statusCode || 0;
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: {
            get(name) {
                const value = response.headers[String(name || "").toLowerCase()];
                if (Array.isArray(value)) return value.join(", ");
                return value == null ? null : String(value);
            }
        },
        body: Readable.toWeb(response)
    };
}

function isBlockedIp(address) {
    const version = net.isIP(address);
    if (version === 4) return isBlockedIpv4(address);
    if (version === 6) return isBlockedIpv6(address);
    return true;
}

function ipv4ToInt(ip) {
    return ip.split(".").reduce((acc, octet) => ((acc << 8) + Number.parseInt(octet, 10)) >>> 0, 0);
}

function ipv4InCidr(ip, base, bits) {
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function isBlockedIpv4(ip) {
    return [
        ["0.0.0.0", 8],
        ["10.0.0.0", 8],
        ["100.64.0.0", 10],
        ["127.0.0.0", 8],
        ["169.254.0.0", 16],
        ["172.16.0.0", 12],
        ["192.0.0.0", 24],
        ["192.0.2.0", 24],
        ["192.168.0.0", 16],
        ["198.18.0.0", 15],
        ["198.51.100.0", 24],
        ["203.0.113.0", 24],
        ["224.0.0.0", 4],
        ["240.0.0.0", 4]
    ].some(([base, bits]) => ipv4InCidr(ip, base, bits));
}

function isBlockedIpv6(ip) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIpv4(mapped[1]);

    const value = ipv6ToBigInt(ip);
    if (value === null) return true;

    return [
        ["::", 128],
        ["::1", 128],
        ["::ffff:0:0", 96],
        ["64:ff9b::", 96],
        ["fc00::", 7],
        ["fe80::", 10],
        ["ff00::", 8],
        ["2001:db8::", 32]
    ].some(([base, bits]) => ipv6InCidr(value, base, bits));
}

function ipv6InCidr(value, base, bits) {
    const baseValue = ipv6ToBigInt(base);
    if (baseValue === null) return false;
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return (value & mask) === (baseValue & mask);
}

function ipv6ToBigInt(ip) {
    try {
        const lower = ip.toLowerCase();
        const [headRaw, tailRaw] = lower.split("::");
        const head = headRaw ? headRaw.split(":").filter(Boolean) : [];
        const tail = tailRaw ? tailRaw.split(":").filter(Boolean) : [];
        const parts = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
        if (parts.length !== 8) return null;
        return parts.reduce((acc, part) => (acc << 16n) + BigInt(Number.parseInt(part || "0", 16)), 0n);
    } catch {
        return null;
    }
}
