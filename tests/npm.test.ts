import { beforeEach, expect, mock, test } from "bun:test";
import type { RunResult } from "../src/proc";

let runResult: RunResult = { code: 0, stdout: "", stderr: "" };

mock.module("../src/proc", () => ({
  run: async (): Promise<RunResult> => runResult,
  which: () => "npm",
}));

const { npmSource } = await import("../src/sources/npm");

beforeEach(() => {
  runResult = { code: 0, stdout: "", stderr: "" };
});

test("maps `npm outdated -g --json` output to upgrade items", async () => {
  runResult = {
    code: 1, // npm exits 1 when outdated packages exist
    stdout: JSON.stringify({
      "is-odd": {
        current: "3.0.0",
        wanted: "3.0.1",
        latest: "3.0.1",
        location: "C:\\globals\\node_modules\\is-odd",
      },
    }),
    stderr: "",
  };

  const items = await npmSource.list();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    id: "npm:is-odd",
    source: "npm",
    name: "is-odd",
    current: "3.0.0",
    latest: "3.0.1",
  });
});

test("returns nothing when the registry has no output", async () => {
  runResult = { code: 0, stdout: "", stderr: "" };
  expect(await npmSource.list()).toEqual([]);
});

test("falls back to `wanted` when `latest` is missing", async () => {
  runResult = {
    code: 1,
    stdout: JSON.stringify({ pkg: { current: "1.0.0", wanted: "1.2.0" } }),
    stderr: "",
  };
  const items = await npmSource.list();
  expect(items[0]?.latest).toBe("1.2.0");
});

test("surfaces a real error from npm", async () => {
  runResult = { code: 2, stdout: "", stderr: "network down" };
  await expect(npmSource.list()).rejects.toThrow("network down");
});

test("dry-run reports the command without executing it", async () => {
  const item = {
    id: "npm:is-odd",
    source: "npm",
    name: "is-odd",
    current: "3.0.0",
    latest: "3.0.1",
  };
  const result = await npmSource.upgrade(item, { dryRun: true });
  expect(result.ok).toBe(true);
  expect(result.command).toBe("npm install -g is-odd@latest");
});
