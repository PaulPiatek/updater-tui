import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCustomSource } from "../src/sources/custom";
import type { ResolvedScript } from "../src/config";

const created: string[] = [];

/** Builds a ResolvedScript with `target` defaulted like `resolveScript` does. */
function script(
  partial: Omit<ResolvedScript, "target"> & { target?: string },
): ResolvedScript {
  return {
    ...partial,
    target: partial.target ?? partial.interpreter ?? partial.path,
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "updater-custom-"));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("isAvailable is false with no scripts and true with scripts", async () => {
  expect(await createCustomSource([]).isAvailable()).toBe(false);
  expect(
    await createCustomSource([
      script({ name: "x", path: "C:\\nope\\x.exe", cwd: "C:\\nope", args: [] }),
    ]).isAvailable(),
  ).toBe(true);
});

test("lists one item per script and marks missing executables disabled", async () => {
  const dir = await tempDir();
  const present = join(dir, "present.cmd");
  await writeFile(present, "@echo off\n");

  const items = await createCustomSource([
    script({ name: "present", path: present, cwd: dir, args: [] }),
    script({ name: "missing", path: join(dir, "missing.cmd"), cwd: dir, args: [] }),
  ]).list();

  expect(items.map((item) => item.id)).toEqual(["custom:present", "custom:missing"]);
  expect(items[0]).toMatchObject({
    source: "custom",
    name: "present",
    current: "script",
    latest: "run",
    hint: present,
  });
  expect(items[0]?.disabled).toBe(false);
  expect(items[1]?.disabled).toBe(true);
});

test("a script is disabled when its interpreter is missing", async () => {
  const dir = await tempDir();
  const present = join(dir, "present.py");
  await writeFile(present, "print('hi')\n");

  const items = await createCustomSource([
    script({
      name: "present",
      path: present,
      cwd: dir,
      args: [],
      interpreter: join(dir, "no-python.exe"),
    }),
  ]).list();

  expect(items[0]?.disabled).toBe(true);
});

test("dry-run reports the command and working directory without running", async () => {
  const dir = await tempDir();
  const present = join(dir, "present.cmd");
  await writeFile(present, "@echo off\n");

  const source = createCustomSource([
    script({ name: "present", path: present, cwd: dir, args: ["--check", "two words"] }),
  ]);
  const [item] = await source.list();

  const result = await source.upgrade(item!, { dryRun: true });
  expect(result.ok).toBe(true);
  expect(result.command).toContain(present);
  expect(result.command).toContain("--check");
  expect(result.command).toContain(`in ${dir}`);
});

test("dry-run shows the interpreter when one is configured", async () => {
  const dir = await tempDir();
  const py = join(dir, "script.py");
  await writeFile(py, "print('hi')\n");

  const source = createCustomSource([
    script({
      name: "py",
      path: py,
      cwd: dir,
      args: ["--fast"],
      interpreter: "python.exe",
    }),
  ]);
  const [item] = await source.list();

  const result = await source.upgrade(item!, { dryRun: true });
  expect(result.command).toContain("python.exe");
  expect(result.command).toContain(py);
  expect(result.command).toContain("--fast");
});

test("upgrade runs the executable and reports success", async () => {
  const dir = await tempDir();
  const path = join(dir, "run.cmd");
  await writeFile(path, "@echo off\nexit /b 0\n");

  const source = createCustomSource([
    script({ name: "run", path, cwd: dir, args: [] }),
  ]);
  const [item] = await source.list();

  const result = await source.upgrade(item!, { dryRun: false });
  expect(result.ok).toBe(true);
  expect(result.command).toContain(path);
});

test("upgrade reports a non-zero exit as a failure", async () => {
  const dir = await tempDir();
  const path = join(dir, "fail.cmd");
  await writeFile(path, "@echo off\nexit /b 3\n");

  const source = createCustomSource([
    script({ name: "fail", path, cwd: dir, args: [] }),
  ]);
  const [item] = await source.list();

  const result = await source.upgrade(item!, { dryRun: false });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("exit code 3");
});

test("hostProcess is used instead of spawning directly when supplied", async () => {
  const dir = await tempDir();
  const path = join(dir, "hosted.cmd");
  await writeFile(path, "@echo off\nexit /b 0\n");

  const source = createCustomSource([
    script({ name: "hosted", path, cwd: dir, args: ["--go"] }),
  ]);
  const [item] = await source.list();

  const calls: Array<{ argv: string[]; cwd?: string; title?: string }> = [];
  const result = await source.upgrade(item!, {
    dryRun: false,
    hostProcess: async (argv, options) => {
      calls.push({ argv, cwd: options.cwd, title: options.title });
      return 0;
    },
  });

  // The source still owns the argv; the app only decides how to show it.
  expect(calls).toHaveLength(1);
  expect(calls[0]?.argv).toEqual([path, "--go"]);
  expect(calls[0]?.cwd).toBe(dir);
  expect(calls[0]?.title).toBe("hosted");
  expect(result.ok).toBe(true);
});

test("a non-zero hostProcess exit is reported as a failure", async () => {
  const dir = await tempDir();
  const path = join(dir, "hosted.cmd");
  await writeFile(path, "@echo off\nexit /b 0\n");

  const source = createCustomSource([
    script({ name: "hosted", path, cwd: dir, args: [] }),
  ]);
  const [item] = await source.list();

  const result = await source.upgrade(item!, {
    dryRun: false,
    hostProcess: async () => 7,
  });

  expect(result.ok).toBe(false);
  expect(result.error).toContain("exit code 7");
});
