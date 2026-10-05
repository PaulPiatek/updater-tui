/**
 * The right-hand output pane: an append-only log of what the app is doing
 * (scan progress, per-item results, script framing).
 *
 * Keeps one `Text` node per line and appends to a sticky-bottom `ScrollBox`, so
 * the newest line is always visible without re-rendering the whole log.
 */
import {
  BoxRenderable,
  LayoutEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type RGBA,
  type RenderContext,
} from "@opentui/core";
import { colors, truncate } from "./theme";

export type LogLevel = "info" | "good" | "bad" | "warn" | "step";

export interface LogLine {
  level: LogLevel;
  text: string;
}

const levelColor = (level: LogLevel): RGBA => {
  switch (level) {
    case "good":
      return colors.good;
    case "bad":
      return colors.bad;
    case "warn":
      return colors.warn;
    case "step":
      return colors.heading;
    default:
      return colors.text;
  }
};

const levelMark = (level: LogLevel): string => {
  switch (level) {
    case "good":
      return "✔";
    case "bad":
      return "✖";
    case "warn":
      return "⚠";
    case "step":
      return "●";
    default:
      return "·";
  }
};

/** How a per-source status row is marked. */
export type StatusState = "pending" | "checking" | "good" | "empty" | "bad";

const statusColor = (state: StatusState): RGBA => {
  switch (state) {
    case "good":
      return colors.good;
    case "bad":
      return colors.bad;
    case "checking":
      return colors.accent;
    default:
      return colors.dim;
  }
};

const statusMark = (state: StatusState): string => {
  switch (state) {
    case "good":
      return "✔";
    case "bad":
      return "✖";
    case "checking":
      return "⠋";
    case "empty":
      return "·";
    default:
      return " ";
  }
};

/** One live status row, updated in place as a source scans. */
interface StatusRow {
  label: TextRenderable;
  value: TextRenderable;
  labelText: string;
  valueText: string;
}

/** An append-only status log rendered into a scrollable pane. */
export class OutputPane {
  readonly root: BoxRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly content: BoxRenderable;
  private readonly statusRows: BoxRenderable;
  private rows = new Map<string, StatusRow>();
  private order: string[] = [];
  private lines: TextRenderable[] = [];

  constructor(
    private readonly renderer: RenderContext,
    title: string,
  ) {
    this.root = new BoxRenderable(renderer, {
      flexDirection: "column",
      flexGrow: 1,
      borderStyle: "rounded",
      borderColor: colors.border,
      title,
      titleAlignment: "left",
    });

    // Live per-source status, pinned above the scrolling log. Hidden until a
    // scan populates it (see `showStatus`).
    this.statusRows = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
      visible: false,
    });
    this.root.add(this.statusRows);

    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      scrollbarOptions: {
        showArrows: false,
        trackOptions: {
          backgroundColor: colors.scrollTrack,
          foregroundColor: colors.scrollThumb,
        },
      },
    });
    this.content = new BoxRenderable(renderer, {
      flexDirection: "column",
      width: "100%",
    });
    this.scroll.add(this.content);
    this.root.add(this.scroll);

    // The label/value split depends on the pane width, so re-fit on resize.
    this.root.on(LayoutEvents.RESIZED, () => this.layoutStatus());
  }

  /**
   * Shows a live status row per source (keyed by id), all starting "pending".
   * Replaces any rows from a previous scan.
   */
  showStatus(entries: Array<{ id: string; title: string }>): void {
    for (const row of this.rows.values()) {
      row.label.destroyRecursively();
      row.value.destroyRecursively();
    }
    this.rows.clear();
    this.order = [];
    this.rows.clear();

    for (const entry of entries) {
      const line = new BoxRenderable(this.renderer, {
        flexDirection: "row",
        width: "100%",
        height: 1,
      });
      const label = new TextRenderable(this.renderer, {
        content: entry.title,
        fg: colors.muted,
        wrapMode: "none",
        height: 1,
        flexGrow: 0,
        flexShrink: 0,
      });
      const value = new TextRenderable(this.renderer, {
        content: "checking…",
        fg: colors.dim,
        wrapMode: "none",
        height: 1,
        flexGrow: 0,
        flexShrink: 0,
      });
      line.add(label);
      line.add(new BoxRenderable(this.renderer, { flexGrow: 1, height: 1 }));
      line.add(value);
      this.statusRows.add(line);
      this.order.push(entry.id);
      this.rows.set(entry.id, {
        label,
        value,
        labelText: entry.title,
        valueText: "checking…",
      });
    }

    this.statusRows.visible = entries.length > 0;
    this.layoutStatus();
  }

  /** Updates one source's status row. No-op if the row is unknown. */
  setStatus(id: string, state: StatusState, text: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.valueText = `${statusMark(state)} ${text}`;
    row.value.fg = statusColor(state);
    this.layoutStatus();
  }

  /**
   * Fits each row into the pane: the status text keeps its full width and the
   * label absorbs the remainder, truncated so the two never overlap.
   */
  private layoutStatus(): void {
    // `width` is 0 before the first layout pass; fall back to a sane guess.
    const width = this.root.width > 0 ? this.root.width : 40;
    // Border (2) + a little padding each side.
    const available = Math.max(12, width - 6);

    for (const id of this.order) {
      const row = this.rows.get(id);
      if (!row) continue;
      const value = row.valueText;
      const labelWidth = Math.max(4, available - value.length);
      row.label.content = truncate(row.labelText, labelWidth);
      row.value.content = value;
    }
  }

  /** Hides and clears the status header (e.g. when starting to upgrade). */
  clearStatus(): void {
    for (const row of this.rows.values()) {
      row.label.destroyRecursively();
      row.value.destroyRecursively();
    }
    this.rows.clear();
    this.order = [];
    this.statusRows.visible = false;
  }

  /** Appends one line to the log. */
  push(level: LogLevel, text: string): void {
    const line = new TextRenderable(this.renderer, {
      content: `${levelMark(level)} ${text}`,
      fg: levelColor(level),
    });
    this.content.add(line);
    this.lines.push(line);
    this.scroll.scrollTo(this.scroll.scrollHeight);
  }

  /** Removes every line (used when restarting the flow). */
  clear(): void {
    this.clearStatus();
    for (const line of this.lines) line.destroyRecursively();
    this.lines = [];
  }
}
