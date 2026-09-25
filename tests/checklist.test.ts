/**
 * The checklist is imperative, so it is tested through the in-memory renderer:
 * build the tree, update it, and assert on captured frame text.
 */
import { describe, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Checklist, type ChecklistRow } from "../src/ui/checklist";

async function mount(): Promise<{
  checklist: Checklist;
  frame: () => string;
  render: () => Promise<unknown>;
  dispose: () => void;
}> {
  const setup = await createTestRenderer({ width: 60, height: 12 });
  const root = new BoxRenderable(setup.renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const checklist = new Checklist(setup.renderer, "Packages");
  root.add(checklist.root);
  setup.renderer.root.add(root);
  await setup.renderOnce();
  return {
    checklist,
    frame: () => setup.captureCharFrame(),
    render: () => setup.renderOnce(),
    dispose: () => setup.renderer.destroy(),
  };
}

describe("Checklist", () => {
  test("renders checked, unchecked and locked rows", async () => {
    const ui = await mount();
    try {
      const rows: ChecklistRow[] = [
        { id: "a", label: "alpha", checked: true },
        { id: "b", label: "beta", checked: false },
        { id: "c", label: "gamma", checked: false, locked: true },
      ];
      ui.checklist.setRows(rows);
      await ui.render();
      const text = ui.frame();
      expect(text).toContain("Packages");
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
      expect(text).toContain("gamma");
      expect(text).toContain("[x]");
      expect(text).toContain("[ ]");
      expect(text).toContain("[-]");
    } finally {
      ui.dispose();
    }
  });

  test("marks the cursor row", async () => {
    const ui = await mount();
    try {
      ui.checklist.setRows([
        { id: "a", label: "alpha", checked: false },
        { id: "b", label: "beta", checked: false },
      ]);
      ui.checklist.setCursor(1);
      await ui.render();
      const lines = ui.frame().split("\n");
      const beta = lines.find((line) => line.includes("beta")) ?? "";
      const alpha = lines.find((line) => line.includes("alpha")) ?? "";
      expect(beta).toContain("›");
      expect(alpha).not.toContain("›");
    } finally {
      ui.dispose();
    }
  });

  test("renders hints on the right", async () => {
    const ui = await mount();
    try {
      ui.checklist.setRows([
        { id: "a", label: "alpha", hint: "1.0.0 → 2.0.0", checked: true },
      ]);
      await ui.render();
      expect(ui.frame()).toContain("1.0.0 → 2.0.0");
    } finally {
      ui.dispose();
    }
  });

  test("renders group headings", async () => {
    const ui = await mount();
    try {
      ui.checklist.setRows([
        { id: "g", label: "Global npm packages", checked: false, heading: true },
        { id: "a", label: "alpha", checked: true },
      ]);
      await ui.render();
      expect(ui.frame()).toContain("Global npm packages");
    } finally {
      ui.dispose();
    }
  });

  test("shows the empty message when there are no rows", async () => {
    const ui = await mount();
    try {
      ui.checklist.setEmptyText("Loading…");
      ui.checklist.setRows([]);
      await ui.render();
      expect(ui.frame()).toContain("Loading…");
    } finally {
      ui.dispose();
    }
  });

  test("shrinks cleanly when the row list gets shorter", async () => {
    const ui = await mount();
    try {
      ui.checklist.setRows([
        { id: "a", label: "alpha", checked: false },
        { id: "b", label: "beta", checked: false },
      ]);
      await ui.render();
      ui.checklist.setRows([{ id: "a", label: "alpha", checked: false }]);
      await ui.render();
      const text = ui.frame();
      expect(text).toContain("alpha");
      expect(text).not.toContain("beta");
    } finally {
      ui.dispose();
    }
  });

  test("headings are not selectable and take no cursor slot", async () => {
    const ui = await mount();
    try {
      ui.checklist.setRows([
        { id: "g", label: "Group A", checked: false, heading: true },
        { id: "a", label: "alpha", checked: false },
        { id: "g2", label: "Group B", checked: false, heading: true },
        { id: "b", label: "beta", checked: false },
      ]);
      await ui.render();
      // Only the two real rows are selectable.
      expect(ui.checklist.selectableIndexes()).toEqual([1, 3]);

      // Cursor position 1 is the *second* selectable row (beta), not a heading.
      ui.checklist.setCursor(1);
      await ui.render();
      const lines = ui.frame().split("\n");
      const beta = lines.find((line) => line.includes("beta")) ?? "";
      const groupB = lines.find((line) => line.includes("Group B")) ?? "";
      expect(beta).toContain("›");
      expect(groupB).not.toContain("›");
      // Headings never render a checkbox.
      expect(groupB).not.toContain("[");
    } finally {
      ui.dispose();
    }
  });

  test("long labels truncate instead of wrapping into the marker column", async () => {
    const ui = await mount();
    try {
      ui.checklist.setRows([
        {
          id: "long",
          label:
            "Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.459.401.0) - Current Channel (Broad)",
          hint: "KB2267602",
          checked: true,
        },
        { id: "short", label: "ImageAI", hint: "G:\\ImageAI\\update.py", checked: true },
      ]);
      await ui.render();
      const lines = ui.frame().split("\n");
      const longRow = lines.find((line) => line.includes("Security Intelligence")) ?? "";
      // One line: cursor + checkbox in the gutter, label truncated, hint kept.
      expect(longRow).toContain("[x] Security Intelligence");
      expect(longRow).toContain("…");
      expect(longRow).toContain("KB2267602");
      expect(lines.filter((line) => line.includes("Current Channel")).length).toBe(0);
      // The hint stays to the right of the label on that line.
      const labelIndex = longRow.indexOf("Security Intelligence");
      expect(longRow.indexOf("KB2267602")).toBeGreaterThan(labelIndex);
    } finally {
      ui.dispose();
    }
  });
});
