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
import {
  App,
  FINISH_BURST_MS,
  FINISH_REST_MS,
  activityPhrase,
  exitCodeFor,
  finishPhase,
  snakeText,
} from "../src/ui/app";
import { builtinSources } from "../src/sources";
import { bandRamp, colors } from "../src/ui/theme";

/** Builds a temp project with one custom script so discovery has something. */
async function project(exitCode = 0): Promise<{ cwd: string; dispose: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "updater-tui-app-"));
  const scriptPath = join(cwd, "fake.cmd");
  await writeFile(scriptPath, `@echo off\r\nexit /b ${exitCode}\r\n`);
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

/**
 * Renders and polls until `predicate` matches. Unlike `waitForFrame` this keeps
 * going for seconds, which an upgrade needs: a hosted script's overlay lingers
 * ~700 ms after the child exits before the app comes back.
 */
async function frameEventually(
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  predicate: (text: string) => boolean,
  tries = 60,
): Promise<string> {
  let text = setup.captureCharFrame();
  for (let i = 0; i < tries && !predicate(text); i++) {
    await Bun.sleep(100);
    await setup.renderOnce();
    text = setup.captureCharFrame();
  }
  return text;
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
        const text = await frame(setup, (f) => f.includes("Custom scripts"));
        expect(text).toContain("Custom scripts");

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

  test("`a` toggles the sources all on and all off", async () => {
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
      // Starts with the available source checked.
      await frame(setup, (text) => text.includes("[x] Custom scripts"));

      // `a` clears them.
      setup.mockInput.pressKey("a");
      let text = await frame(setup, (f) => f.includes("[ ] Custom scripts"));
      expect(text).toContain("[ ] Custom scripts");

      // `a` again selects them.
      setup.mockInput.pressKey("a");
      text = await frame(setup, (f) => f.includes("[x] Custom scripts"));
      expect(text).toContain("[x] Custom scripts");
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });
});

describe("exitCodeFor", () => {
  test("0 when nothing failed", () => {
    expect(exitCodeFor("Done: 3 upgraded, 0 failed.")).toBe(0);
    expect(exitCodeFor("Nothing to do 🎉")).toBe(0);
    expect(exitCodeFor("Nothing to do.")).toBe(0);
  });

  test("1 when any upgrade failed", () => {
    expect(exitCodeFor("Done: 2 upgraded, 1 failed.")).toBe(1);
  });

  test("0 for a successful dry run (would upgrade)", () => {
    expect(exitCodeFor("Done: 3 would upgrade, 0 failed.")).toBe(0);
    expect(exitCodeFor("Done: 0 would upgrade, 0 failed.")).toBe(0);
  });

  test("1 when a dry run reported failures", () => {
    expect(exitCodeFor("Done: 2 would upgrade, 1 failed.")).toBe(1);
  });

  test("1 for a failed start or scan, not just the word 'errors'", () => {
    expect(exitCodeFor("Cannot start.")).toBe(1);
    expect(exitCodeFor("Scan failed.")).toBe(1);
    expect(exitCodeFor("Finished with errors.")).toBe(1);
  });
});

describe("activityPhrase", () => {
  test("has a playful phrase for every source, in both phases", () => {
    const sources = [
      ...builtinSources.map((source) => ({ id: source.id, title: source.title })),
      // The custom source only exists when scripts are configured.
      { id: "custom", title: "Custom scripts" },
    ];

    for (const { id, title } of sources) {
      for (const phase of ["scan", "upgrade"] as const) {
        const phrase = activityPhrase(phase, id, title);
        // Anything equal to the fallback means the table is missing an entry.
        expect(phrase).not.toBe(`working on ${title.toLowerCase()}`);
        expect(phrase.length).toBeGreaterThan(0);
      }
    }
  });

  test("falls back to a plain label for an unknown source", () => {
    expect(activityPhrase("upgrade", "brew", "Homebrew")).toBe("working on homebrew");
  });
});

describe("snakeText", () => {
  const base = colors.accent;

  /** `[index, slot]` for every character not painted with the base colour. */
  function band(text: string, phase: number): Array<[number, number]> {
    return snakeText(text, phase, bandRamp, base)
      .chunks.map((chunk, index) => [index, chunk.fg?.slot ?? -1] as [number, number])
      .filter(([, slot]) => slot !== base.slot);
  }

  test("keeps every character, in order", () => {
    const styled = snakeText("Done: 4 upgraded.", 2, bandRamp, base);
    expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe("Done: 4 upgraded.");
  });

  test("uses the whole ramp, tail first, brightest last", () => {
    // The head (last ramp entry) leads the sweep.
    expect(band("abcdefg", 0)).toEqual(
      bandRamp.map((colour, index) => [index, colour.slot] as [number, number]),
    );
    expect(bandRamp.length).toBeGreaterThan(1);
  });

  test("moves one character per step", () => {
    expect(band("abcdefghij", 0).map(([index]) => index)).toEqual([0, 1, 2, 3]);
    expect(band("abcdefghij", 1).map(([index]) => index)).toEqual([1, 2, 3, 4]);
    expect(band("abcdefghij", 4).map(([index]) => index)).toEqual([4, 5, 6, 7]);
  });

  test("wraps around the end of the line", () => {
    // A 7-char line with a 4-char ramp: two steps from the end it splits.
    expect(band("abcdefg", 5).map(([index]) => index)).toEqual([0, 1, 5, 6]);
    expect(band("abcdefg", 6).map(([index]) => index)).toEqual([0, 1, 2, 6]);
    expect(band("abcdefg", 7).map(([index]) => index)).toEqual([0, 1, 2, 3]); // full cycle
  });

  test("paints nothing for empty text", () => {
    expect(snakeText("", 0, bandRamp, base).chunks).toHaveLength(0);
  });
});

describe("finishPhase", () => {
  test("bursts, then sweeps, then rests", () => {
    expect(finishPhase(0)).toBe("burst");
    expect(finishPhase(FINISH_BURST_MS - 1)).toBe("burst");
    expect(finishPhase(FINISH_BURST_MS)).toBe("snake");
    expect(finishPhase(FINISH_REST_MS - 1)).toBe("snake");
    expect(finishPhase(FINISH_REST_MS)).toBe("rest");
    expect(finishPhase(FINISH_REST_MS + 60_000)).toBe("rest");
  });

  test("the whole thing lasts 10 seconds", () => {
    expect(FINISH_REST_MS).toBe(10_000);
  });
});

describe("App status bar", () => {
  test("shows the dry-run marker while idle", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 120, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, {
        cwd: proj.cwd,
        sourceFilter: ["custom"],
        dryRun: true,
      });
      void app.run();

      const text = await frame(setup, (f) => f.includes("Custom scripts"));
      expect(text).toContain("DRY RUN");
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });

  test("keeps its content row inside the border on a short terminal", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 100, height: 12 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, {
        cwd: proj.cwd,
        sourceFilter: ["custom"],
        dryRun: false,
      });
      void app.run();
      await frame(setup, (f) => f.includes("Custom scripts"));

      const root = (app as unknown as { root: BoxRenderable }).root;
      const status = root.getChildren()[1] as BoxRenderable;
      // Regression: the bar shared the flex shortfall with the body, so it
      // shrank below its content height and drew its text over the bottom
      // border ("╰─↑/↓ move─…─╯") on a short terminal.
      expect(status.height).toBe(3);

      const lines = setup.captureCharFrame().split("\n");
      const content = (lines[status.y + 1] ?? "").trimEnd();
      expect(content.startsWith("│")).toBe(true);
      expect(content.endsWith("│")).toBe(true);
      expect(lines[status.y + 2]).toContain("╰");
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });

  test("a clean finish bursts, then sweeps until it rests", async () => {
    const proj = await project();
    const setup = await createTestRenderer({ width: 130, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, {
        cwd: proj.cwd,
        sourceFilter: ["custom"],
        dryRun: false,
      });
      void app.run();
      await frame(setup, (f) => f.includes("Custom scripts"));
      setup.mockInput.pressEnter(); // scan
      await frame(setup, (f) => f.includes("Packages"));
      setup.mockInput.pressEnter(); // upgrade

      const text = await frameEventually(setup, (f) => f.includes("Done: 1 upgraded"));
      expect(text).toContain("Done: 1 upgraded, 0 failed.");

      const internals = app as unknown as {
        spinner: { content: { chunks: Array<{ text: string }> } };
        statusText: { content: { chunks: Array<{ fg?: { slot: number } }> } };
        workTimer: unknown;
      };
      const mark = (): string =>
        internals.spinner.content.chunks.map((chunk) => chunk.text).join("");

      // First the sparkle burst: a spinning mark next to the summary.
      let burst = "";
      for (let i = 0; i < 12 && burst.trim() === ""; i++) {
        burst = mark();
        await Bun.sleep(60);
      }
      expect(burst.trim()).not.toBe("");
      expect(internals.workTimer).not.toBeNull();

      // Once the burst is over, the summary carries the whole ramp sweeping
      // over its accent base.
      await Bun.sleep(1600);
      const slots = new Set<number>();
      for (let i = 0; i < 4; i++) {
        for (const chunk of internals.statusText.content.chunks) {
          if (chunk.fg) slots.add(chunk.fg.slot);
        }
        await Bun.sleep(90);
      }
      const expected = [
        ...bandRamp.map((colour) => colour.slot),
        colors.accent.slot,
      ].sort((a, b) => a - b);
      expect([...slots].sort((a, b) => a - b)).toEqual(expected);
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });

  test("a failed finish stays static", async () => {
    const proj = await project(3);
    const setup = await createTestRenderer({ width: 130, height: 30 });
    let app: App | undefined;
    try {
      app = new App(setup.renderer, {
        cwd: proj.cwd,
        sourceFilter: ["custom"],
        dryRun: false,
      });
      void app.run();
      await frame(setup, (f) => f.includes("Custom scripts"));
      setup.mockInput.pressEnter(); // scan
      await frame(setup, (f) => f.includes("Packages"));
      setup.mockInput.pressEnter(); // upgrade

      const text = await frameEventually(setup, (f) => f.includes("Done: 0 upgraded"));
      expect(text).toContain("Done: 0 upgraded, 1 failed.");

      // No celebration for a failure: the tick is stopped.
      const internals = app as unknown as { workTimer: unknown };
      expect(internals.workTimer).toBeNull();
    } finally {
      app?.destroy();
      setup.renderer.destroy();
      await proj.dispose();
    }
  });
});
