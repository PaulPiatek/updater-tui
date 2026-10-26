import type { Source, UpgradeItem, UpgradeOptions, UpgradeResult } from "../types";
import { run, which } from "../proc";
import { clip, log, tailOf } from "../log";

/**
 * Microsoft Store apps, via the StoreCLI that ships inside the Microsoft Store
 * appx (`store.exe`, on PATH as the `store` app-execution alias).
 *
 * This is the supported replacement for the old fire-and-forget
 * `rundll32`/scheduled-task trigger: `store updates` lists what is pending and
 * `store update <app> --apply` installs it.
 *
 * It is a **Preview** tool, not open source, and is unrelated to
 * `microsoft/msstore-cli` (`msstore.exe`, the Partner Center *publishing* CLI).
 * Three things to remember (all confirmed against v22608.1401.5.0):
 *
 * - `store updates` prints a coloured box table on **stdout** (CRLF), and there
 *   is no `--json`. The columns are **Name / Publisher / Version / Date** — the
 *   same renderer as `store installed` — and there is **no target-version
 *   column**, so `latest` falls back to `"update"`.
 * - `store updates` is **interactive**: without `--apply` it still asks
 *   "Would you like to install the N Store update(s) now? [y/n]". `proc.run`
 *   gives it no stdin, so it prints `Failed to read input in non-interactive
 *   mode.` and installs nothing — listing is safe. Never list with `--apply`.
 * - Its **exit code is not trustworthy** — an unknown parameter prints
 *   `Unknown parameter(s): …` and still exits `0`. So results are read from the
 *   output (`✅ Installed` / `❌ Cancelled` / `❌ Error`) rather than `$?`.
 * - Updating the **Store itself** breaks that reporting: `store.exe` lives
 *   inside the package the update replaces, so the run stops at `Installing:
 *   95%` and exits `1` with neither marker — the update *worked*, but there is
 *   no success line (verified: 22608.1401.7.0 → 22609.1401.5.0). An ambiguous
 *   failure is therefore confirmed with `store update <id>` (no `--apply`,
 *   hence a check): `already up to date` means it landed.
 */
const STORE = which("store", "store.exe");

/** Removes ANSI CSI/SGR escape sequences (the StoreCLI colours every cell). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Splits one `│ a │ b │ c │` table line into its trimmed cell values. */
function splitCells(line: string): string[] {
  const parts = line.split("│");
  if (parts.length > 0 && parts[0]!.trim() === "") parts.shift();
  if (parts.length > 0 && parts[parts.length - 1]!.trim() === "") parts.pop();
  return parts.map((part) => part.trim());
}

/** A state that means "nothing to install" rather than a pending update. */
const UP_TO_DATE = /up\s*to\s*date|no update|not available|^current$/i;

const NAME_HEADERS = ["name", "app", "application", "product"];
const ID_HEADERS = ["id", "product id", "package id", "update id", "package family name"];
const VERSION_HEADERS = ["version", "installed version", "current version", "current"];
const AVAILABLE_HEADERS = [
  "available",
  "update available",
  "available version",
  "new version",
  "latest",
  "latest version",
  "update",
];
const STATE_HEADERS = ["state", "status"];

/** What the header-driven parser saw, so "no table" and "0 rows" differ. */
export interface StoreParseStats {
  tables: number;
  headerRow: number | null;
  tableLines: number;
  rowLines: number;
  continuations: number;
  rows: number;
  skippedUpToDate: number;
  columns: string[];
}

/**
 * Parses the table(s) printed by `store updates` into upgrade items.
 *
 * A `│`-prefixed line whose cells include `Name`/`App` starts a table; the
 * `│` lines after it are data rows. More than one table is handled in case the
 * CLI ever renders one per update. The renderer wraps long cells, so one
 * logical row can span several physical lines — a physical line is a
 * *continuation* when every column other than the name/publisher is blank (the
 * wrapped text itself may be in the name column, so "blank first cell" is not
 * enough; the captured `installed` output wraps the name across three lines).
 *
 * Columns are matched case-insensitively, so a renamed or reordered column
 * degrades to a sensible default instead of breaking. Exported for testing.
 *
 * `stats` is filled in when the caller wants the parse recorded in the log.
 */
export function parseStoreUpdates(
  output: string,
  stats?: StoreParseStats,
): UpgradeItem[] {
  const lines = stripAnsi(output).replace(/\r\n?/g, "\n").split("\n");

  const items: UpgradeItem[] = [];
  const seen = new Set<string>();

  let header: string[] | null = null;
  let rows: string[][] = [];
  let markers: number[] = [];
  let nameIndex = -1;
  let idIndex = -1;
  let versionIndex = -1;
  let availableIndex = -1;
  let stateIndex = -1;
  let tables = 0;
  let headerRow: number | null = null;
  let lineIndex = 0;
  let continuations = 0;
  let skippedUpToDate = 0;

  const cell = (cells: string[], index: number): string =>
    index >= 0 ? (cells[index] ?? "").trim() : "";

  const emit = (): void => {
    if (!header || nameIndex < 0) return;
    for (const cells of rows) {
      const name = cell(cells, nameIndex);
      if (!name) continue;
      // Defensive: if the list ever includes up-to-date apps, don't offer them.
      if (stateIndex >= 0 && UP_TO_DATE.test(cell(cells, stateIndex))) {
        skippedUpToDate++;
        continue;
      }

      // Prefer the product id for the item id and the upgrade key when the
      // table exposes one, so two apps sharing a display name stay distinct.
      const storeId = cell(cells, idIndex);
      const id = `store:${storeId || name}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const item: UpgradeItem = {
        id,
        source: "store",
        name,
        current: cell(cells, versionIndex) || "installed",
        latest: cell(cells, availableIndex) || "update",
      };
      if (storeId) item.meta = { storeId };

      items.push(item);
    }
  };

  const record = (): void => {
    if (!stats) return;
    stats.tables = tables;
    stats.headerRow = header ? headerRow : null;
    stats.rowLines = rows.length;
    stats.rows = items.length;
    stats.continuations = continuations;
    stats.skippedUpToDate = skippedUpToDate;
    stats.columns = header ?? [];
  };

  for (const [index, rawLine] of lines.entries()) {
    lineIndex = index;
    const line = rawLine.trim();
    if (!line.startsWith("│")) continue;
    if (stats) stats.tableLines++;

    const cells = splitCells(line);
    if (cells.some((value) => NAME_HEADERS.includes(value.toLowerCase()))) {
      emit();
      tables++;
      headerRow = lineIndex + 1;
      header = cells;
      rows = [];
      const column = (names: string[]): number =>
        header!.findIndex((value) => names.includes(value.toLowerCase()));
      nameIndex = column(NAME_HEADERS);
      idIndex = column(ID_HEADERS);
      versionIndex = column(VERSION_HEADERS);
      availableIndex = column(AVAILABLE_HEADERS);
      stateIndex = column(STATE_HEADERS);
      // Columns that never wrap. Everything else must be blank on a
      // continuation line, which is how wrapped rows are stitched back up.
      const publisherIndex = column(["publisher"]);
      markers = header
        .map((_, index) => index)
        .filter((index) => index !== nameIndex && index !== publisherIndex);
      continue;
    }

    if (!header || nameIndex < 0) continue;

    const previous = rows[rows.length - 1];
    const isContinuation = markers.length > 0
      ? markers.every((index) => (cells[index] ?? "") === "")
      : (cells[nameIndex] ?? "") === "";

    if (previous && isContinuation) {
      continuations++;
      for (let i = 0; i < header.length; i++) {
        const value = cells[i] ?? "";
        if (!value) continue;
        previous[i] = previous[i] ? `${previous[i]} ${value}` : value;
      }
      continue;
    }
    rows.push([...cells]);
  }

  emit();
  record();
  return items;
}

/** The text the StoreCLI printed, minus colour and carriage returns. */
function clean(output: string): string {
  return stripAnsi(output).replace(/\r\n?/g, "\n").trim();
}

export const looksFailed = (text: string): boolean =>
  /unknown parameter|no product found|not found|❌|✗|\berror\b|\bfailed\b|cancel|denied|unable|cannot/i.test(
    text,
  );

export const looksSucceeded = (text: string): boolean =>
  /✅|\binstalled\b|\bupdated\b|already up to date/i.test(text);

/** `store update <id>` (no `--apply`) says whether an update is still pending. */
const UPDATE_PENDING = /update available for|would you like to apply/i;
const UPDATE_APPLIED = /already up to date|no update/i;

/**
 * Asks the StoreCLI whether `key` still has a pending update.
 *
 * This is a *check*: without `--apply` the CLI only prompts (and with no stdin
 * it installs nothing), so it is safe after a failed-looking run. `undefined`
 * means the answer could not be read, in which case the caller keeps its
 * original verdict rather than guessing.
 */
async function isStillPending(key: string): Promise<boolean | undefined> {
  try {
    const res = await run([STORE, "update", key]);
    const output = clean(`${res.stdout}\n${res.stderr}`);
    const applied = UPDATE_APPLIED.test(output);
    const pending = UPDATE_PENDING.test(output);
    log(
      "store.verify",
      {
        src: "store",
        key,
        code: res.code,
        match: applied ? "applied" : pending ? "pending" : "unreadable",
        tail: tailOf(output, 300),
      },
      applied || pending ? "info" : "warn",
    );
    if (applied) return false;
    if (pending) return true;
    return undefined;
  } catch (err) {
    log("store.verify.error", { src: "store", key, error: err }, "warn");
    return undefined;
  }
}

/** Upgrades Microsoft Store apps through the StoreCLI (`store.exe`). */
export const storeSource: Source = {
  id: "store",
  title: "Microsoft Store apps",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    if (!Bun.which("store")) return false;
    try {
      // `--help` is cheap and exercises the alias end to end. Its exit code is
      // only a smoke test (`store` exits 0 even for a bad parameter).
      const res = await run([STORE, "--help"]);
      return res.code === 0;
    } catch {
      return false;
    }
  },

  async list(): Promise<UpgradeItem[]> {
    // Deliberately no `--apply`: that is what would install, and `store updates`
    // prompts for confirmation anyway. With no stdin it leaves everything alone.
    const res = await run([STORE, "updates"]);
    const output = clean(`${res.stdout}\n${res.stderr}`);
    const noUpdates = /no updates found/i.test(output);

    const stats: StoreParseStats = {
      tables: 0,
      headerRow: null,
      tableLines: 0,
      rowLines: 0,
      continuations: 0,
      rows: 0,
      skippedUpToDate: 0,
      columns: [],
    };
    const items = noUpdates ? [] : parseStoreUpdates(output, stats);

    // The parser's view of the output, so "no table found" (wrong output) and
    // "table found, 0 rows" (wrong columns) are distinguishable afterwards.
    log(
      "store.list",
      {
        src: "store",
        code: res.code,
        chars: output.length,
        noUpdates,
        items: items.length,
        ...stats,
      },
      items.length > 0 || noUpdates ? "info" : "warn",
    );

    if (noUpdates) return [];

    if (items.length > 0) return items;

    // No table and no "no updates" marker: surface the raw output rather than
    // silently reporting "nothing to do".
    if (res.code !== 0 || looksFailed(output)) {
      const snippet = output.split("\n").filter(Boolean).slice(-3).join(" ");
      const error = snippet || `store updates exited with code ${res.code}`;
      log(
        "store.list.error",
        { src: "store", code: res.code, error, tail: tailOf(output, 2_048) },
        "error",
      );
      throw new Error(error);
    }
    return [];
  },

  async upgrade(item, opts: UpgradeOptions): Promise<UpgradeResult> {
    // Prefer the product id when the table exposed one; otherwise use the name,
    // which `store update` accepts (its help examples use names too).
    const key = (item.meta?.storeId as string | undefined) ?? item.name;
    const command = `store update "${key}" --apply`;

    if (opts.dryRun) {
      return { item, ok: true, command };
    }

    const res = await run([STORE, "update", key, "--apply"]);
    const output = clean(`${res.stdout}\n${res.stderr}`);
    const failed = looksFailed(output);
    const succeeded = looksSucceeded(output);

    // A non-zero exit with no marker is ambiguous — that is exactly what a
    // Store self-update looks like (see the note at the top). Ask the CLI
    // whether the item is still pending instead of reporting a false failure.
    const ambiguous = !failed && !succeeded && res.code !== 0;
    const verified = ambiguous ? await isStillPending(key) : undefined;
    const ok = !failed && (succeeded || res.code === 0 || verified === false);

    // The exact branch that decided the verdict: `verified` is a tri-state, and
    // "unreadable" (null) must stay distinguishable from "false" (done).
    log(
      "store.verdict",
      {
        src: "store",
        item: item.id,
        key,
        code: res.code,
        failed,
        succeeded,
        ambiguous,
        verified: verified ?? null,
        ok,
        chars: output.length,
        tail: ok ? undefined : tailOf(output, 1_024),
      },
      ok ? "info" : "warn",
    );

    const detail = verified === false
      ? `${output}${output ? "\n" : ""}✓ verified: store update reports it is already up to date`
      : output;

    return {
      item,
      ok,
      command,
      output: clip(detail),
      error: ok
        ? undefined
        : detail.split("\n").filter(Boolean).slice(-2).join(" ") || `exit code ${res.code}`,
    };
  },
};
