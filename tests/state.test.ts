import { describe, expect, test } from "bun:test";
import type { UpgradeItem } from "../src/types";
import {
  applyScanResults,
  beginScan,
  clampIndex,
  defaultSelection,
  flatten,
  groupItems,
  initialFlow,
  isLocked,
  lockedHint,
  setAllItems,
  setAllSources,
  sourceRows,
  toggleItem,
  toggleSource,
  type FlowState,
} from "../src/state";

const item = (over: Partial<UpgradeItem> & { id: string }): UpgradeItem => ({
  source: "npm",
  name: over.id,
  current: "1.0.0",
  latest: "2.0.0",
  ...over,
});

const rows = [
  { id: "npm", title: "Global npm packages", available: true },
  { id: "winget", title: "winget", available: true },
  { id: "windows-update", title: "Windows Update", available: false },
];

describe("sourceRows", () => {
  test("marks availability from the map", () => {
    const sources = [
      { id: "npm", title: "npm", isAvailable: async () => true },
      { id: "winget", title: "winget", isAvailable: async () => false },
    ] as unknown as Parameters<typeof sourceRows>[0];
    const built = sourceRows(sources, new Map([["npm", true]]));
    expect(built).toEqual([
      { id: "npm", title: "npm", available: true },
      { id: "winget", title: "winget", available: false },
    ]);
  });
});

describe("initialFlow", () => {
  test("pre-checks every available source", () => {
    const flow = initialFlow(rows);
    expect([...flow.selectedSources]).toEqual(["npm", "winget"]);
    expect(flow.stage).toBe("sources");
    expect(flow.sourceCursor).toBe(0);
  });
});

describe("toggleSource", () => {
  test("toggles an available source", () => {
    const flow = toggleSource(initialFlow(rows), "npm");
    expect(flow.selectedSources.has("npm")).toBe(false);
  });

  test("ignores unavailable sources", () => {
    const flow = initialFlow(rows);
    expect(toggleSource(flow, "windows-update")).toBe(flow);
  });
});

describe("setAllSources", () => {
  test("selects only available sources", () => {
    const flow = setAllSources(initialFlow(rows), true);
    expect([...flow.selectedSources]).toEqual(["npm", "winget"]);
  });

  test("clears everything when false", () => {
    const flow = setAllSources(initialFlow(rows), false);
    expect(flow.selectedSources.size).toBe(0);
  });
});

describe("groupItems", () => {
  const upstream = [
    item({ id: "npm:a", source: "npm", name: "a" }),
    item({ id: "npm:b", source: "npm", name: "b", pinned: true }),
    item({ id: "winget:x", source: "winget", name: "x" }),
    item({ id: "windows-update:kb", source: "windows-update", name: "kb" }),
  ];

  test("keeps source order and drops unselected sources", () => {
    const groups = groupItems(upstream, rows, new Set(["npm", "winget"]));
    expect(groups.map((group) => group.sourceId)).toEqual(["npm", "winget"]);
    expect(groups[0]!.items).toHaveLength(2);
  });

  test("omits sources with no items", () => {
    const groups = groupItems(
      [item({ id: "winget:x", source: "winget" })],
      rows,
      new Set(["npm", "winget"]),
    );
    expect(groups.map((group) => group.sourceId)).toEqual(["winget"]);
  });
});

describe("selection defaults", () => {
  const groups = groupItems(
    [
      item({ id: "npm:a" }),
      item({ id: "npm:b", pinned: true }),
      item({ id: "npm:c", disabled: true }),
    ],
    rows,
    new Set(["npm"]),
  );

  test("defaultSelection excludes locked items", () => {
    expect([...defaultSelection(groups)]).toEqual(["npm:a"]);
  });

  test("flatten lists every id in display order", () => {
    expect(flatten(groups)).toEqual(["npm:a", "npm:b", "npm:c"]);
  });
});

describe("toggleItem", () => {
  const flow: FlowState = { ...initialFlow(rows), groups: groupItems(
    [item({ id: "npm:a" }), item({ id: "npm:b", pinned: true })],
    rows,
    new Set(["npm"]),
  ) };

  test("toggles an unlocked item", () => {
    const after = toggleItem(flow, "npm:a");
    expect(after.selectedItems.has("npm:a")).toBe(true);
    // And toggling again clears it.
    expect(toggleItem(after, "npm:a").selectedItems.has("npm:a")).toBe(false);
  });

  test("never selects a locked item", () => {
    const after = toggleItem(flow, "npm:b");
    expect(after.selectedItems.has("npm:b")).toBe(false);
  });

  test("ignores unknown ids", () => {
    expect(toggleItem(flow, "nope")).toBe(flow);
  });
});

describe("setAllItems", () => {
  const flow: FlowState = {
    ...initialFlow(rows),
    groups: groupItems(
      [item({ id: "npm:a" }), item({ id: "npm:b", pinned: true })],
      rows,
      new Set(["npm"]),
    ),
  };

  test("selects only unlocked items", () => {
    expect([...setAllItems(flow, true).selectedItems]).toEqual(["npm:a"]);
  });

  test("clears the selection", () => {
    expect(setAllItems(flow, false).selectedItems.size).toBe(0);
  });
});

describe("clampIndex", () => {
  test("clamps to the bounds", () => {
    expect(clampIndex(0, -1, 3)).toBe(0);
    expect(clampIndex(2, 1, 3)).toBe(2);
    expect(clampIndex(1, 1, 3)).toBe(2);
  });

  test("handles an empty list", () => {
    expect(clampIndex(0, 1, 0)).toBe(0);
    expect(clampIndex(5, -1, 0)).toBe(0);
  });
});

describe("scan transitions", () => {
  test("beginScan enters scanning", () => {
    const flow = beginScan(initialFlow(rows));
    expect(flow.stage).toBe("scanning");
    expect(flow.scanning).toBe(true);
  });

  test("applyScanResults installs groups, defaults and errors", () => {
    const scanning = beginScan(initialFlow(rows));
    const done = applyScanResults(
      scanning,
      [item({ id: "npm:a" }), item({ id: "npm:b", pinned: true })],
      ["winget: boom"],
    );
    expect(done.stage).toBe("packages");
    expect(done.scanning).toBe(false);
    expect(done.itemOrder).toEqual(["npm:a", "npm:b"]);
    expect([...done.selectedItems]).toEqual(["npm:a"]);
    expect(done.scanErrors).toEqual(["winget: boom"]);
    expect(done.itemCursor).toBe(0);
  });

  test("applyScanResults with no items still leaves the package stage", () => {
    const done = applyScanResults(beginScan(initialFlow(rows)), [], []);
    expect(done.stage).toBe("packages");
    expect(done.groups).toEqual([]);
  });
});

describe("labels and locking", () => {
  test("versionLabel prefers hint, then current → latest", () => {
    expect(lockedHint(item({ id: "x", hint: "KB1 · 2 GB" }))).toBe("KB1 · 2 GB");
    expect(lockedHint(item({ id: "x", current: "1.0.0", latest: "2.0.0" }))).toBe(
      "1.0.0 → 2.0.0",
    );
  });

  test("lockedHint annotates pinned and disabled", () => {
    expect(lockedHint(item({ id: "x", pinned: true }))).toContain("pinned");
    expect(lockedHint(item({ id: "x", disabled: true }))).toContain("not found");
  });

  test("isLocked covers pinned and disabled", () => {
    expect(isLocked(item({ id: "x", pinned: true }))).toBe(true);
    expect(isLocked(item({ id: "x", disabled: true }))).toBe(true);
    expect(isLocked(item({ id: "x" }))).toBe(false);
  });
});
