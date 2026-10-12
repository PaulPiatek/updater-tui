import type { Source, UpgradeItem, UpgradeOptions, UpgradeResult } from "../types";
import { run, which } from "../proc";

const NPM = which("npm", "npm");

interface NpmOutdatedEntry {
  current?: string;
  wanted?: string;
  latest?: string;
  location?: string;
}

/** Pulls npm's human-readable message out of a JSON error object. */
function npmErrorDetail(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary : undefined;
  const detail = typeof record.detail === "string" ? record.detail : undefined;
  return summary ?? detail;
}

/**
 * Upgrades globally installed npm packages.
 *
 * Listing uses `npm outdated -g --json`, which reports every global package
 * whose installed version differs from the registry's `latest` (or `wanted`).
 */
export const npmSource: Source = {
  id: "npm",
  title: "Global npm packages",

  async isAvailable(): Promise<boolean> {
    try {
      const res = await run([NPM, "--version"]);
      return res.code === 0;
    } catch {
      return false;
    }
  },

  async list(): Promise<UpgradeItem[]> {
    const res = await run([NPM, "outdated", "-g", "--json"]);

    // npm exits 0 when everything is current, 1 when outdated packages exist.
    // Anything else is a real failure. Empty stdout means "nothing outdated".
    const text = res.stdout.trim();
    if (!text) {
      if (res.code !== 0 && res.code !== 1) {
        throw new Error(res.stderr.trim() || `npm outdated exited with code ${res.code}`);
      }
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const record = parsed as Record<string, unknown>;

    // npm prints its failures as a JSON object on **stdout** too (still exit 1),
    // e.g. `{"error":{"code":"ECONNREFUSED","summary":"FetchError: ..."}}`. That
    // is not a package list — surfacing it avoids listing a bogus "error"
    // package that `upgrade` would then try to `npm install -g`.
    if (record.error !== undefined) {
      throw new Error(npmErrorDetail(record.error) ?? "npm outdated failed");
    }

    const data = record as Record<string, NpmOutdatedEntry>;
    return Object.entries(data)
      .filter(([, info]) => Boolean(info?.current || info?.latest || info?.wanted))
      .map(([name, info]) => {
        const current = info.current ?? "unknown";
        const latest = info.latest ?? info.wanted ?? "unknown";
        return {
          id: `npm:${name}`,
          source: "npm",
          name,
          current,
          latest,
          meta: info.location ? { location: info.location } : undefined,
        } satisfies UpgradeItem;
      });
  },

  async upgrade(item, opts: UpgradeOptions): Promise<UpgradeResult> {
    const command = `npm install -g ${item.name}@latest`;

    if (opts.dryRun) {
      return { item, ok: true, command };
    }

    const res = await run([NPM, "install", "-g", `${item.name}@latest`]);
    const output = `${res.stdout}${res.stderr}`.trim();

    return {
      item,
      ok: res.code === 0,
      command,
      output,
      error:
        res.code === 0
          ? undefined
          : res.stderr.trim() || output || `exit code ${res.code}`,
    };
  },
};
