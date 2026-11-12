/**
 * Selecting text with the mouse copies it, and a badge confirms it.
 *
 * Everything here runs through the in-memory test renderer: `mockMouse` feeds
 * real mouse sequences into the input parser, so this exercises OpenTUI's own
 * selection rather than a stub. Only the clipboard write is replaced — a test
 * renderer has no terminal to send OSC 52 to.
 */
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/ui/app";
import { frameText, type Setup } from "./helpers";

/** A temp project with one custom script, so discovery has something to show. */
async function project(): Promise<{ cwd: string; dispose: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "updater-tui-copy-"));
  const scriptPath = join(cwd, "fake.cmd");
  await writeFile(scriptPath, "@echo off\r\nexit /b 0\r\n");
  await writeFile(
    join(cwd, "updater.config.json"),
    JSON.stringify({ ignore: [], pin: [], scripts: [{ name: "fake", path: scriptPath }] }),
  );
  return { cwd, dispose: () => rm(cwd, { recursive: true, force: true }) };
}

/**
 * Replaces the renderer's OSC 52 write with a recording stub — the same call the
 * app makes, so the text it hands over is what would reach the clipboard.
 */
function stubClipboard(setup: Setup, result = true): string[] {
  const copied: string[] = [];
  setup.renderer.copyToClipboardOSC52 = (text: string): boolean => {
    copied.push(text);
    return result;
  };
  return copied;
}

/** Frame row/column of `needle`, or throws so a bad fixture is obvious. */
function locate(frame: string, needle: string): { x: number; y: number } {
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes(needle));
  const line = lines[y];
  if (line === undefined) throw new Error(`not in frame: ${needle}`);
  return { x: line.indexOf(needle), y };
}

describe("copy on selection", () => {
  test("dragging over text copies it and shows a Copied badge top-right", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 120, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, { cwd: proj.cwd, sourceFilter: ["custom"], dryRun: false });
      void app.run();

      const first = await frameText(setup, (f) => f.includes("Select sources"));
      const copied = stubClipboard(setup);

      const needle = "Select sources";
      const at = locate(first, needle);
      await setup.mockMouse.drag(at.x, at.y, at.x + needle.length - 1, at.y);

      expect(copied).toHaveLength(1);
      expect(copied[0]).toContain(needle);

      // The badge is near the top and in the right half of the screen.
      const frame = await frameText(setup, (f) => f.includes("Copied"));
      const badge = locate(frame, "Copied");
      expect(badge.y).toBeLessThan(6);
      expect(badge.x).toBeGreaterThan(60);

      // …and it goes away on its own.
      await Bun.sleep(1_300);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("Copied");
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });

  test("a plain click copies nothing", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 120, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, { cwd: proj.cwd, sourceFilter: ["custom"], dryRun: false });
      void app.run();

      const first = await frameText(setup, (f) => f.includes("Select sources"));
      const copied = stubClipboard(setup);

      const at = locate(first, "Select sources");
      await setup.mockMouse.click(at.x, at.y);
      await setup.renderOnce();

      expect(copied).toHaveLength(0);
      expect(setup.captureCharFrame()).not.toContain("Copied");
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });

  test("a rejected clipboard write says so instead of claiming success", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 120, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, { cwd: proj.cwd, sourceFilter: ["custom"], dryRun: false });
      void app.run();

      const first = await frameText(setup, (f) => f.includes("Select sources"));
      const copied = stubClipboard(setup, false);

      const at = locate(first, "Select sources");
      await setup.mockMouse.drag(at.x, at.y, at.x + 5, at.y);

      expect(copied).toHaveLength(1);
      const frame = await frameText(setup, (f) => f.includes("Copy failed"));
      expect(frame).not.toContain("✔ Copied");
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });

  test("the badge does not move the panes", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 120, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, { cwd: proj.cwd, sourceFilter: ["custom"], dryRun: false });
      void app.run();

      const first = await frameText(setup, (f) => f.includes("Select sources"));
      stubClipboard(setup);

      const root = setup.renderer.root.getChildren()[0]!;
      const body = root.getChildren()[0]!;
      const before = body.getChildren().map((child) => `${child.width}x${child.height}`);

      const at = locate(first, "Select sources");
      await setup.mockMouse.drag(at.x, at.y, at.x + 5, at.y);
      await frameText(setup, (f) => f.includes("Copied"));

      const after = body.getChildren().map((child) => `${child.width}x${child.height}`);
      expect(after).toEqual(before);
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });
});

