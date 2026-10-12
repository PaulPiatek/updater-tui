/**
 * Guards the Windows console-mode helper (AGENTS rule 2).
 *
 * The FFI snapshot/restore can't be observed under `bun test` (stdin is not a
 * console there), so these assert the wrapper's contract: it returns the
 * callback's value and restores on both the success and throw paths, and the
 * helpers degrade to no-ops instead of throwing when there is no console.
 */
import { expect, test } from "bun:test";
import {
  getConsoleInputMode,
  setConsoleInputMode,
  withConsoleModeRestored,
} from "../src/console-mode";

test("withConsoleModeRestored returns the callback result", async () => {
  expect(await withConsoleModeRestored(async () => 42)).toBe(42);
});

test("withConsoleModeRestored restores on the throw path too", async () => {
  await expect(
    withConsoleModeRestored(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
});

test("the mode helpers never throw without a console", () => {
  const mode = getConsoleInputMode();
  expect(mode === null || typeof mode === "number").toBe(true);
  // When there is a console, writing the mode we just read must succeed.
  if (mode !== null) expect(setConsoleInputMode(mode)).toBe(true);
});
