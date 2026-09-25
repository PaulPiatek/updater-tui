/**
 * Selection state for the two-stage flow, kept free of any UI code so it can be
 * unit-tested headlessly (see `tests/state.test.ts`).
 *
 * Stage 1 picks sources; stage 2 picks packages. Everything is driven by plain
 * functions over an immutable-ish `FlowState`, which the Solid layer wraps in
 * signals.
 */
import type { Source, UpgradeItem } from "./types";

/** Which screen the app is showing. */
export type Stage = "sources" | "scanning" | "packages" | "applying" | "done";

/** A row in the source picker (stage 1). */
export interface SourceRow {
  id: string;
  title: string;
  /** False when the source can't run on this machine (greyed out, locked). */
  available: boolean;
}

/** A group of packages from one source, shown in the package picker. */
export interface PackageGroup {
  sourceId: string;
  sourceTitle: string;
  items: UpgradeItem[];
}

/** An item is locked when config pinned it or the source disabled it. */
export function isLocked(item: UpgradeItem): boolean {
  return item.pinned === true || item.disabled === true;
}

/** The right-hand text for an item: source `hint`, or `current → latest`. */
export function versionLabel(item: UpgradeItem): string {
  if (item.hint) return item.hint;
  if (item.current === item.latest) return item.current;
  return `${item.current} → ${item.latest}`;
}

/** Adds `· pinned` / `· not found` to the version label for locked rows. */
export function lockedHint(item: UpgradeItem): string {
  const base = versionLabel(item);
  if (item.pinned) return `${base} · pinned`;
  if (item.disabled) return `${base} · not found`;
  return base;
}

export interface FlowState {
  stage: Stage;
  sources: SourceRow[];
  /** Ids the user checked in stage 1. */
  selectedSources: Set<string>;
  /** Cursor index into `sources`. */
  sourceCursor: number;
  /** Items from the chosen sources, grouped for display. */
  groups: PackageGroup[];
  /** Ids still checked in stage 2 (locked items are never included). */
  selectedItems: Set<string>;
  /** Flat order of ids so the cursor can move across group boundaries. */
  itemOrder: string[];
  /** Cursor index into `itemOrder`. */
  itemCursor: number;
  /** Set once the user leaves stage 1. */
  scanning: boolean;
  /** Human-readable per-source scan failures, shown in the output pane. */
  scanErrors: string[];
}

/** Builds the source rows from the registry plus availability results. */
export function sourceRows(
  sources: Source[],
  availability: Map<string, boolean>,
): SourceRow[] {
  return sources.map((source) => ({
    id: source.id,
    title: source.title,
    available: availability.get(source.id) ?? false,
  }));
}

/** The initial state for stage 1: every available source pre-checked. */
export function initialFlow(sources: SourceRow[]): FlowState {
  return {
    stage: "sources",
    sources,
    selectedSources: new Set(
      sources.filter((source) => source.available).map((source) => source.id),
    ),
    sourceCursor: 0,
    groups: [],
    selectedItems: new Set(),
    itemOrder: [],
    itemCursor: 0,
    scanning: false,
    scanErrors: [],
  };
}

/**
 * Groups items by source, preserving source order, and drops items whose source
 * wasn't chosen. Locked items stay visible (shown greyed out) but never get
 * pre-selected.
 */
export function groupItems(
  items: UpgradeItem[],
  sources: SourceRow[],
  selectedSources: Set<string>,
): PackageGroup[] {
  const groups: PackageGroup[] = [];
  for (const source of sources) {
    if (!selectedSources.has(source.id)) continue;
    const groupItems = items.filter((item) => item.source === source.id);
    if (groupItems.length === 0) continue;
    groups.push({
      sourceId: source.id,
      sourceTitle: source.title,
      items: groupItems,
    });
  }
  return groups;
}

/** Flattens groups into the cursor order: group by group, item by item. */
export function flatten(groups: PackageGroup[]): string[] {
  return groups.flatMap((group) => group.items.map((item) => item.id));
}

/** Every upgradable id across all groups, for the default selection. */
export function defaultSelection(groups: PackageGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const item of group.items) {
      if (!isLocked(item)) ids.add(item.id);
    }
  }
  return ids;
}

/** Looks an item up by id regardless of which group it lives in. */
export function findItem(
  groups: PackageGroup[],
  id: string,
): UpgradeItem | undefined {
  for (const group of groups) {
    const found = group.items.find((item) => item.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Moves an index by `delta`, clamping to `[0, length - 1]`. */
export function clampIndex(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(length - 1, index + delta));
}

/**
 * Toggles an item if it is selectable. Locked items, group headers and
 * out-of-range cursors are ignored, so the caller can feed key presses
 * directly.
 */
export function toggleItem(
  state: FlowState,
  id: string,
): FlowState {
  const item = findItem(state.groups, id);
  if (!item || isLocked(item)) return state;
  const selected = new Set(state.selectedItems);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  return { ...state, selectedItems: selected };
}

/** Selects or clears every unlocked item. */
export function setAllItems(
  state: FlowState,
  selected: boolean,
): FlowState {
  return {
    ...state,
    selectedItems: selected ? defaultSelection(state.groups) : new Set(),
  };
}

/** Toggles a source, if it is available. */
export function toggleSource(state: FlowState, id: string): FlowState {
  const row = state.sources.find((source) => source.id === id);
  if (!row || !row.available) return state;
  const selected = new Set(state.selectedSources);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  return { ...state, selectedSources: selected };
}

/** Selects or clears every available source. */
export function setAllSources(state: FlowState, selected: boolean): FlowState {
  return {
    ...state,
    selectedSources: selected
      ? new Set(state.sources.filter((s) => s.available).map((s) => s.id))
      : new Set(),
  };
}

/**
 * Moves from stage 1 to scanning: records the chosen sources and locks the
 * cursor into the package stage.
 */
export function beginScan(state: FlowState): FlowState {
  return {
    ...state,
    stage: "scanning",
    scanning: true,
    itemCursor: 0,
  };
}

/** Installs scan results, entering the package stage with defaults checked. */
export function applyScanResults(
  state: FlowState,
  items: UpgradeItem[],
  errors: string[],
): FlowState {
  const groups = groupItems(items, state.sources, state.selectedSources);
  return {
    ...state,
    stage: "packages",
    scanning: false,
    groups,
    itemOrder: flatten(groups),
    selectedItems: defaultSelection(groups),
    itemCursor: 0,
    scanErrors: errors,
  };
}

/** The ordered ids of everything currently selected and upgradable, in display
 * order. The orchestrator upgrades these.
 */
export function selectedUpgradableIds(state: FlowState): string[] {
  return state.itemOrder.filter((id) => state.selectedItems.has(id));
}
