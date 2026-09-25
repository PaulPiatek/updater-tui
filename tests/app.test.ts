/**
 * Renders an `App` with OpenTUI's in-memory test renderer and inspects the
 * captured frame. No PTY and no PTY diffing, so assertions are deterministic.
 */
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxRenderable } from "@opentui/core";
import { App } from "../src/ui/app";

/** Builds a temp project with one custom script so discovery has something. */
async function project(): Promise<{ cwd: string; dispose: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "updater-tui-app-"));
  const scriptPath = join(cwd, "fake.cmd");
  await writeFile(scriptPath, "@echo off\r\nexit /b 0\r\n");
  await writeFile(
    join(cwd, "updater.config.json"),
    JSON.stringify({
      ignore: [],
      pin: [],
      scripts: [{ name: "fake", path: scriptPath }],
    }),
  );
  return { cwd, dispose: () => rm(cwd, { recursive: true, force: true }) };
}

/** `waitForFrame` throws on exhaustion; wrap it to return the last frame. */
async function frame(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (text: string) => boolean,
): Promise<string> {
  try {
    return await setup.waitForFrame(predicate);
  } catch {
    return setup.captureCharFrame();
  }
}

describe("App (imperative UI)", () => {
  test("panes split the terminal roughly in half at any width", async () => {
    const proj = await project();
    // Regression: a `%` width resolved against the wrong basis once nested, so
    // the pane stayed a fixed size instead of tracking the terminal.
    for (const terminalWidth of [120, 180, 200]) {
      const setup = await createTestRenderer({ width: terminalWidth, height: 30 });
      let app: App | undefined;
      try {
        app = new App(setup.renderer, {
          cwd: proj.cwd,
          sourceFilter: ["custom"],
          dryRun: false,
        });
        void app.run();
        await frame(setup, (f) => f.includes("Custom scripts"));

        const rootBox = setup.renderer.root.getChildren()[0] as BoxRenderable;
        const body = rootBox.getChildren()[0] as BoxRenderable;
        const [left, right] = body.getChildren() as BoxRenderable[];
        const leftWidth = left?.width ?? 0;
        const rightWidth = right?.width ?? 0;

        // The two panes plus the 1-column gap fill the terminal.
        expect(leftWidth + rightWidth).toBe(terminalWidth - 1);
        // Each side is about half; allow a small margin for the gap.
        expect(leftWidth).toBeGreaterThan(terminalWidth * 0.4);
        expect(leftWidth).toBeLessThan(terminalWidth * 0.6);
        expect(rightWidth).toBeGreaterThan(terminalWidth * 0.4);
      } finally {
        app?.destroy();
        setup.renderer.destroy();
      }
    }
    await proj.dispose();
  });

  test("renders the sources stage", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 120, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, {
        cwd: proj.cwd,
        sourceFilter: ["custom"],
        dryRun: false,
      });
      void app.run();

      const text = await frame(setup, (f) => f.includes("Custom scripts"));
      expect(text).toContain("Sources");
      expect(text).toContain("Custom scripts");
      expect(text).toContain("[x]");
      expect(text).toContain("space toggle");
      expect(text).toContain("Select sources, then Enter to scan.");
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });

  test("Enter scans and moves to the package stage with the script", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 120, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, {
        cwd: proj.cwd,
        sourceFilter: ["custom"],
        dryRun: false,
      });
      void app.run();
      await frame(setup, (text) => text.includes("Custom scripts"));

      setup.mockInput.pressEnter();
      const text = await frame(setup, (f) => f.includes("Choose packages"));
      expect(text).toContain("Packages");
      expect(text).toContain("Custom scripts");
      expect(text).toContain("fake");
      expect(text).toContain("Enter upgrade (1)");
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });
});
