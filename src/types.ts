/**
 * Shared types for the updater.
 *
 * Everything the UI and runner need is expressed through `Source`, so adding a
 * new package manager later only means implementing this interface.
 */

/** A single package/service that has an upgrade available. */
export interface UpgradeItem {
  /** Unique id across all sources, e.g. `npm:@opencode/cli`. */
  id: string;
  /** Id of the source that produced this item, e.g. `npm`. */
  source: string;
  /** Name shown in the picker. */
  name: string;
  /** Currently installed version. */
  current: string;
  /** Version we would upgrade to. */
  latest: string;
  /**
   * Optional override for the picker's right-hand text. Sources whose items
   * don't fit the `current → latest` shape (e.g. Windows updates) can use this.
   */
  hint?: string;
  /** Optional extra data a source wants to carry around. */
  meta?: Record<string, unknown>;
  /** Set by the config layer when a package is pinned (locked, not upgradable). */
  pinned?: boolean;
  /**
   * Locked by the source itself (e.g. a custom script whose executable is
   * missing). Shown greyed out and not selectable, but unlike `pinned` it is
   * not written to config.
   */
  disabled?: boolean;
}

/** Outcome of upgrading a single item. */
export interface UpgradeResult {
  item: UpgradeItem;
  /** Whether the upgrade succeeded (always true in dry-run). */
  ok: boolean;
  /** The command that was, or in dry-run would be, executed. */
  command: string;
  /** Error message when `ok` is false. */
  error?: string;
  /** Combined stdout/stderr, useful for debugging failures. */
  output?: string;
  /** Whether the change only takes effect after a restart (e.g. some updates). */
  rebootRequired?: boolean;
}

export interface UpgradeOptions {
  /** When true, report the command without executing it. */
  dryRun: boolean;
}

/**
 * How the runner should present a source's progress while it works.
 * `stream` means the source writes to the terminal itself, so the runner must
 * stop its spinner first (otherwise the two fight over the same lines).
 */
export type RunMode = "spinner" | "stream";

/** A source of upgradable things (npm globals today, brew/winget/... later). */
export interface Source {
  /** Stable id, e.g. `npm`. */
  id: string;
  /** Human readable title, e.g. `Global npm packages`. */
  title: string;
  /**
   * Optional: how to present this source while upgrading. Defaults to
   * `spinner`. Use `stream` for sources that print to the terminal directly.
   */
  runMode?: RunMode;
  /** Whether this source can run on the current system. */
  isAvailable(): Promise<boolean>;
  /** List everything that has an available upgrade. */
  list(): Promise<UpgradeItem[]>;
  /** Upgrade a single item. */
  upgrade(item: UpgradeItem, opts: UpgradeOptions): Promise<UpgradeResult>;
  /**
   * Optional: upgrade several items in one go. The runner prefers this over
   * repeated `upgrade()` calls, which lets a source batch work (e.g. install
   * all Windows updates in a single elevated process / UAC prompt).
   */
  upgradeBatch?(
    items: UpgradeItem[],
    opts: UpgradeOptions,
  ): Promise<UpgradeResult[]>;
}
