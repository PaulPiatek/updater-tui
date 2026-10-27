import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { RunResult } from "../src/proc";

/**
 * `store update … --apply` does not report success reliably:
 *
 * - for the Store itself, `store.exe` lives inside the package it replaces, so
 *   the run stops at `Installing: 95%` and exits 1 with no marker;
 * - for an app the deployment is handed to the Windows Update pipeline, so the
 *   CLI prints `Starting: 0%` and keeps doing so *after the update installed*
 *   (measured: package registered 26 s in, CLI still at 0 % six minutes later).
 *
 * Both are answered the same way: the check-only `store update <id>` is the
 * oracle. These tests pin that flow with the real captured output shapes.
 */

/** The shape of the check when the item is done. */
const APPLIED = "\u2705 'Microsoft Store' is already up to date\r\n";
/** The shape of the check when the item is still pending (no stdin → no input). */
const PENDING =
  "\ud83d\udd04 Update available for 'Microsoft Store'\r\n\r\n" +
  "Would you like to apply the update? [y/n] (y): \r\n" +
  "Failed to read input in non-interactive mode.\r\n";

/** A `--apply` run that never comes back, as the Xbox app update behaved. */
const neverSettles = (): Promise<RunResult> => new Promise<RunResult>(() => {});

type Call = { cmd: string[] };

let calls: Call[] = [];
let respond: (cmd: string[]) => RunResult | Promise<RunResult> = () => ({
  code: 0,
  stdout: "",
  stderr: "",
});

mock.module("../src/proc", () => ({
  run: async (cmd: string[]): Promise<RunResult> => {
    calls.push({ cmd });
    return respond(cmd);
  },
  which: () => "store.exe",
}));

const { storeSource } = await import("../src/sources/store");

const STORE_ITEM = {
  id: "store:Microsoft Store",
  source: "store",
  name: "Microsoft Store",
  current: "22608.1401.7.0",
  latest: "update",
};

/** What the Store self-update actually printed before exiting 1. */
const SELF_UPDATE_OUTPUT =
  "Looking up product…\r\n" +
  "Checking updates…\r\n" +
  "Checking updates for Microsoft Store…\r\n" +
  "\r\n" +
  "\u001b[38;5;12mDownloading\u001b[0m: 5%\r\n" +
  "\u001b[38;5;12mDownloading\u001b[0m: 32%\r\n" +
  "\u001b[38;5;12mInstalling\u001b[0m: 95%\r\n";

beforeEach(() => {
  calls = [];
  respond = () => ({ code: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  delete process.env.UPDATER_STORE_PROBE_MS;
  delete process.env.UPDATER_STORE_PROBE_EVERY_MS;
  delete process.env.UPDATER_STORE_PROBE_TIMEOUT_MS;
  delete process.env.UPDATER_STORE_TIMEOUT_MS;
});

test("a Store self-update that exits 1 is verified as success", async () => {
  respond = (cmd) =>
    cmd.includes("--apply")
      ? { code: 1, stdout: SELF_UPDATE_OUTPUT, stderr: "" }
      : { code: 0, stdout: "✅ 'Microsoft Store' is already up to date\r\n", stderr: "" };

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.output).toContain("already up to date");
  // The confirm is a check: it must not ask for `--apply`.
  // (The program path comes from `which`, which other test files may resolve
  // for real, so only the arguments are asserted.)
  expect(calls.map((call) => call.cmd.slice(1))).toEqual([
    ["update", "Microsoft Store", "--apply"],
    ["update", "Microsoft Store"],
  ]);
});

test("an ambiguous failure that is still pending stays a failure", async () => {
  respond = (cmd) =>
    cmd.includes("--apply")
      ? { code: 1, stdout: SELF_UPDATE_OUTPUT, stderr: "" }
      : {
          code: 0,
          stdout:
            "🔄 Update available for 'Microsoft Store'\r\n\r\n" +
            "Would you like to apply the update? [y/n] (y): \r\n" +
            "Failed to read input in non-interactive mode.\r\n",
          stderr: "",
        };

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
});

test("keeps the original failure when the confirm cannot be read", async () => {
  respond = (cmd) => {
    if (cmd.includes("--apply")) return { code: 1, stdout: SELF_UPDATE_OUTPUT, stderr: "" };
    throw new Error("spawn failed");
  };

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });
  expect(result.ok).toBe(false);
});

test("an explicit success marker needs no confirmation", async () => {
  respond = () => ({ code: 0, stdout: "✅ Installed Windows Terminal\r\n", stderr: "" });

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(1);
});

test("an explicit error marker is not treated as ambiguous", async () => {
  respond = () => ({ code: 1, stdout: "❌ Error: something broke\r\n", stderr: "" });

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(result.ok).toBe(false);
  expect(calls).toHaveLength(1);
});

test("dry-run does not spawn anything", async () => {
  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: true });

  expect(result.ok).toBe(true);
  expect(result.command).toBe('store update "Microsoft Store" --apply');
  expect(calls).toHaveLength(0);
});

test("a CLI that never exits is resolved by the in-flight check", async () => {
  // The Xbox app update: `Starting: 0%` forever, while the package had already
  // registered. The watch probe is what ends the wait.
  process.env.UPDATER_STORE_PROBE_MS = "10";
  process.env.UPDATER_STORE_PROBE_EVERY_MS = "10";
  respond = (cmd) => (cmd.includes("--apply") ? neverSettles() : { code: 0, stdout: APPLIED, stderr: "" });

  const started = performance.now();
  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.output).toContain("already up to date");
  expect(result.output).toContain("still showing progress");
  // The run ended because of the check, not because the child returned.
  expect(performance.now() - started).toBeLessThan(5_000);
  expect(calls.map((call) => call.cmd.slice(1))).toEqual([
    ["update", "Microsoft Store", "--apply"],
    ["update", "Microsoft Store"],
  ]);
});

test("a CLI that never exits and a pending item times out", async () => {
  process.env.UPDATER_STORE_PROBE_MS = "5";
  process.env.UPDATER_STORE_PROBE_EVERY_MS = "5";
  process.env.UPDATER_STORE_TIMEOUT_MS = "60";
  respond = (cmd) => (cmd.includes("--apply") ? neverSettles() : { code: 0, stdout: PENDING, stderr: "" });

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(result.ok).toBe(false);
  expect(result.error).toContain("timed out");
  expect(result.error).toContain("still pending");
});

test("the timeout backstop still reports success if the check says it landed", async () => {
  process.env.UPDATER_STORE_PROBE_MS = "5";
  process.env.UPDATER_STORE_PROBE_EVERY_MS = "5";
  process.env.UPDATER_STORE_TIMEOUT_MS = "40";
  const deadline = Date.now() + 40;
  respond = (cmd) => {
    if (cmd.includes("--apply")) return neverSettles();
    // Pending for the whole run, done by the time the backstop asks.
    return { code: 0, stdout: Date.now() < deadline ? PENDING : APPLIED, stderr: "" };
  };

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(result.ok).toBe(true);
  expect(result.output).toContain("stopped after");
});

test("a fast exit never probes (no extra process per upgrade)", async () => {
  respond = () => ({ code: 0, stdout: "✅ 'Microsoft Store' installed\r\n", stderr: "" });

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(result.ok).toBe(true);
  expect(calls).toHaveLength(1);
});
