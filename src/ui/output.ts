/**
 * The right-hand output pane: an append-only log of what the app is doing
 * (scan progress, per-item results, script framing).
 *
 * Keeps one `Text` node per line and appends to a sticky-bottom `ScrollBox`, so
 * the newest line is always visible without re-rendering the whole log.
 */
import {
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type RGBA,
  type RenderContext,
} from "@opentui/core";
import { colors } from "./theme";

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

/** An append-only status log rendered into a scrollable pane. */
export class OutputPane {
  readonly root: BoxRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly content: BoxRenderable;
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
    for (const line of this.lines) line.destroyRecursively();
    this.lines = [];
  }
}
