import { describe, expect, mock, test } from "bun:test";
import type { Source, UpgradeItem, UpgradeResult } from "../src/types";

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
    const reported: string[] = [];
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
      { onResult: (result) => reported.push(result.item.id) },
    );
    expect(seen).toEqual(["a", "b"]);
    expect(reported).toEqual(["a", "b"]);
    expect(results.map((result) => result.ok)).toEqual([true, false]);
  });

  test("contains a throwing per-item upgrade as failed results", async () => {
    const source = fakeSource({
      id: "boom",
      upgrade: async () => {
        throw new Error("spawn failed");
      },
    });

    const seen: UpgradeResult[] = [];
    const results = await applyGroup(
      source,
      [item({ id: "a" }), item({ id: "b" })],
      false,
      { onResult: (result) => seen.push(result) },
    );

    // The throw must not escape: every item becomes a failure, and the
    // remaining items still run.
    expect(results.map((result) => result.ok)).toEqual([false, false]);
    expect(results[0]?.error).toBe("spawn failed");
    expect(results[0]?.command).toBe("boom");
    expect(seen).toHaveLength(2);
  });

  test("contains a throwing upgradeBatch as failed results", async () => {
    const source = fakeSource({
      id: "boombatch",
      upgradeBatch: async () => {
        throw new Error("batch exploded");
      },
    });

    const results = await applyGroup(source, [item({ id: "a" })], false);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, command: "boombatch", error: "batch exploded" });
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

  test("reports each source as it settles, not all at the end", async () => {
    // Regression: the UI fills status rows in live, so a fast source must be
    // reported while a slow one is still scanning.
    const done: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });

    const engine = {
      config: { ignore: [], pin: [], scripts: [], files: [], errors: [], userPath: "", projectPath: null } as never,
      sources: [
        {
          source: fakeSource({ id: "fast", list: async () => [item({ id: "fast:1", source: "fast" })] }),
          available: true,
        },
        {
          source: fakeSource({
            id: "slow",
            list: async () => {
              await slowGate;
              return [];
            },
          }),
          available: true,
        },
      ],
    };

    const scanning = scan(engine, ["fast", "slow"], {
      onScanDone: (source) => done.push(source.id),
    });

    // The fast source settles (and its onScanDone fires) before the slow one
    // is allowed to finish.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done).toEqual(["fast"]);

    releaseSlow();
    await scanning;
    expect(done).toEqual(["fast", "slow"]);
  });
});
