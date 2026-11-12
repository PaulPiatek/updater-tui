/**
 * A transient badge that floats over the top-right corner of the screen.
 *
 * It is absolutely positioned, so it takes no part in the pane layout and can
 * be raised from anywhere without disturbing what is on screen. `show` puts it
 * up and starts a timer that hides it again; a second `show` replaces the text
 * and restarts that timer.
 */
import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { colors } from "./theme";

/** How long a badge stays on screen before hiding itself. */
export const TOAST_MS = 1_000;

/** Inset from the top-right edge, so the badge sits inside the pane border. */
const INSET_TOP = 1;
const INSET_RIGHT = 2;

export type ToastTone = "good" | "warn";

export class Toast {
  readonly root: BoxRenderable;
  private readonly label: TextRenderable;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, {
      // Absolute, not flex: the badge must not shrink the panes when it appears.
      position: "absolute",
      top: INSET_TOP,
      right: INSET_RIGHT,
      zIndex: 10,
      flexDirection: "row",
      borderStyle: "rounded",
      borderColor: colors.good,
      // The terminal's own background, so the pane underneath is covered by the
      // badge rather than bleeding through it.
      backgroundColor: colors.scrollTrack,
      paddingLeft: 1,
      paddingRight: 1,
      visible: false,
    });
    this.label = new TextRenderable(renderer, {
      content: "",
      fg: colors.good,
      wrapMode: "none",
    });
    this.root.add(this.label);
  }

  /** Shows `message` for `TOAST_MS`, replacing any badge already up. */
  show(message: string, tone: ToastTone = "good"): void {
    const colour = tone === "good" ? colors.good : colors.warn;
    this.label.content = message;
    this.label.fg = colour;
    this.root.borderColor = colour;
    this.root.visible = true;
    this.clearTimer();
    this.timer = setTimeout(() => this.hide(), TOAST_MS);
    this.renderer.requestRender();
  }

  /** Hides the badge now. Safe to call when it is already hidden. */
  hide(): void {
    this.clearTimer();
    if (!this.root.visible) return;
    this.root.visible = false;
    this.renderer.requestRender();
  }

  /**
   * Stops the pending hide timer. Call when the UI is torn down: a timer that
   * fires after `renderer.destroy()` would write to a destroyed render tree.
   */
  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
