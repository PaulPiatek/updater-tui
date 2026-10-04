/**
 * The update engine: discover sources, scan them, apply the chosen upgrades.
 *
 * Deliberately UI-agnostic — it never imports OpenTUI. The TUI and the
 * non-interactive modes both drive it, and it reports progress through
 * callbacks so the caller can render however it likes.
 */
import type { Source, UpgradeItem, UpgradeOptions, UpgradeResult } from "./types";
import { createSources, findSource } from "./sources";
import { applyConfig, loadConfig } from "./config";
import type { LoadedConfig } from "./config";

/** A source plus whether it can run here. */
export interface AvailableSource {
  source: Source;
  available: boolean;
}

/** Progress events the engine reports while it works. */
export interface EngineEvents {
  /** A source began scanning. */
  onScanStart?(source: Source): void;
  /** A source finished scanning successfully. */
  onScanDone?(source: Source, items: UpgradeItem[]): void;
  /** A source failed to scan. */
  onScanError?(source: Source, message: string): void;
  /** An upgrade finished (per item, or per item within a batch). */
  onResult?(result: UpgradeResult): void;
}

export interface Engine {
  config: LoadedConfig;
  sources: AvailableSource[];
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Loads config and resolves which sources exist and are usable.
 *
 * `sourceFilter` restricts to the given ids (empty means all). Throws a plain
 * `Error` when the filter names nothing or no source is usable, so callers can
 * turn that into a friendly message + exit code.
 */
export async function discover(options: {
  cwd?: string;
  sourceFilter?: string[];
} = {}): Promise<Engine> {
  const config = await loadConfig(options.cwd);
  const candidates = createSources(config).filter(
    (source) =>
      !options.sourceFilter?.length ||
      options.sourceFilter.includes(source.id),
  );

  if (candidates.length === 0) {
    throw new Error(`Unknown source(s): ${options.sourceFilter?.join(", ")}`);
  }

  const sources: AvailableSource[] = [];
  for (const source of candidates) {
    sources.push({ source, available: await source.isAvailable() });
  }

  if (!sources.some((entry) => entry.available)) {
    throw new Error("No usable sources found.");
  }

  return { config, sources };
}

/**
 * Scans the chosen sources concurrently (Windows Update is slow and shouldn't
 * hold up npm/winget) and returns the visible items after ignore/pin rules.
 */
export async function scan(
  engine: Engine,
  wanted: string[],
  events: EngineEvents = {},
): Promise<{
  items: UpgradeItem[];
  ignored: number;
  pinned: number;
  errors: string[];
}> {
  const chosen = engine.sources.filter(
    (entry) => entry.available && wanted.includes(entry.source.id),
  );

  for (const entry of chosen) events.onScanStart?.(entry.source);

  const settled = await Promise.allSettled(
    chosen.map((entry) => entry.source.list()),
  );

  const raw: UpgradeItem[] = [];
  const errors: string[] = [];
  settled.forEach((outcome, index) => {
    const source = chosen[index]!.source;
    if (outcome.status === "fulfilled") {
      raw.push(...outcome.value);
      events.onScanDone?.(source, outcome.value);
    } else {
      const detail = message(outcome.reason);
      errors.push(`${source.title}: ${detail}`);
      events.onScanError?.(source, detail);
    }
  });

  const { kept, ignored, pinned } = applyConfig(raw, engine.config);
  return { items: kept, ignored, pinned, errors };
}

/** Calls `upgradeBatch` when a source supports it, otherwise `upgrade` each. */
export async function applyGroup(
  source: Source,
  items: UpgradeItem[],
  dryRun: boolean,
  events: EngineEvents = {},
  extra: Partial<UpgradeOptions> = {},
): Promise<UpgradeResult[]> {
  const opts: UpgradeOptions = { dryRun, ...extra };

  if (source.upgradeBatch) {
    const results = await source.upgradeBatch(items, opts);
    for (const result of results) events.onResult?.(result);
    return results;
  }

  const results: UpgradeResult[] = [];
  for (const item of items) {
    const result = await source.upgrade(item, opts);
    results.push(result);
    events.onResult?.(result);
  }
  return results;
}

/** Groups items by their source id, in the order the sources were discovered. */
export function groupBySource(
  engine: Engine,
  items: UpgradeItem[],
): Array<{ source: Source; items: UpgradeItem[] }> {
  const groups: Array<{ source: Source; items: UpgradeItem[] }> = [];
  for (const entry of engine.sources) {
    const group = items.filter((item) => item.source === entry.source.id);
    if (group.length > 0) groups.push({ source: entry.source, items: group });
  }
  return groups;
}

/** Resolves a source id back to its `Source`, for callers holding only items. */
export function sourceById(engine: Engine, id: string): Source | undefined {
  return findSource(
    engine.sources.map((entry) => entry.source),
    id,
  );
}

export type { LoadedConfig };
