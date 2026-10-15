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
  StyledText,
  TextRenderable,
  fg,
  type CliRenderer,
  type KeyEvent,
  type RGBA,
} from "@opentui/core";
import type { UpgradeResult } from "../types";
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
import { TerminalOverlay } from "./overlay-terminal";
import { bandRamp, colors, shimmer, truncate } from "./theme";

/** Rotating braille frames for the bottom-bar spinner (~640 ms per cycle). */
const ACTIVITY_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
/** Spinner tick; the colour shimmer steps every other frame. */
const ACTIVITY_MS = 80;
/** Ticks a phrase stays up when several are cycled (≈1.2 s at ACTIVITY_MS). */
const PHRASE_TICKS = 15;
/** How long the band takes per character step (one per frame — the fastest the
 * 80 ms tick can render it). */
const SNAKE_STEP_MS = ACTIVITY_MS;
/** The finish burst spins the other way, so it reads as a distinct phase. */
const BURST_FRAMES = [...ACTIVITY_FRAMES].reverse();
/** How long the sparkle burst runs before the sweep starts. */
export const FINISH_BURST_MS = 1_400;
/** How long the whole finish animation runs before the bar rests. */
export const FINISH_REST_MS = 10_000;

/**
 * Which part of a clean finish's animation an *elapsed time* falls in: a
 * sparkle burst, then the colour snake, then it rests as plain text.
 *
 * Timing is wall-clock rather than tick-counted: the 80 ms interval drifts
 * under render load, so counting ticks could stretch "10 seconds" noticeably.
 * Exported for testing.
 */
export function finishPhase(elapsedMs: number): "burst" | "snake" | "rest" {
  if (elapsedMs < FINISH_BURST_MS) return "burst";
  if (elapsedMs < FINISH_REST_MS) return "snake";
  return "rest";
}

/** Playful phrases for the bottom activity bar while sources are listed. */
const SCAN_PHRASES: Record<string, string> = {
  npm: "sniffing npm",
  winget: "peeking at winget",
  store: "browsing the Store",
  "windows-update": "asking Windows",
  custom: "reading your scripts",
};

/** Ditto for the upgrade phase. */
const UPGRADE_PHRASES: Record<string, string> = {
  npm: "cooking npm updates",
  winget: "doing winget updates",
  store: "cooking store updates",
  "windows-update": "coaxing Windows Update",
  custom: "running your scripts",
};

/** Shown while sources are being discovered, before the picker appears. */
const DISCOVERING_TEXT = "waking up your sources";

/**
 * The phrase for a source in one phase, from the tables above. An unknown or
 * newly added source degrades to a plain label rather than an empty bar.
 */
export function activityPhrase(
  phase: "scan" | "upgrade",
  id: string,
  title: string,
): string {
  const table = phase === "scan" ? SCAN_PHRASES : UPGRADE_PHRASES;
  return table[id] ?? `working on ${title.toLowerCase()}`;
}

/**
 * Paints `text` with a moving highlight: the `ramp`'s colours, one character
 * each (tail → bright head), sliding across a `base`-coloured line and wrapping
 * round at the end.
 *
 * Built from native `StyledText` chunks, so the renderer styles each character
 * itself — the whole sweep is one content swap per tick, with no extra nodes.
 * Exported for testing.
 */
export function snakeText(
  text: string,
  phase: number,
  ramp: readonly RGBA[],
  base: RGBA,
): StyledText {
  const chars = [...text];
  if (chars.length === 0) return new StyledText([]);
  return new StyledText(
    chars.map((char, index) => {
      const offset = (((index - phase) % chars.length) + chars.length) % chars.length;
      return fg(offset < ramp.length ? ramp[offset]! : base)(char);
    }),
  );
}

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
  private readonly spinner: TextRenderable;
  private readonly statusText: TextRenderable;
  private readonly hintText: TextRenderable;

  private state: FlowState;
  private engine: Engine | null = null;
  private busy = false;
  private summary: string | null = null;
  private finished = false;
  /** The overlay currently hosting a script, if any. */
  private activeOverlay: TerminalOverlay | null = null;
  /** Phrases the bottom bar cycles while work is in progress (null = idle). */
  private workPhrases: string[] | null = null;
  /** Advances every ACTIVITY_MS; drives both the spinner and the phrase. */
  private workTick = 0;
  private workTimer: ReturnType<typeof setInterval> | null = null;
  /** When the summary went up, for timing the finish animation. */
  private summaryAt = 0;
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
      // An explicit 0 basis makes the body take only the space left *after* the
      // status bar. With the default (content-driven) basis the two siblings
      // shared the shortfall, shrinking the status box below its content height
      // so its text was drawn over the border.
      flexBasis: 0,
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
      // Never squeeze the bar: it must always keep its one content row (plus
      // its two border rows).
      flexShrink: 0,
      borderStyle: "rounded",
      borderColor: colors.border,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.spinner = new TextRenderable(renderer, { content: "", fg: colors.muted });
    this.statusText = new TextRenderable(renderer, { content: "", fg: colors.muted });
    this.hintText = new TextRenderable(renderer, { content: "", fg: colors.dim });
    status.add(this.spinner);
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
    this.startWork([DISCOVERING_TEXT]);
    try {
      const found = await discover({
        cwd: this.options.cwd,
        sourceFilter: this.options.sourceFilter,
      });
      if (this.finished) return;
      this.engine = found;
      const rows = sourceRows(
        found.sources.map((entry) => entry.source),
        new Map(found.sources.map((entry) => [entry.source.id, entry.available])),
      );
      this.state = initialFlow(rows);
      for (const warning of found.warnings ?? []) {
        this.output.push("warn", warning);
      }
      for (const row of rows) {
        if (!row.available) {
          this.output.push("warn", `${row.title}: not available on this machine`);
        }
      }
      this.output.push("info", "Select sources, then Enter to scan.");
      this.refresh();
    } catch (err) {
      if (this.finished) return;
      this.output.push("bad", err instanceof Error ? err.message : String(err));
      this.setSummary("Cannot start.");
    } finally {
      // The picker (or the error summary) owns the bar once discovery is over.
      this.stopWork();
      if (!this.finished) this.refresh();
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
    // A live status row per selected source, filled in as each scan settles.
    const chosen = this.engine.sources.filter((entry) =>
      current.selectedSources.has(entry.source.id),
    );
    this.output.showStatus(
      chosen.map((entry) => ({ id: entry.source.id, title: entry.source.title })),
    );
    // Sources are scanned concurrently, so the bar cycles their phrases rather
    // than pretending one of them is "the" current one.
    this.startWork(
      chosen.map((entry) =>
        activityPhrase("scan", entry.source.id, entry.source.title),
      ),
    );
    this.output.push("step", "Scanning selected sources…");
    this.refresh();

    try {
      const result = await scan(this.engine, [...current.selectedSources], {
        onScanStart: (source) => {
          if (!this.finished) this.output.setStatus(source.id, "checking", "checking…");
        },
        onScanDone: (source, items) => {
          if (this.finished) return;
          this.output.setStatus(
            source.id,
            items.length > 0 ? "good" : "empty",
            items.length > 0 ? `${items.length} update(s)` : "up to date",
          );
        },
        onScanError: (source, detail) => {
          if (!this.finished) this.output.setStatus(source.id, "bad", detail);
        },
      });
      if (this.finished) return;
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
      if (this.finished) return;
      this.output.push("bad", err instanceof Error ? err.message : String(err));
      this.setSummary("Scan failed.");
    } finally {
      this.busy = false;
      this.stopWork();
      if (!this.finished) this.refresh();
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
    this.output.clearStatus();
    this.refresh();

    let ok = 0;
    let failed = 0;
    let reboot = false;

    try {
      for (const group of groupBySource(this.engine, chosen)) {
        // The user may have quit while a previous group ran; stop rather than
        // writing to a destroyed render tree.
        if (this.finished) break;
        // Groups run one after another, so the bar can name the one at work.
        this.startWork([
          activityPhrase("upgrade", group.source.id, group.source.title),
        ]);
        // Sources that print to the terminal themselves (custom scripts) are
        // hosted in an overlay on a pty, so their output streams live and their
        // prompts work without giving up the whole screen.
        const streaming = group.source.runMode === "stream" && !this.options.dryRun;
        this.output.push("step", group.source.title);

        const hostProcess = streaming
          ? (argv: string[], opts: { cwd?: string; title?: string }) =>
              this.hostProcess(argv, opts)
          : undefined;

        const results = await applyGroup(
          group.source,
          group.items,
          this.options.dryRun,
          { onResult: (result) => this.logResult(result) },
          { hostProcess },
        );
        for (const result of results) {
          if (result.ok) ok++;
          else failed++;
          if (result.rebootRequired) reboot = true;
        }
      }
    } catch (err) {
      if (this.finished) return;
      this.output.push("bad", err instanceof Error ? err.message : String(err));
      failed++;
    }

    this.busy = false;
    this.stopWork();
    // The user may have quit (closing the overlay) while the last script ran,
    // in which case the render tree is gone and must not be touched again.
    if (this.finished) return;

    if (reboot) {
      this.output.push("warn", "A restart is required to finish some updates.");
    }

    this.state = { ...this.state, stage: "done" };
    const verb = this.options.dryRun ? "would upgrade" : "upgraded";
    this.setSummary(`Done: ${ok} ${verb}, ${failed} failed.`);
    this.refresh();
  }

  /** Hosts one script in a terminal overlay and resolves with its exit code. */
  private hostProcess(
    argv: string[],
    options: { cwd?: string; title?: string },
  ): Promise<number> {
    return new Promise<number>((resolve) => {
      // The overlay calls back when it closes — after the child has exited or
      // the user pressed a reserved key — so the exit code is final by then.
      const overlay = new TerminalOverlay(this.renderer, () => {
        this.activeOverlay = null;
        resolve(overlay.exitCode);
      });
      this.activeOverlay = overlay;
      void overlay.run(argv, options);
    });
  }

  private logResult(result: UpgradeResult): void {
    if (this.finished) return;
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
    // While a hosted script owns the screen, keys belong to it: the overlay
    // handles its own Esc / Ctrl+Q, and plain `q` must reach the child. (A scan
    // has no overlay, so `q` still quits there.)
    if (this.activeOverlay) return;
    if (this.summary) {
      if (key.name === "return" || key.name === "escape" || key.name === "q") {
        this.quit(exitCodeFor(this.summary));
      }
      return;
    }
    if (key.name === "q") {
      this.quit(130);
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
        // Toggle: all on → all off, otherwise all on. Compares against every
        // *available* source, so a locked one never blocks the toggle.
        const allAvailable = current.sources.filter((s) => s.available).length;
        this.state = setAllSources(
          current,
          current.selectedSources.size !== allAvailable,
        );
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
    if (this.finished) return;
    // Start a clean finish's animation from frame 0, timed from now.
    this.workTick = 0;
    this.summaryAt = Date.now();
    this.refresh();
  }

  private quit(code: number): void {
    if (this.finished) return;
    this.finished = true;
    this.renderer.keyInput.off("keypress", this.onKey);
    this.stopWork();
    // Kill any hosted script and remove its overlay before the renderer goes.
    this.activeOverlay?.close();
    this.output.dispose();
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
    this.stopWork();
    this.activeOverlay?.close();
    this.output.dispose();
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

    this.renderStatus();
    this.hintText.content = this.hintFor(current);
    // The status bar animates on its own timer; keep it matched to what is
    // actually on screen (a phrase, a clean finish, or nothing).
    this.syncTick();
  }

  /**
   * Paints the bottom-left of the status bar: an animated phrase while work is
   * in progress, an animated summary when a run finished cleanly, and the plain
   * summary (or the dry-run marker) otherwise.
   */
  private renderStatus(): void {
    const phrase = this.activityLabel();
    if (phrase !== null) {
      // The glyph spins every tick; its colour steps every other tick so the
      // shimmer is a slow pulse rather than a flicker.
      const frame = this.workTick % ACTIVITY_FRAMES.length;
      this.spinner.content = `${ACTIVITY_FRAMES[frame]!} `;
      this.spinner.fg = shimmer[Math.floor(this.workTick / 2) % shimmer.length]!;
      this.statusText.content = truncate(phrase, 52);
      this.statusText.fg = colors.text;
      return;
    }

    // No phrase: either a summary, or the idle bar (dry runs show a marker).
    this.spinner.content = "";
    const summary = this.summary;
    if (summary === null) {
      this.statusText.content = truncate(this.options.dryRun ? "DRY RUN" : "", 60);
      this.statusText.fg = colors.muted;
      return;
    }

    const label = truncate(summary, 58);
    this.statusText.content = label;
    this.statusText.fg = colors.accent;
    // A clean finish celebrates; a failure sits still, so an error never looks
    // like a celebration.
    if (!this.celebrates()) return;

    const phase = finishPhase(this.finishElapsed());
    if (phase === "burst") {
      // A fast, bright spark before the sweep starts: the mark flashes through
      // the palette every frame (twice as fast as the working spinner).
      const frame = this.workTick % BURST_FRAMES.length;
      this.spinner.content = `${BURST_FRAMES[frame]!} `;
      this.spinner.fg = shimmer[this.workTick % shimmer.length]!;
      return;
    }
    if (phase === "snake") {
      this.statusText.content = snakeText(
        label,
        Math.floor((this.finishElapsed() - FINISH_BURST_MS) / SNAKE_STEP_MS),
        bandRamp,
        colors.accent,
      );
    }
    // phase === "rest": the plain summary painted above stays on screen.
  }

  /** Milliseconds since the summary went up (0 when there is none). */
  private finishElapsed(): number {
    return this.summary === null ? 0 : Date.now() - this.summaryAt;
  }

  /** A clean finish is worth animating; a failure or a bare summary is not. */
  private celebrates(): boolean {
    return this.summary !== null && exitCodeFor(this.summary) === 0;
  }

  /** The phrase to show right now, or null when the bar should be idle. */
  private activityLabel(): string | null {
    // A finished run's summary owns the bar until the app closes.
    if (this.summary) return null;
    const phrases = this.workPhrases;
    if (!phrases || phrases.length === 0) return null;
    const index = Math.floor(this.workTick / PHRASE_TICKS) % phrases.length;
    return phrases[index] ?? null;
  }

  /** Starts (or re-points) the activity bar at one or more phrases. */
  private startWork(phrases: string[]): void {
    this.workPhrases = phrases.length > 0 ? phrases : ["working…"];
    this.workTick = 0;
    this.renderStatus();
    this.syncTick();
  }

  /** Clears the activity phrases; `syncTick` decides whether to keep ticking. */
  private stopWork(): void {
    this.workPhrases = null;
    this.workTick = 0;
    this.syncTick();
  }

  /** Runs the 80 ms tick exactly while something on the bar is animating. */
  private syncTick(): void {
    if (this.finished || !this.isAnimating()) {
      this.stopTick();
      return;
    }
    if (this.workTimer !== null) return;
    this.workTimer = setInterval(() => {
      // A quit may have destroyed the render tree without the timer knowing.
      if (this.finished) {
        this.stopTick();
        return;
      }
      this.workTick++;
      this.renderStatus();
      if (!this.isAnimating()) this.stopTick();
    }, ACTIVITY_MS);
  }

  private stopTick(): void {
    if (this.workTimer === null) return;
    clearInterval(this.workTimer);
    this.workTimer = null;
  }

  /** Whether the bar still has something to animate (phrase or clean finish). */
  private isAnimating(): boolean {
    if (this.workPhrases !== null) return true;
    return this.celebrates() && finishPhase(this.finishElapsed()) !== "rest";
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
    // While work is running the left-hand phrase says what is happening; a
    // second "working…" here would just be noise.
    if (this.busy) return "";
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

/**
 * Maps a final summary line to a process exit code.
 *
 * `Done: N upgraded, M failed.` → 1 when anything failed. Any other summary is
 * a failure too ("Cannot start.", "Scan failed.", "Finished with errors."),
 * except the explicit nothing-to-do case.
 */
export function exitCodeFor(summary: string): number {
  const match = /Done: \d+ (?:would upgrade|upgraded), (\d+) failed/.exec(summary);
  if (match) return Number(match[1]) > 0 ? 1 : 0;
  if (/nothing to do/i.test(summary)) return 0;
  return 1;
}
