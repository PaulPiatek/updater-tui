/**
 * The output pane's live per-source status header, tested through the in-memory
 * renderer: populate rows, update them in place, clear them.
 */
import { describe, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { OutputPane } from "../src/ui/output";

async function mount(width = 60): Promise<{
  pane: OutputPane;
  frame: () => string;
  render: () => Promise<unknown>;
  dispose: () => void;
}> {
  const setup = await createTestRenderer({ width, height: 14 });
  const root = new BoxRenderable(setup.renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const pane = new OutputPane(setup.renderer, "Output");
  root.add(pane.root);
  setup.renderer.root.add(root);
  await setup.renderOnce();
  return {
    pane,
    frame: () => setup.captureCharFrame(),
    render: () => setup.renderOnce(),
    dispose: () => setup.renderer.destroy(),
  };
}

describe("OutputPane status header", () => {
  test("is hidden until a scan populates it", async () => {
    const ui = await mount();
    try {
      expect(ui.frame()).not.toContain("winget");
      ui.pane.showStatus([{ id: "winget", title: "winget" }]);
      await ui.render();
      expect(ui.frame()).toContain("winget");
      expect(ui.frame()).toContain("checking…");
    } finally {
      ui.dispose();
    }
  });

  test("updates each row in place as a source settles", async () => {
    const ui = await mount();
    try {
      ui.pane.showStatus([
        { id: "npm", title: "Global npm packages" },
        { id: "winget", title: "winget" },
      ]);
      await ui.render();

      ui.pane.setStatus("npm", "good", "3 update(s)");
      ui.pane.setStatus("winget", "empty", "up to date");
      await ui.render();

      const frame = ui.frame();
      expect(frame).toContain("Global npm packages");
      expect(frame).toContain("✔ 3 update(s)");
      expect(frame).toContain("· up to date");
      // The other row is updated too, not appended as a new line.
      expect(frame.match(/winget/g)?.length).toBe(1);
    } finally {
      ui.dispose();
    }
  });

  test("shows an error state", async () => {
    const ui = await mount();
    try {
      ui.pane.showStatus([{ id: "windows-update", title: "Windows Update" }]);
      ui.pane.setStatus("windows-update", "bad", "timed out");
      await ui.render();
      expect(ui.frame()).toContain("✖ timed out");
    } finally {
      ui.dispose();
    }
  });

  test("setStatus ignores unknown ids; clearStatus removes the header", async () => {
    const ui = await mount();
    try {
      ui.pane.showStatus([{ id: "npm", title: "Global npm packages" }]);
      ui.pane.setStatus("nope", "good", "ignored");
      await ui.render();
      expect(ui.frame()).not.toContain("ignored");

      ui.pane.clearStatus();
      await ui.render();
      expect(ui.frame()).not.toContain("Global npm packages");
    } finally {
      ui.dispose();
    }
  });

  test("header does not overlap a log line pushed before the scan", async () => {
    // Regression: the status box was sized before its rows were added, so it
    // drew over the log's first line (e.g. "·iSelectUsources…").
    const ui = await mount(62);
    try {
      ui.pane.push("info", "Select sources, then Enter to scan.");
      await ui.render();
      ui.pane.showStatus([
        { id: "npm", title: "Global npm packages" },
        { id: "winget", title: "Windows Package Manager (winget)" },
        { id: "store", title: "Microsoft Store apps" },
        { id: "wu", title: "Windows Update" },
      ]);
      await ui.render();

      const frame = ui.frame();
      // The log line survives intact…
      expect(frame).toContain("Select sources, then Enter to scan.");
      // …and no status row interleaves with it.
      expect(frame).not.toContain("uSelect");
      expect(frame).not.toContain("SelectUsources");
    } finally {
      ui.dispose();
    }
  });

  test("long labels truncate instead of pushing the status off-row", async () => {
    // A narrow pane, where the label cannot fit alongside the status.
    const ui = await mount(40);
    try {
      ui.pane.showStatus([
        { id: "winget", title: "Windows Package Manager (winget)" },
      ]);
      ui.pane.setStatus("winget", "good", "1 update(s)");
      await ui.render();

      const row = ui
        .frame()
        .split("\n")
        .find((line) => line.includes("update(s)"));
      // The label and its status share one line; the label is ellipsised, so
      // "winget)" never survives and the status keeps its full text.
      expect(row).toBeDefined();
      expect(row).toContain("…");
      expect(row).toContain("update(s)");
      expect(row).not.toContain("(winget)");
    } finally {
      ui.dispose();
    }
  });
});

