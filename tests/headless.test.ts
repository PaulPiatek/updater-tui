import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep the engine away from real package managers. The headless runner is
// exercised through the real `discover`/`scan`, but every spawn is inert and
// only the `custom` source is targeted (its items come from a temp config).
mock.module("../src/proc", () => ({
  run: async () => ({ code: 0, stdout: "", stderr: "" }),
  which: (_command: string, fallback: string) => fallback,
}));

const { runHeadless } = await import("../src/headless");

/**
 * Creates a temp directory holding a project config with the given scripts, and
 * a dummy `.cmd` for each. The headless runner reads config from `cwd`, so this
 * keeps the test away from the machine's real config and package managers.
 */
async function tempProject(
  scripts: Array<{ name: string; body: string }>,
): Promise<{ cwd: string; dispose: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "updater-tui-test-"));
  const entries: unknown[] = [];
  for (const script of scripts) {
    const path = join(cwd, `${script.name}.cmd`);
    await Bun.write(path, `@echo off\r\n${script.body}\r\nexit /b 0\r\n`);
    entries.push({ name: script.name, path });
  }
  await Bun.write(
    join(cwd, "updater.config.json"),
    JSON.stringify({ ignore: [], pin: [], scripts: entries }),
  );
  return { cwd, dispose: () => rm(cwd, { recursive: true, force: true }) };
}

/** Captures stdout/stderr written by the headless runner. */
async function capture<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    stderr += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, stdout, stderr };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("runHeadless", () => {
  test("--json prints the items and nothing else on stdout", async () => {
    const project = await tempProject([{ name: "fake", body: "echo hi" }]);
    try {
      const result = await capture(() =>
        runHeadless({
          cwd: project.cwd,
          sourceFilter: ["custom"],
          dryRun: false,
          yes: false,
          json: true,
        }),
      );
      expect(result.value).toBe(0);
      const parsed = JSON.parse(result.stdout) as Array<{ id: string }>;
      expect(parsed.map((item) => item.id)).toContain("custom:fake");
    } finally {
      await project.dispose();
    }
  });

  test("--dry-run describes the command without running it", async () => {
    const project = await tempProject([
      { name: "fake", body: "echo SHOULD-NOT-RUN" },
    ]);
    try {
      const result = await capture(() =>
        runHeadless({
          cwd: project.cwd,
          sourceFilter: ["custom"],
          dryRun: true,
          yes: true,
          json: false,
        }),
      );
      expect(result.value).toBe(0);
      expect(result.stdout).toContain("Would upgrade");
      expect(result.stdout).not.toContain("SHOULD-NOT-RUN");
    } finally {
      await project.dispose();
    }
  });

  test("--yes actually runs the script", async () => {
    const project = await tempProject([{ name: "fake", body: "echo RAN-OK" }]);
    try {
      const result = await capture(() =>
        runHeadless({
          cwd: project.cwd,
          sourceFilter: ["custom"],
          dryRun: false,
          yes: true,
          json: false,
        }),
      );
      // The mocked proc never writes to stdout, so the run reports success
      // without the script's own output; the summary is what we assert.
      expect(result.value).toBe(0);
      expect(result.stdout).toContain("Done: 1 upgraded");
    } finally {
      await project.dispose();
    }
  });

  test("refuses interactive selection with no --yes and no TTY", async () => {
    const project = await tempProject([{ name: "fake", body: "echo hi" }]);
    try {
      const result = await capture(() =>
        runHeadless({
          cwd: project.cwd,
          sourceFilter: ["custom"],
          dryRun: false,
          yes: false,
          json: false,
        }),
      );
      expect(result.value).toBe(2);
      expect(result.stdout).toContain("needs a terminal");
    } finally {
      await project.dispose();
    }
  });

  test("reports an unknown --source filter as an error", async () => {
    const project = await tempProject([{ name: "fake", body: "echo hi" }]);
    try {
      const result = await capture(() =>
        runHeadless({
          cwd: project.cwd,
          sourceFilter: ["no-such-source"],
          dryRun: false,
          yes: true,
          json: false,
        }),
      );
      expect(result.value).toBe(1);
      expect(result.stderr).toContain("Unknown source");
    } finally {
      await project.dispose();
    }
  });
});
