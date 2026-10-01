import type { Source, UpgradeItem, UpgradeOptions, UpgradeResult } from "../types";
import { run, which } from "../proc";

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
 */
export function parseStoreUpdates(output: string): UpgradeItem[] {
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

  const cell = (cells: string[], index: number): string =>
    index >= 0 ? (cells[index] ?? "").trim() : "";

  const emit = (): void => {
    if (!header || nameIndex < 0) return;
    for (const cells of rows) {
      const name = cell(cells, nameIndex);
      if (!name) continue;
      // Defensive: if the list ever includes up-to-date apps, don't offer them.
      if (stateIndex >= 0 && UP_TO_DATE.test(cell(cells, stateIndex))) continue;

      const id = `store:${name}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const item: UpgradeItem = {
        id,
        source: "store",
        name,
        current: cell(cells, versionIndex) || "installed",
        latest: cell(cells, availableIndex) || "update",
      };
      // Prefer the product id for the upgrade key when the table exposes one.
      const storeId = cell(cells, idIndex);
      if (storeId) item.meta = { storeId };

      items.push(item);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("│")) continue;

    const cells = splitCells(line);
    if (cells.some((value) => NAME_HEADERS.includes(value.toLowerCase()))) {
      emit();
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
  return items;
}

/** The text the StoreCLI printed, minus colour and carriage returns. */
function clean(output: string): string {
  return stripAnsi(output).replace(/\r\n?/g, "\n").trim();
}

const looksFailed = (text: string): boolean =>
  /unknown parameter|no product found|not found|❌|✗|\berror\b|\bfailed\b|cancel|denied|unable|cannot/i.test(
    text,
  );

const looksSucceeded = (text: string): boolean =>
  /✅|\binstalled\b|\bupdated\b|already up to date/i.test(text);

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

    if (/no updates found/i.test(output)) return [];

    const items = parseStoreUpdates(output);
    if (items.length > 0) return items;

    // No table and no "no updates" marker: surface the raw output rather than
    // silently reporting "nothing to do".
    if (res.code !== 0 || looksFailed(output)) {
      const snippet = output.split("\n").filter(Boolean).slice(-3).join(" ");
      throw new Error(snippet || `store updates exited with code ${res.code}`);
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
    const ok = !failed && (looksSucceeded(output) || res.code === 0);

    return {
      item,
      ok,
      command,
      output,
      error: ok
        ? undefined
        : output.split("\n").filter(Boolean).slice(-2).join(" ") || `exit code ${res.code}`,
    };
  },
};
