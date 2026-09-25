import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyConfig,
  loadConfigFiles,
  matchesRule,
} from "../src/config";
import type { UpgradeItem } from "../src/types";

const npmItem = (name: string): UpgradeItem => ({
  id: `npm:${name}`,
  source: "npm",
  name,
  current: "1.0.0",
  latest: "2.0.0",
});

const wingetItem = (id: string): UpgradeItem => ({
  id: `winget:${id}`,
  source: "winget",
  name: id,
  current: "1.0.0",
  latest: "2.0.0",
});

test("source-prefixed patterns only match that source", () => {
  expect(matchesRule("npm:@types/*", npmItem("@types/node"))).toBe(true);
  expect(matchesRule("npm:@types/*", wingetItem("@types/node"))).toBe(false);
});

test("bare patterns match the package name on any source", () => {
  expect(matchesRule("@types/*", npmItem("@types/node"))).toBe(true);
  expect(matchesRule("@opencode/cli", npmItem("@opencode/cli"))).toBe(true);
  expect(matchesRule("@opencode/cli", npmItem("@opencode/other"))).toBe(false);
});

test("a bare source id matches everything in that source", () => {
  expect(matchesRule("npm", npmItem("@types/node"))).toBe(true);
  expect(matchesRule("npm", wingetItem("Ubisoft.Connect"))).toBe(false);
});

test("source:* matches every package in the source, including scoped ones", () => {
  expect(matchesRule("npm:*", npmItem("@types/node"))).toBe(true);
  expect(matchesRule("npm:*", wingetItem("Ubisoft.Connect"))).toBe(false);
});

test("matching is case-insensitive and supports ?", () => {
  expect(matchesRule("winget:ubisoft.connect", wingetItem("Ubisoft.Connect"))).toBe(true);
  expect(matchesRule("npm:foo?ar", npmItem("foobar"))).toBe(true);
});

test("applyConfig ignores, pins, and lets ignore win over pin", () => {
  const items = [
    npmItem("keep-me"),
    npmItem("ignore-me"),
    npmItem("pin-me"),
    npmItem("both"),
  ];
  const { kept, ignored, pinned } = applyConfig(items, {
    ignore: ["npm:ignore-me", "npm:both"],
    pin: ["npm:pin-me", "npm:both"],
    scripts: [],
  });

  expect(ignored).toBe(2);
  expect(pinned).toBe(1);
  expect(kept.map((item) => item.name)).toEqual(["keep-me", "pin-me"]);
  expect(kept.find((item) => item.name === "pin-me")?.pinned).toBe(true);
  expect(kept.find((item) => item.name === "keep-me")?.pinned).toBeUndefined();
});

// --- file loading -----------------------------------------------------------

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "updater-cfg-"));
  created.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

test("loads user config and lets the project override per key", async () => {
  const dir = await tempDir();
  const user = join(dir, "user.json");
  const project = join(dir, "project.json");

  await writeFile(user, JSON.stringify({ ignore: ["npm:a"], pin: ["npm:b"] }));
  await writeFile(project, JSON.stringify({ ignore: ["npm:c"] }));

  const config = await loadConfigFiles({ user, project });
  expect(config.ignore).toEqual(["npm:c"]); // project overrides
  expect(config.pin).toEqual(["npm:b"]); // falls back to user
  expect(config.files).toEqual([user, project]);
  expect(config.errors).toEqual([]);
});

test("missing files are fine and reported as no errors", async () => {
  const dir = await tempDir();
  const user = join(dir, "nope.json");
  const project = join(dir, "also-nope.json");
  const config = await loadConfigFiles({ user, project });

  expect(config.ignore).toEqual([]);
  expect(config.pin).toEqual([]);
  expect(config.files).toEqual([]);
  expect(config.errors).toEqual([]);
  expect(config.userPath).toBe(user);
  expect(config.projectPath).toBeNull();
});

test("scripts are parsed, shorthand strings allowed, and paths resolved", async () => {
  const dir = await tempDir();
  const user = join(dir, "config.json");
  await writeFile(
    user,
    JSON.stringify({
      scripts: [
        {
          name: "update-all",
          path: "scripts\\update-all.cmd",
          args: ["--yes"],
        },
        { path: "C:\\absolute\\tool.exe" },
        "scripts\\plain.ps1",
        {
          name: "py",
          path: "scripts\\update.py",
          interpreter: "C:\\Python\\python.exe",
        },
        { name: "no-path" },
      ],
    }),
  );

  const config = await loadConfigFiles({ user, project: join(dir, "x.json") });

  expect(config.scripts).toHaveLength(4);
  expect(config.scripts[0]).toEqual({
    name: "update-all",
    path: join(dir, "scripts\\update-all.cmd"),
    cwd: join(dir, "scripts"), // defaults to the executable's directory
    args: ["--yes"],
    interpreter: undefined,
    target: join(dir, "scripts\\update-all.cmd"),
  });
  expect(config.scripts[1]).toEqual({
    name: "tool.exe",
    path: "C:\\absolute\\tool.exe",
    cwd: "C:\\absolute",
    args: [],
    interpreter: undefined,
    target: "C:\\absolute\\tool.exe",
  });
  expect(config.scripts[2]?.name).toBe("plain.ps1");
  // With an interpreter, the command starts with the interpreter.
  expect(config.scripts[3]?.interpreter).toBe("C:\\Python\\python.exe");
  expect(config.scripts[3]?.target).toBe("C:\\Python\\python.exe");
  expect(config.scripts[3]?.path).toBe(join(dir, "scripts\\update.py"));
});

test("a missing scripts key yields an empty list", async () => {
  const dir = await tempDir();
  const user = join(dir, "config.json");
  await writeFile(user, JSON.stringify({ ignore: [], pin: [] }));
  const config = await loadConfigFiles({ user, project: join(dir, "x.json") });
  expect(config.scripts).toEqual([]);
});

test("invalid JSON is reported as an error without throwing", async () => {
  const dir = await tempDir();
  const user = join(dir, "broken.json");
  await writeFile(user, "{ not valid json");

  const config = await loadConfigFiles({ user, project: join(dir, "none.json") });
  expect(config.errors).toHaveLength(1);
  expect(config.errors[0]).toContain("broken.json");
  expect(config.ignore).toEqual([]);
});
