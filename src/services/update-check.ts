import { userStoreFolder } from "@powerhousedao/ph-clint";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import gtSemver from "semver/functions/gt.js";
import cleanSemver from "semver/functions/clean.js";
import validSemver from "semver/functions/valid.js";
import { CLI_NAME, CLI_PACKAGE_NAME, CLI_VERSION } from "../config.js";

const REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
    checkedAt: string;
    latest: string;
}

function cachePath(): string {
    return userStoreFolder(CLI_NAME, "update-cache.json");
}

function readCache(): CacheEntry | null {
    try {
        const raw = readFileSync(cachePath(), "utf8");
        const parsed = JSON.parse(raw) as Partial<CacheEntry>;
        if (!parsed.checkedAt || !parsed.latest) return null;
        return parsed as CacheEntry;
    } catch {
        return null;
    }
}

function writeCache(entry: CacheEntry): void {
    const path = cachePath();
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(entry, null, 2), "utf8");
    } catch {
        // best-effort; never fail the calling command on cache errors
    }
}

async function fetchLatestFromRegistry(
    pkgName: string,
    distTag: string,
    timeoutMs: number,
): Promise<string | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(
            `${REGISTRY_URL}/${encodeURIComponent(pkgName)}/${encodeURIComponent(distTag)}`,
            { signal: ctrl.signal, headers: { accept: "application/json" } },
        );
        // 404 = package or dist-tag not published yet. Not an error worth
        // surfacing to the user — a brand-new CLI just hasn't been released.
        if (res.status === 404) return null;
        if (!res.ok) {
            throw new Error(
                `npm registry returned ${res.status} ${res.statusText} for ${pkgName}@${distTag}`,
            );
        }
        const body = (await res.json()) as { version?: string };
        if (!body.version || !validSemver(body.version)) {
            throw new Error(
                `npm registry response missing a valid version for ${pkgName}@${distTag}`,
            );
        }
        return body.version;
    } finally {
        clearTimeout(timer);
    }
}

export interface VersionCheckOptions {
    /** Bypass the on-disk cache and fetch fresh from the registry. */
    force?: boolean;
    /** Cache TTL in ms. Default: 24h. */
    ttlMs?: number;
    /** Network timeout in ms. Default: 4s — keep `status` snappy. */
    timeoutMs?: number;
    /** Dist-tag to compare against. Default: `latest`. */
    distTag?: string;
}

export interface VersionCheckResult {
    current: string;
    latest: string | null;
    outdated: boolean;
    fromCache: boolean;
    error?: string;
}

/**
 * Resolve the latest published version of ph-porter.
 *
 * Reads `~/.ph/ph-porter/update-cache.json` first; if the entry is younger
 * than `ttlMs` and `force` is not set, returns the cached value to avoid
 * hammering the registry on every `status` invocation. Network/parse failures
 * never throw — they're surfaced via `error` so callers can degrade gracefully
 * (e.g., `status` continues without the staleness banner).
 */
export async function checkLatestVersion(
    options: VersionCheckOptions = {},
): Promise<VersionCheckResult> {
    const {
        force = false,
        ttlMs = DEFAULT_TTL_MS,
        timeoutMs = 4000,
        distTag = "latest",
    } = options;

    const current = cleanSemver(CLI_VERSION) ?? CLI_VERSION;

    if (!force && distTag === "latest") {
        const cached = readCache();
        if (cached) {
            const age = Date.now() - new Date(cached.checkedAt).getTime();
            if (age >= 0 && age < ttlMs) {
                return {
                    current,
                    latest: cached.latest,
                    outdated:
                        validSemver(cached.latest) && validSemver(current)
                            ? gtSemver(cached.latest, current)
                            : false,
                    fromCache: true,
                };
            }
        }
    }

    try {
        const latest = await fetchLatestFromRegistry(
            CLI_PACKAGE_NAME,
            distTag,
            timeoutMs,
        );
        if (latest && distTag === "latest") {
            writeCache({ checkedAt: new Date().toISOString(), latest });
        }
        return {
            current,
            latest,
            outdated:
                latest && validSemver(latest) && validSemver(current)
                    ? gtSemver(latest, current)
                    : false,
            fromCache: false,
        };
    } catch (err) {
        return {
            current,
            latest: null,
            outdated: false,
            fromCache: false,
            error: (err as Error).message,
        };
    }
}

export function clearVersionCache(): void {
    try {
        const path = cachePath();
        if (existsSync(path)) {
            writeFileSync(path, "", "utf8");
        }
    } catch {
        // best-effort
    }
}
