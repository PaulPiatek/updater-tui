/**
 * A scrollable multi-select list built from OpenTUI's imperative primitives.
 *
 * OpenTUI's `SelectRenderable` is single-choice, so this composes `Box`,
 * `Text` and `ScrollBox` nodes instead. It owns the row nodes and updates them
 * in place; the parent supplies items and the cursor index.
 *
 * Items are a flat list the caller builds. A `heading` item is a non-selectable
 * group label: it renders as its own line and is skipped by the cursor.
 *
 * Layout is deliberately fixed-width on the left (`› [x] `) so rows stay
 * aligned. Labels use `wrapMode: "none"` and truncate rather than wrap — a
 * wrapped label pushes the checkbox out of its column (see the pane width).
 */
import {
  BoxRenderable,
  LayoutEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type RenderContext,
} from "@opentui/core";
import { colors, checkbox, truncate } from "./theme";

export interface ChecklistRow {
  /** Stable id, used by the parent for selection bookkeeping. */
  id: string;
  label: string;
  /** Right-hand text (versions, reasons). */
  hint?: string;
  checked: boolean;
  /** Locked rows are shown but can't be toggled. */
  locked?: boolean;
  /** When set, this is a group heading, not a selectable row. */
  heading?: boolean;
}

interface RowNodes {
  wrapper: BoxRenderable;
  line: BoxRenderable;
  marker: TextRenderable;
  label: TextRenderable;
  hint: TextRenderable;
}

/** Cursor + checkbox gutter, e.g. `› [x] `. Fixed so labels line up. */
const MARKER_WIDTH = 6;

export class Checklist {
  readonly root: BoxRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly content: BoxRenderable;
  private readonly empty: TextRenderable;
  private nodes: RowNodes[] = [];
  private rows: ChecklistRow[] = [];
  private cursor = 0;

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

    this.scroll = new ScrollBoxRenderable(renderer, {
      flexGrow: 1,
      scrollY: true,
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
    this.empty = new TextRenderable(renderer, {
      content: "  Nothing here",
      fg: colors.dim,
    });
    this.content.add(this.empty);
    this.scroll.add(this.content);
    this.root.add(this.scroll);

    // Truncated labels depend on the pane width, so recompute on resize.
    this.root.on(LayoutEvents.RESIZED, () => this.refreshHighlight());
  }

  /** Replaces the pane title (stage 1 → 2). */
  setTitle(title: string): void {
    this.root.title = title;
  }

  /**
   * Replaces the items. Heading items render as a labelled line; the cursor
   * index counts only real rows, so callers use `selectableIndexes()` to map.
   */
  setRows(rows: ChecklistRow[]): void {
    this.rows = rows;

    for (let index = 0; index < rows.length; index++) {
      const nodes = this.nodes[index] ?? this.createRow(index);
      this.updateRow(nodes, rows[index]!);
    }

    for (let index = rows.length; index < this.nodes.length; index++) {
      this.nodes[index]!.wrapper.destroyRecursively();
    }
    this.nodes.length = Math.min(this.nodes.length, rows.length);

    this.empty.visible = rows.length === 0;
    this.refreshHighlight();
  }

  /** Sets the empty-state message (e.g. "Loading…"). */
  setEmptyText(text: string): void {
    this.empty.content = `  ${text}`;
  }

  /** The indexes of the non-heading rows, in order. */
  selectableIndexes(): number[] {
    const indexes: number[] = [];
    this.rows.forEach((row, index) => {
      if (!row.heading) indexes.push(index);
    });
    return indexes;
  }

  /**
   * Moves the cursor to a *selectable* row by its position in the selectable
   * list (`0` = first real row). Headings are skipped automatically.
   */
  setCursor(position: number): void {
    const indexes = this.selectableIndexes();
    const index = indexes.length === 0 ? -1 : indexes[Math.min(Math.max(position, 0), indexes.length - 1)]!;
    if (index === this.cursor) return;
    this.cursor = index;
    this.refreshHighlight();
    if (index >= 0) {
      const id = this.rows[index]?.id;
      if (id) this.scroll.scrollChildIntoView(this.rowDomId(id));
    }
  }

  private rowDomId(id: string): string {
    return `checklist-${id}`;
  }

  private createRow(index: number): RowNodes {
    const wrapper = new BoxRenderable(this.renderer, {
      flexDirection: "column",
      width: "100%",
    });
    const line = new BoxRenderable(this.renderer, {
      flexDirection: "row",
      width: "100%",
      height: 1,
    });
    const marker = new TextRenderable(this.renderer, {
      content: "",
      fg: colors.text,
      width: MARKER_WIDTH,
      wrapMode: "none",
    });
    const label = new TextRenderable(this.renderer, {
      content: "",
      fg: colors.text,
      wrapMode: "none",
      flexGrow: 1,
      flexShrink: 1,
    });
    const hint = new TextRenderable(this.renderer, {
      content: "",
      fg: colors.dim,
      wrapMode: "none",
      flexShrink: 0,
    });

    line.add(marker);
    line.add(label);
    line.add(hint);
    wrapper.add(line);

    this.content.add(wrapper);
    this.nodes[index] = { wrapper, line, marker, label, hint };
    return this.nodes[index]!;
  }

  private updateRow(nodes: RowNodes, row: ChecklistRow): void {
    nodes.wrapper.id = this.rowDomId(row.id);
    nodes.wrapper.height = 1;

    if (row.heading) {
      // A heading: no marker, no hint, just an indented label.
      nodes.marker.content = "";
      nodes.label.content = `  ${row.label}`;
      nodes.label.fg = colors.heading;
      nodes.hint.content = "";
      nodes.line.backgroundColor = undefined;
      return;
    }

    nodes.marker.content = this.markerFor(row, false);
    const { label, hint } = this.fit(row);
    nodes.label.content = label;
    nodes.hint.content = hint ? ` ${hint}` : "";
  }

  /** Usable columns inside the pane's border and scrollbar. */
  private innerWidth(): number {
    // `width` is 0 before the first layout pass; fall back to a sane guess.
    const width = this.root.width > 0 ? this.root.width : 40;
    return Math.max(MARKER_WIDTH, width - 4);
  }

  /**
   * Splits the available width between the label and the hint.
   *
   * The hint (a version, path, or size) gets at most half the space; a long one
   * is truncated so it can never push the label out of its column.
   */
  private fit(row: ChecklistRow): { label: string; hint: string } {
    const available = this.innerWidth() - MARKER_WIDTH;
    if (!row.hint) {
      return { label: truncate(row.label, available), hint: "" };
    }

    const maxHint = Math.max(8, Math.floor(available / 2));
    const hint = truncate(row.hint, maxHint);
    const label = truncate(row.label, Math.max(4, available - hint.length - 1));
    return { label, hint };
  }

  private markerFor(row: ChecklistRow, active: boolean): string {
    return `${active ? "›" : " "} ${checkbox(row.checked, row.locked === true)} `;
  }

  private refreshHighlight(): void {
    this.nodes.forEach((nodes, index) => {
      const row = this.rows[index];
      if (!row) return;
      if (row.heading) {
        // Recompute on resize, when the available width changes.
        nodes.label.content = truncate(`  ${row.label}`, this.innerWidth());
        nodes.label.fg = colors.heading;
        nodes.line.backgroundColor = undefined;
        return;
      }
      const active = index === this.cursor;
      const fg = active
        ? colors.selectionFg
        : row.locked
          ? colors.dim
          : colors.text;
      const { label, hint } = this.fit(row);
      nodes.marker.content = this.markerFor(row, active);
      nodes.marker.fg = fg;
      nodes.label.content = label;
      nodes.label.fg = fg;
      nodes.hint.content = hint ? ` ${hint}` : "";
      nodes.hint.fg = active ? colors.selectionFg : colors.dim;
      nodes.line.backgroundColor = active ? colors.selectionBg : undefined;
    });
  }
}
