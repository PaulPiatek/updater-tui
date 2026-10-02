/**
 * Colours and small text helpers shared by the panes.
 *
 * Every colour is terminal-native: an ANSI palette slot (0-15), which OpenTUI
 * forwards as `SGR 38;5;n` / `SGR 48;5;n`, so the *terminal* resolves it against
 * its own scheme. The app therefore follows the user's colour scheme, and
 * re-theming the terminal recolours it live.
 *
 * Two rules, both learned by measuring the render buffer:
 *
 * - Slots 16-255 are off-limits: they are the fixed xterm RGB cube and greys,
 *   not theme colours.
 * - `defaultForeground()` is off-limits too. Despite the docs it does not emit
 *   `SGR 39` here — the native renderer resolves it to its built-in white
 *   snapshot — so body text uses slot 7, the scheme's own "white".
 */
import { RGBA } from "@opentui/core";

/**
 * Semantic colours, mapped onto the 16 theme-defined palette slots.
 *
 * Slots 0-7 are the base colours and 8-15 their bright variants. The bright
 * half is used for anything that has to stay legible against the default
 * background.
 */
export const colors = {
  accent: RGBA.fromIndex(12), // bright blue
  heading: RGBA.fromIndex(13), // bright magenta
  good: RGBA.fromIndex(10), // bright green
  bad: RGBA.fromIndex(9), // bright red
  warn: RGBA.fromIndex(11), // bright yellow
  /** Bright black is the slot every scheme uses for its quiet grey. */
  muted: RGBA.fromIndex(8),
  dim: RGBA.fromIndex(8),
  border: RGBA.fromIndex(8),
  scrollThumb: RGBA.fromIndex(8),
  /** `SGR 49` — the terminal's own background, i.e. an invisible scroll track. */
  scrollTrack: RGBA.defaultBackground(),
  text: RGBA.fromIndex(7),
  /** The active row: an accent bar, with the brightest slot for its text. */
  selectionBg: RGBA.fromIndex(12),
  selectionFg: RGBA.fromIndex(15),
} as const;

/** Truncates to `width` columns, adding an ellipsis when it doesn't fit. */
export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";
  return `${value.slice(0, width - 1)}…`;
}

/** A `[x]` / `[ ]` / `[-]` checkbox marker. */
export function checkbox(
  checked: boolean,
  locked: boolean,
): string {
  if (locked) return "[-]";
  return checked ? "[x]" : "[ ]";
}
