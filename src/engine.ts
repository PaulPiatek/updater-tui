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
import { log } from "./log";

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
  /** Non-fatal problems found during discovery (e.g. unknown `--source` ids). */
  warnings?: string[];
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
  log("discover.start", { cwd: options.cwd ?? process.cwd(), filter: options.sourceFilter ?? [] });
  const config = await loadConfig(options.cwd);
  const all = createSources(config);
  const filter = options.sourceFilter ?? [];
  const candidates = all.filter(
    (source) => filter.length === 0 || filter.includes(source.id),
  );

  if (candidates.length === 0) {
    throw new Error(`Unknown source(s): ${filter.join(", ")}`);
  }

  const sources: AvailableSource[] = [];
  for (const source of candidates) {
    const available = await source.isAvailable();
    sources.push({ source, available });
    // One line per source: "why wasn't X offered?" is otherwise a guess.
    log(
      "discover.source",
      { src: source.id, title: source.title, available },
      available ? "info" : "warn",
    );
  }

  if (!sources.some((entry) => entry.available)) {
    throw new Error("No usable sources found.");
  }

  // A filter that is only partly wrong (`--source npm --source wingett`) still
  // runs, but say which ids were ignored instead of silently dropping them.
  const unknown = filter.filter((id) => !all.some((source) => source.id === id));
  const warnings =
    unknown.length > 0 ? [`Ignoring unknown source(s): ${unknown.join(", ")}`] : [];

  log("discover.done", {
    filter,
    sources: sources.map((entry) => `${entry.source.id}:${entry.available ? "on" : "off"}`),
    warnings,
  });

  return { config, sources, warnings };
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

  const kept: UpgradeItem[] = [];
  const errors: string[] = [];
  let ignored = 0;
  let pinned = 0;

  // One promise per source, each reporting its own outcome the moment it
  // settles — not after all of them do — so the UI can fill in rows live as
  // slower sources (Windows Update, Store) are still running.
  await Promise.all(
    chosen.map(async (entry) => {
      const source = entry.source;
      const startedAt = performance.now();
      log("scan.start", { src: source.id });
      try {
        // Apply the config rules per source *before* reporting, so a live
        // status row counts what the picker will actually show. Ignored items
        // must not read as "N update(s) available".
        const listed = await source.list();
        const applied = applyConfig(listed, engine.config);
        kept.push(...applied.kept);
        ignored += applied.ignored;
        pinned += applied.pinned;
        log("scan.done", {
          src: source.id,
          listed: listed.length,
          items: applied.kept.length,
          ignored: applied.ignored,
          pinned: applied.pinned,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        events.onScanDone?.(source, applied.kept);
      } catch (err) {
        const detail = message(err);
        errors.push(`${source.title}: ${detail}`);
        log(
          "scan.error",
          {
            src: source.id,
            error: detail,
            elapsedMs: Math.round(performance.now() - startedAt),
          },
          "error",
        );
        events.onScanError?.(source, detail);
      }
    }),
  );

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
  const startedAt = performance.now();
  let emitted = 0;
  const emit = (result: UpgradeResult): void => {
    emitted++;
    log(
      "engine.result",
      {
        src: source.id,
        item: result.item.id,
        ok: result.ok,
        error: result.error,
        command: result.command,
      },
      result.ok ? "info" : "warn",
    );
    events.onResult?.(result);
  };

  log("engine.group", {
    src: source.id,
    title: source.title,
    items: items.length,
    batch: typeof source.upgradeBatch === "function",
    dryRun,
  });

  // A source that throws (a spawn failure after discovery, say) must not abort
  // the whole run: turn it into failed results so the remaining groups still
  // run, matching how `scan` contains per-source errors.
  const failed = (item: UpgradeItem, err: unknown): UpgradeResult => ({
    item,
    ok: false,
    command: source.title,
    error: message(err),
  });

  const finish = (results: UpgradeResult[]): UpgradeResult[] => {
    // `returned` vs `emitted` is how a result that was produced but never
    // surfaced (the "did not come back" class of bug) shows up in the log.
    log(
      "engine.group.end",
      {
        src: source.id,
        returned: results.length,
        emitted,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      results.length === emitted ? "info" : "error",
    );
    return results;
  };

  if (source.upgradeBatch) {
    try {
      const results = await source.upgradeBatch(items, opts);
      for (const result of results) emit(result);
      return finish(results);
    } catch (err) {
      const results = items.map((item) => failed(item, err));
      for (const result of results) emit(result);
      return finish(results);
    }
  }

  const results: UpgradeResult[] = [];
  for (const item of items) {
    let result: UpgradeResult;
    try {
      result = await source.upgrade(item, opts);
    } catch (err) {
      result = failed(item, err);
    }
    results.push(result);
    emit(result);
  }
  return finish(results);
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
