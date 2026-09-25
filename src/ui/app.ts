/**
 * The interactive full-screen TUI, built with OpenTUI's imperative API.
 *
 * Layout: left pane = two-stage selection (sources, then packages), right pane =
 * live output, bottom = status/summary. The engine (`../engine.ts`) does the
 * work and reports progress through callbacks; this class renders it.
 *
 * Imperative (rather than Solid/React) on purpose: the reactive bindings do not
 * work in `bun build --compile` output, and a standalone exe is a requirement.
 */
import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import type { Source, UpgradeItem, UpgradeResult } from "../types";
import {
  applyGroup,
  discover,
  groupBySource,
  scan,
  type Engine,
} from "../engine";
import {
  applyScanResults,
  beginScan,
  clampIndex,
  defaultSelection,
  flatten,
  groupItems,
  initialFlow,
  isLocked,
  lockedHint,
  setAllItems,
  setAllSources,
  sourceRows,
  toggleItem,
  toggleSource,
  type FlowState,
} from "../state";
import { Checklist, type ChecklistRow } from "./checklist";
import { OutputPane } from "./output";
import { colors, truncate } from "./theme";

export interface AppOptions {
  cwd?: string;
  sourceFilter?: string[];
  dryRun: boolean;
}

/**
 * Owns the whole TUI: the renderable tree, the flow state, and the key handler.
 * Construct it after the renderer exists; call `run` to start the flow.
 */
export class App {
  private readonly root: BoxRenderable;
  private readonly checklist: Checklist;
  private readonly output: OutputPane;
  private readonly statusText: TextRenderable;
  private readonly hintText: TextRenderable;

  private state: FlowState;
  private engine: Engine | null = null;
  private busy = false;
  private summary: string | null = null;
  private finished = false;
  /** Resolves when the app tears itself down (quit or finish). */
  private readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly options: AppOptions,
  ) {
    this.state = initialFlow([]);
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });

    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
      gap: 1,
    });

    const body = new BoxRenderable(renderer, {
      flexDirection: "row",
      flexGrow: 1,
      gap: 1,
    });
    // Widths come from flex weights rather than a percentage: a `%` width here
    // resolved against the wrong basis once nested inside `root`, so the pane
    // did not match the terminal. `flexGrow` ratios are relative and reliable.
    const left = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexBasis: 0,
      flexDirection: "column",
    });
    const right = new BoxRenderable(renderer, {
      flexGrow: 1,
      flexBasis: 0,
      flexDirection: "column",
    });

    this.checklist = new Checklist(renderer, "Sources");
    this.output = new OutputPane(renderer, "Output");
    left.add(this.checklist.root);
    right.add(this.output.root);
    body.add(left);
    body.add(right);
    this.root.add(body);

    const status = new BoxRenderable(renderer, {
      flexDirection: "row",
      width: "100%",
      borderStyle: "rounded",
      borderColor: colors.border,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.statusText = new TextRenderable(renderer, { content: "", fg: colors.muted });
    this.hintText = new TextRenderable(renderer, { content: "", fg: colors.dim });
    status.add(this.statusText);
    status.add(new BoxRenderable(renderer, { flexGrow: 1 }));
    status.add(this.hintText);
    this.root.add(status);

    renderer.root.add(this.root);
    renderer.keyInput.on("keypress", this.onKey);
  }

  /** Mounts the UI, discovers sources, and resolves with the exit code. */
  async run(): Promise<number> {
    this.refresh();
    await this.discoverSources();
    await this.done;
    return this.exitCode;
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------
  private async discoverSources(): Promise<void> {
    try {
      const found = await discover({
        cwd: this.options.cwd,
        sourceFilter: this.options.sourceFilter,
      });
      this.engine = found;
      const rows = sourceRows(
        found.sources.map((entry) => entry.source),
        new Map(found.sources.map((entry) => [entry.source.id, entry.available])),
      );
      this.state = initialFlow(rows);
      for (const row of rows) {
        if (!row.available) {
          this.output.push("warn", `${row.title}: not available on this machine`);
        }
      }
      this.output.push("info", "Select sources, then Enter to scan.");
      this.refresh();
    } catch (err) {
      this.output.push("bad", err instanceof Error ? err.message : String(err));
      this.setSummary("Cannot start.");
    }
  }

  // ---------------------------------------------------------------------------
  // Flow steps
  // ---------------------------------------------------------------------------
  private async runScan(): Promise<void> {
    if (!this.engine) return;
    const current = this.state;
    if (current.selectedSources.size === 0) {
      this.output.push("warn", "No sources selected.");
      return;
    }

    this.busy = true;
    this.state = beginScan(current);
    this.output.push("step", "Scanning selected sources…");
    this.refresh();

    try {
      const result = await scan(this.engine, [...current.selectedSources], {
        onScanDone: (source, items) =>
          this.output.push(
            items.length > 0 ? "good" : "info",
            items.length > 0
              ? `${source.title}: ${items.length} update(s)`
              : `${source.title}: up to date`,
          ),
        onScanError: (source, detail) =>
          this.output.push("bad", `${source.title}: ${detail}`),
      });
      this.state = applyScanResults(this.state, result.items, result.errors);

      if (result.ignored + result.pinned > 0) {
        this.output.push(
          "info",
          `${result.ignored} ignored · ${result.pinned} pinned by config`,
        );
      }
      if (this.state.groups.length === 0) {
        this.setSummary(
          result.errors.length > 0 ? "Finished with errors." : "Nothing to do 🎉",
        );
      } else {
        this.output.push("info", "Choose packages, then Enter to upgrade.");
      }
    } catch (err) {
      this.output.push("bad", err instanceof Error ? err.message : String(err));
      this.setSummary("Scan failed.");
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  private async runUpgrade(): Promise<void> {
    if (!this.engine) return;
    const current = this.state;

    const chosenIds = new Set(flatten(current.groups).filter((id) => current.selectedItems.has(id)));
    const chosen = current.groups.flatMap((group) =>
      group.items.filter((item) => chosenIds.has(item.id)),
    );
    if (chosen.length === 0) {
      this.setSummary("Nothing to do 🎉");
      return;
    }

    this.busy = true;
    this.state = { ...current, stage: "applying" };
    this.refresh();

    let ok = 0;
    let failed = 0;
    let reboot = false;

    try {
      for (const group of groupBySource(this.engine, chosen)) {
        // Sources that print to the terminal themselves (custom scripts) need
        // the real terminal: suspend the TUI, run them, then resume.
        const streaming = group.source.runMode === "stream" && !this.options.dryRun;
        this.output.push("step", group.source.title);
        if (streaming) this.renderer.suspend();

        try {
          const results = await applyGroup(
            group.source,
            group.items,
            this.options.dryRun,
            { onResult: (result) => this.logResult(result) },
          );
          for (const result of results) {
            if (result.ok) ok++;
            else failed++;
            if (result.rebootRequired) reboot = true;
          }
        } finally {
          if (streaming) this.renderer.resume();
        }
      }
    } catch (err) {
      this.output.push("bad", err instanceof Error ? err.message : String(err));
      failed++;
    }

    if (reboot) {
      this.output.push("warn", "A restart is required to finish some updates.");
    }

    this.state = { ...this.state, stage: "done" };
    const verb = this.options.dryRun ? "would upgrade" : "upgraded";
    this.setSummary(`Done: ${ok} ${verb}, ${failed} failed.`);
    this.busy = false;
    this.refresh();
  }

  private logResult(result: UpgradeResult): void {
    if (result.ok) {
      this.output.push("good", `${result.item.name}  ${lockedHint(result.item)}`);
    } else {
      this.output.push(
        "bad",
        `${result.item.name}: ${result.error ?? "failed"}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  private onKey = (key: KeyEvent): void => {
    if (this.finished) return;
    if (key.name === "q") {
      this.quit(this.summary ? exitCodeFor(this.summary) : 130);
      return;
    }
    if (this.summary) {
      if (key.name === "return" || key.name === "escape") {
        this.quit(exitCodeFor(this.summary));
      }
      return;
    }
    if (this.busy) return;

    const current = this.state;

    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      if (current.stage === "packages") {
        this.state = { ...current, stage: "sources" };
        this.refresh();
      } else {
        this.quit(130);
      }
      return;
    }

    if (current.stage === "sources") {
      if (key.name === "up" || key.name === "k") {
        this.state = {
          ...current,
          sourceCursor: clampIndex(current.sourceCursor, -1, current.sources.length),
        };
        this.refresh();
      } else if (key.name === "down" || key.name === "j") {
        this.state = {
          ...current,
          sourceCursor: clampIndex(current.sourceCursor, 1, current.sources.length),
        };
        this.refresh();
      } else if (key.name === "space") {
        const row = current.sources[current.sourceCursor];
        if (row) {
          this.state = toggleSource(current, row.id);
          this.refresh();
        }
      } else if (key.name === "a") {
        this.state = setAllSources(current, current.selectedSources.size === 0);
        this.refresh();
      } else if (key.name === "return") {
        void this.runScan();
      }
      return;
    }

    if (current.stage === "packages") {
      if (key.name === "up" || key.name === "k") {
        this.state = {
          ...current,
          itemCursor: clampIndex(current.itemCursor, -1, current.itemOrder.length),
        };
        this.refresh();
      } else if (key.name === "down" || key.name === "j") {
        this.state = {
          ...current,
          itemCursor: clampIndex(current.itemCursor, 1, current.itemOrder.length),
        };
        this.refresh();
      } else if (key.name === "space") {
        const id = current.itemOrder[current.itemCursor];
        if (id) {
          this.state = toggleItem(current, id);
          this.refresh();
        }
      } else if (key.name === "a") {
        const allOn =
          current.selectedItems.size === defaultSelection(current.groups).size;
        this.state = setAllItems(current, !allOn);
        this.refresh();
      } else if (key.name === "return") {
        void this.runUpgrade();
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  private setSummary(text: string): void {
    this.summary = text;
    this.refresh();
  }

  private quit(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.renderer.keyInput.off("keypress", this.onKey);
    this.exitCode = code;
    this.renderer.destroy();
    this.resolveDone();
  }

  /** Set once `quit` runs, so the caller can read the exit code. */
  exitCode = 0;

  /** Detaches the UI and resolves any pending `run()`. Safe to call twice. */
  destroy(): void {
    if (this.finished) return;
    this.finished = true;
    this.renderer.keyInput.off("keypress", this.onKey);
    this.resolveDone();
  }

  private refresh(): void {
    const current = this.state;
    this.checklist.setTitle(current.stage === "sources" ? "Sources" : "Packages");

    if (current.stage === "sources") {
      this.checklist.setEmptyText(this.engine ? "No sources" : "Loading…");
      this.checklist.setRows(this.sourceRowsFor(current));
      this.checklist.setCursor(current.sourceCursor);
    } else {
      this.checklist.setEmptyText("No packages");
      this.checklist.setRows(this.packageRowsFor(current));
      this.checklist.setCursor(current.itemCursor);
    }

    this.statusText.content = truncate(
      this.summary ?? (this.options.dryRun ? "DRY RUN" : ""),
      60,
    );
    this.statusText.fg = this.summary ? colors.accent : colors.muted;
    this.hintText.content = this.hintFor(current);
  }

  private sourceRowsFor(state: FlowState): ChecklistRow[] {
    return state.sources.map((row) => ({
      id: row.id,
      label: row.title,
      hint: row.available ? undefined : "not available",
      checked: state.selectedSources.has(row.id),
      locked: !row.available,
    }));
  }

  private packageRowsFor(state: FlowState): ChecklistRow[] {
    const rows: ChecklistRow[] = [];
    for (const group of state.groups) {
      rows.push({
        id: `__group-${group.sourceId}`,
        label: group.sourceTitle,
        checked: false,
        heading: true,
      });
      for (const item of group.items) {
        rows.push({
          id: item.id,
          label: item.name,
          hint: lockedHint(item),
          checked: state.selectedItems.has(item.id),
          locked: isLocked(item),
        });
      }
    }
    return rows;
  }

  private hintFor(state: FlowState): string {
    if (this.summary) return "Enter/q to exit";
    if (this.busy) return "working…";
    if (state.stage === "sources") {
      return "↑/↓ move · space toggle · a all/none · Enter scan · q quit";
    }
    if (state.stage === "packages") {
      const count = state.selectedItems.size;
      return `↑/↓ move · space toggle · a all/none · Enter upgrade (${count}) · Esc back · q quit`;
    }
    return "q quit";
  }
}

export function exitCodeFor(summary: string): number {
  const match = /Done: \d+ upgraded, (\d+) failed/.exec(summary);
  if (match) return Number(match[1]) > 0 ? 1 : 0;
  return /errors/i.test(summary) ? 1 : 0;
}
