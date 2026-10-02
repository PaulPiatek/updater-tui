/**
 * Guards the terminal-native palette in `src/ui/theme.ts`.
 *
 * The app must never paint a hard-coded RGB colour: every visible colour has to
 * be an ANSI palette slot (or a terminal default), so the terminal's own scheme
 * decides how the app looks. These assertions read the packed cell data, where
 * OpenTUI keeps the colour *intent* alongside the RGB fallback.
 */
import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Checklist, type ChecklistRow } from "../src/ui/checklist";
import { colors } from "../src/ui/theme";

const ROWS: ChecklistRow[] = [
  { id: "group", label: "Group", checked: false, heading: true },
  { id: "a", label: "first", hint: "1.0.0", checked: true },
  { id: "b", label: "second", hint: "2.0.0", checked: false },
  { id: "c", label: "third", checked: false, locked: true },
];

async function render(width = 40, height = 12) {
  const setup = await createTestRenderer({ width, height });
  const list = new Checklist(setup.renderer, "Sources");
  setup.renderer.root.add(list.root);
  list.setRows(ROWS);
  list.setCursor(1); // "second" is the active row
  await setup.renderOnce();
  return setup;
}

/** Every non-blank glyph the frame painted, with its resolved colours. */
function glyphs(setup: Awaited<ReturnType<typeof render>>) {
  return setup
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .filter((span) => span.text.trim().length > 0);
}

/** The packed colour of one cell, straight out of the render buffer. */
function cell(
  setup: Awaited<ReturnType<typeof render>>,
  channel: "fg" | "bg",
  x: number,
  y: number,
): RGBA {
  const buffer = setup.renderer.currentRenderBuffer;
  const offset = (y * buffer.width + x) * 4;
  return RGBA.fromArray(buffer.buffers[channel].subarray(offset, offset + 4));
}

describe("theme colours", () => {
  test("every glyph is painted with a palette slot, never a literal RGB", async () => {
    const setup = await render();
    const spans = glyphs(setup);
    expect(spans.length).toBeGreaterThan(10);

    const literal = spans.filter((span) => span.fg.intent === "rgb");
    expect(literal.map((span) => span.text)).toEqual([]);

    setup.renderer.destroy();
  });

  test("the colours map onto the documented ANSI slots", async () => {
    const setup = await render();
    const slots = new Set(glyphs(setup).map((span) => span.fg.slot));
    // 7 body text, 8 dim/border, 13 heading, 15 the active row's text.
    for (const slot of [7, 8, 13, 15]) expect(slots).toContain(slot);

    setup.renderer.destroy();
  });

  test("the active row is an accent bar, not a fixed background swatch", async () => {
    const setup = await render();
    const active = setup
      .captureSpans()
      .lines.map((line, index) => ({ index, line }))
      .find(({ line }) => line.spans.some((span) => span.text.includes("second")));
    expect(active).toBeDefined();

    const focus = active!.line.spans.find((span) => span.text.includes("second"))!;
    expect(focus.fg.slot).toBe(colors.selectionFg.slot);

    // The bar is a background on the row's boxes, painted behind the gutter
    // and the label, so scan the whole line rather than one cell.
    const width = setup.renderer.currentRenderBuffer.width;
    const bar = Array.from({ length: width }, (_, x) => cell(setup, "bg", x, active!.index)).find(
      (bg) => bg.intent === "indexed",
    );
    expect(bar?.slot).toBe(12);

    setup.renderer.destroy();
  });
});
