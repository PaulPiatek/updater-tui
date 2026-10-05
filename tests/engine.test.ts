import { describe, expect, mock, test } from "bun:test";
import type { Source, UpgradeItem } from "../src/types";

// The engine must never hit the real package managers in tests: proc is mocked
// so any accidental spawn is inert, and the sources below are hand-written.
mock.module("../src/proc", () => ({
  run: async () => ({ code: 0, stdout: "", stderr: "" }),
  which: (_command: string, fallback: string) => fallback,
}));

const { applyGroup, discover, groupBySource, scan } = await import("../src/engine");

const item = (over: Partial<UpgradeItem> & { id: string }): UpgradeItem => ({
  source: "fake",
  name: over.id,
  current: "1",
  latest: "2",
  ...over,
});

function fakeSource(over: Partial<Source> & { id: string }): Source {
  return {
    title: over.id,
    isAvailable: async () => true,
    list: async () => [],
    upgrade: async (entry) => ({ item: entry, ok: true, command: "noop" }),
    ...over,
  };
}

describe("applyGroup", () => {
  test("uses upgradeBatch when the source provides it", async () => {
    const calls: string[][] = [];
    const source = fakeSource({
      id: "batch",
      upgradeBatch: async (items) => {
        calls.push(items.map((entry) => entry.id));
        return items.map((entry) => ({ item: entry, ok: true, command: "batch" }));
      },
      upgrade: async () => {
        throw new Error("per-item upgrade should not run when batch exists");
      },
    });

    const results = await applyGroup(source, [item({ id: "a" }), item({ id: "b" })], true);
    expect(calls).toEqual([["a", "b"]]);
    expect(results).toHaveLength(2);
  });

  test("falls back to upgrade per item and reports each result", async () => {
    const seen: string[] = [];
    const source = fakeSource({
      id: "each",
      upgrade: async (entry) => {
        seen.push(entry.id);
        return { item: entry, ok: entry.id !== "b", command: "run", error: entry.id === "b" ? "boom" : undefined };
      },
    });

    const results = await applyGroup(
      source,
      [item({ id: "a" }), item({ id: "b" })],
      false,
      { onResult: (result) => void result },
    );
    expect(seen).toEqual(["a", "b"]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
  });
});

describe("groupBySource", () => {
  test("groups in discovery order and omits empty sources", () => {
    const engine = {
      config: { ignore: [], pin: [], scripts: [], files: [], errors: [], userPath: "", projectPath: null } as never,
      sources: [
        { source: fakeSource({ id: "a" }), available: true },
        { source: fakeSource({ id: "b" }), available: true },
      ],
    };
    const groups = groupBySource(engine, [
      item({ id: "b:1", source: "b" }),
      item({ id: "a:1", source: "a" }),
      item({ id: "a:2", source: "a" }),
    ]);
    expect(groups.map((group) => group.source.id)).toEqual(["a", "b"]);
    expect(groups[0]!.items.map((entry) => entry.id)).toEqual(["a:1", "a:2"]);
  });
});

describe("discover", () => {
  test("rejects an unknown --source filter", async () => {
    await expect(
      discover({ sourceFilter: ["does-not-exist"] }),
    ).rejects.toThrow(/Unknown source/);
  });
});

describe("scan", () => {
  test("collects items, applies ignore/pin, and reports scan errors", async () => {
    const good = fakeSource({
      id: "good",
      list: async () => [
        item({ id: "good:keep", source: "good" }),
        item({ id: "good:hide", source: "good", name: "hide-me" }),
      ],
    });
    const bad = fakeSource({
      id: "bad",
      list: async () => {
        throw new Error("exploded");
      },
    });

    const engine = {
      config: {
        ignore: ["hide-me"],
        pin: [],
        scripts: [],
        files: [],
        errors: [],
        userPath: "",
        projectPath: null,
      } as never,
      sources: [
        { source: good, available: true },
        { source: bad, available: true },
      ],
    };

    const errors: string[] = [];
    const result = await scan(engine, ["good", "bad"], {
      onScanError: (_source, detail) => errors.push(detail),
    });

    expect(result.items.map((entry) => entry.id)).toEqual(["good:keep"]);
    expect(result.ignored).toBe(1);
    expect(result.errors).toEqual(["bad: exploded"]);
    expect(errors).toEqual(["exploded"]);
  });

  test("marks pinned items and keeps them visible", async () => {
    const source = fakeSource({
      id: "s",
      list: async () => [
        item({ id: "s:a", source: "s" }),
        item({ id: "s:b", source: "s", name: "locked" }),
      ],
    });
    const engine = {
      config: {
        ignore: [],
        pin: ["locked"],
        scripts: [],
        files: [],
        errors: [],
        userPath: "",
        projectPath: null,
      } as never,
      sources: [{ source, available: true }],
    };

    const result = await scan(engine, ["s"]);
    expect(result.pinned).toBe(1);
    expect(result.items.find((entry) => entry.id === "s:b")?.pinned).toBe(true);
  });

  test("only scans the requested, available sources", async () => {
    const listed: string[] = [];
    const make = (id: string) =>
      fakeSource({
        id,
        list: async () => {
          listed.push(id);
          return [];
        },
      });
    const engine = {
      config: { ignore: [], pin: [], scripts: [], files: [], errors: [], userPath: "", projectPath: null } as never,
      sources: [
        { source: make("wanted"), available: true },
        { source: make("skipped"), available: true },
        { source: make("unavailable"), available: false },
      ],
    };

    await scan(engine, ["wanted", "unavailable"]);
    expect(listed).toEqual(["wanted"]);
  });
});
