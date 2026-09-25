/**
 * Colours and small text helpers shared by the panes. Kept in one place so the
 * whole app can be re-themed by editing this file.
 */

export const colors = {
  accent: "#7aa2f7",
  dim: "#565f89",
  text: "#c0caf5",
  muted: "#9aa5ce",
  good: "#9ece6a",
  bad: "#f7768e",
  warn: "#e0af68",
  heading: "#bb9af7",
  border: "#3b4261",
  selectedBg: "#1f2335",
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
