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

/**
 * What `store update "Store Experience Host" --apply` actually printed, captured
 * 2026-10-28. Exit code 0 — the CLI's exit code is not trustworthy.
 */
const NOT_A_PRODUCT_OUTPUT =
  "Looking up product…\r\n" +
  "Checking updates…\r\n" +
  "Checking updates for Store Experience Host…\r\n" +
  "\r\n" +
  "\u001b[38;5;196mError: Update check failed: net_http_message_not_success_statuscode_reason, 404,\u001b[0m\r\n" +
  "\u001b[38;5;196mNot Found\u001b[0m\r\n";

/** What `store updates --apply` prints: started, then silence (fire-and-forget). */
const STARTED_OUTPUT =
  "Checking for updates…\r\n" +
  "\r\n" +
  "── Updates started (1) ────────────────\r\n" +
  "\r\n" +
  "🔄 Started installation of 1 Store update(s)…\r\n";

/** A real `store updates --filter` listing for the store-managed component. */
const MANAGED_LISTING =
  "Checking for updates…\r\n" +
  "\r\n" +
  "── Updates available (1 found) ─────────────────────────────────────────────────\r\n" +
  "\r\n" +
  "Store-managed update available\r\n" +
  "This Store app update can be installed immediately.\r\n" +
  "┌───────────────────────┬───────────────────────┬────────────────┬────────────┐\r\n" +
  "│ Name                  │ Publisher             │ Version        │ Date       │\r\n" +
  "├───────────────────────┼───────────────────────┼────────────────┼────────────┤\r\n" +
  "│ Store Experience Host │ Microsoft Corporation │ 22608.1401.1.0 │ 2026-09-22 │\r\n" +
  "└───────────────────────┴───────────────────────┴────────────────┴────────────┘\r\n";

const NO_UPDATES_OUTPUT = "Checking for updates…\r\n\r\nNo updates found.\r\n";

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
  delete process.env.UPDATER_STORE_PROBE_RETRY_MS;
  delete process.env.UPDATER_STORE_TIMEOUT_MS;
  delete process.env.UPDATER_STORE_MANAGED_POLL_MS;
  delete process.env.UPDATER_STORE_MANAGED_TIMEOUT_MS;
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

// The Store self-update replaces the package that *contains* store.exe, so at
// the moment the --apply child exits the alias cannot be spawned at all:
// `EUNKNOWN: unknown error, uv_spawn`, 7 ms after exit — and, worse, that is
// exactly when the check is wanted. It works again seconds later, so the check
// must treat a failed spawn as "not yet" instead of as "still broken".
test("a check that cannot spawn is retried until the alias comes back", async () => {
  process.env.UPDATER_STORE_PROBE_RETRY_MS = "1";
  let probes = 0;
  respond = (cmd) => {
    if (cmd.includes("--apply")) return { code: 58, stdout: SELF_UPDATE_OUTPUT, stderr: "" };
    probes++;
    if (probes === 1) throw new Error("EUNKNOWN: unknown error, uv_spawn");
    return { code: 0, stdout: APPLIED, stderr: "" };
  };

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(probes).toBe(2);
  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
});

test("a spawn that keeps failing is bounded and still a failure", async () => {
  process.env.UPDATER_STORE_PROBE_RETRY_MS = "1";
  let probes = 0;
  respond = (cmd) => {
    if (cmd.includes("--apply")) return { code: 58, stdout: SELF_UPDATE_OUTPUT, stderr: "" };
    probes++;
    throw new Error("EUNKNOWN: unknown error, uv_spawn");
  };

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(probes).toBe(4);
  expect(result.ok).toBe(false);
});

test("a failure that is not a spawn failure is not retried", async () => {
  process.env.UPDATER_STORE_PROBE_RETRY_MS = "1";
  let probes = 0;
  respond = (cmd) => {
    if (cmd.includes("--apply")) return { code: 58, stdout: SELF_UPDATE_OUTPUT, stderr: "" };
    probes++;
    throw new Error("spawn failed");
  };

  const result = await storeSource.upgrade(STORE_ITEM, { dryRun: false });

  expect(probes).toBe(1);
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

// `Store Experience Host` (= Microsoft.StorePurchaseApp) is a component of the
// Store bundle, not a catalogue product: `store update <app> --apply` resolves
// the product and then fails the update check with HTTP 404 (exit 0). Only the
// store-managed bulk pipeline can install it, so that is the fallback — and it
// is fire-and-forget, so the re-listing is the verdict.
const MANAGED_ITEM = {
  id: "store:Store Experience Host",
  source: "store",
  name: "Store Experience Host",
  current: "22608.1401.1.0",
  latest: "update",
};

test("a store-managed component falls back to the filtered bulk pipeline", async () => {
  respond = (cmd) => {
    if (cmd.includes("--filter")) {
      return cmd.includes("--apply")
        ? { code: 0, stdout: STARTED_OUTPUT, stderr: "" }
        : { code: 0, stdout: NO_UPDATES_OUTPUT, stderr: "" };
    }
    return { code: 0, stdout: NOT_A_PRODUCT_OUTPUT, stderr: "" };
  };

  const result = await storeSource.upgrade(MANAGED_ITEM, { dryRun: false });

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.output).toContain("store-managed component");
  expect(result.output).toContain("no longer listed");
  expect(result.command).toBe('store updates --filter "Store Experience Host" --apply');
  // Per-app attempt first, then the filtered bulk apply, then the re-listing.
  expect(calls.map((call) => call.cmd.slice(1))).toEqual([
    ["update", "Store Experience Host", "--apply"],
    ["updates", "--filter", "Store Experience Host", "--apply"],
    ["updates", "--filter", "Store Experience Host"],
  ]);
});

test("the bulk fallback waits while the item is still listed", async () => {
  process.env.UPDATER_STORE_MANAGED_POLL_MS = "1";
  process.env.UPDATER_STORE_MANAGED_TIMEOUT_MS = "5000";
  let listings = 0;
  respond = (cmd) => {
    if (cmd.includes("--filter")) {
      if (cmd.includes("--apply")) return { code: 0, stdout: STARTED_OUTPUT, stderr: "" };
      listings++;
      return { code: 0, stdout: listings === 1 ? MANAGED_LISTING : NO_UPDATES_OUTPUT, stderr: "" };
    }
    return { code: 0, stdout: NOT_A_PRODUCT_OUTPUT, stderr: "" };
  };

  const result = await storeSource.upgrade(MANAGED_ITEM, { dryRun: false });

  expect(listings).toBe(2);
  expect(result.ok).toBe(true);
});

test("a store-managed item that never disappears is a bounded failure", async () => {
  process.env.UPDATER_STORE_MANAGED_POLL_MS = "1";
  process.env.UPDATER_STORE_MANAGED_TIMEOUT_MS = "40";
  respond = (cmd) =>
    cmd.includes("--filter")
      ? { code: 0, stdout: cmd.includes("--apply") ? STARTED_OUTPUT : MANAGED_LISTING, stderr: "" }
      : { code: 0, stdout: NOT_A_PRODUCT_OUTPUT, stderr: "" };

  const result = await storeSource.upgrade(MANAGED_ITEM, { dryRun: false });

  expect(result.ok).toBe(false);
  expect(result.error).toContain("store-managed component");
  expect(result.error).toContain("still listed");
});

test("an unrelated failure does not trigger the bulk fallback", async () => {
  respond = () => ({ code: 1, stdout: "❌ Error: something broke\r\n", stderr: "" });

  const result = await storeSource.upgrade(MANAGED_ITEM, { dryRun: false });

  expect(result.ok).toBe(false);
  expect(calls).toHaveLength(1);
});

