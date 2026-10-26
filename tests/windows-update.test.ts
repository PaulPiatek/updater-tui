import { expect, test } from "bun:test";
import {
  buildInstallScript,
  formatSize,
  parseInstallResults,
  parseListMarker,
  parseWindowsUpdates,
} from "../src/sources/windows-update";

// One line per update, exactly as LIST_SCRIPT emits them.
const DEFENDER_LINE = JSON.stringify({
  UpdateID: "9a788d9c-f355-44e0-b62a-e341c3c0e7bc",
  Title:
    "Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.459.378.0) - Current Channel (Broad)",
  KB: "2267602",
  Severity: null,
  SizeMB: 1578.7,
  Downloaded: false,
  RebootBehavior: 0,
});

test("parses a Windows Update JSON-lines record", () => {
  const items = parseWindowsUpdates(DEFENDER_LINE);

  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    id: "windows-update:9a788d9c-f355-44e0-b62a-e341c3c0e7bc",
    source: "windows-update",
    current: "not installed",
    latest: "KB2267602",
    hint: "KB2267602 · 1.5 GB",
  });
  expect(items[0]?.meta?.kb).toEqual(["2267602"]);
});

test("parses multiple updates and multiple KB ids", () => {
  const lines = [
    DEFENDER_LINE,
    JSON.stringify({
      UpdateID: "11111111-2222-3333-4444-555555555555",
      Title: "Cumulative Update",
      KB: "5034441,5034442",
      Severity: "Critical",
      SizeMB: 800,
    }),
  ].join("\r\n");

  const items = parseWindowsUpdates(lines);
  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ latest: "KB5034441", hint: "KB5034441 · KB5034442 · 800 MB" });
  expect(items[1]?.meta?.severity).toBe("Critical");
});

test("ignores stray non-JSON lines and empty input", () => {
  expect(parseWindowsUpdates("")).toEqual([]);
  expect(parseWindowsUpdates("WARNING: something noisy\n")).toEqual([]);
});

/** The summary line LIST_SCRIPT appends after the update records. */
const marker = (count: number): string =>
  JSON.stringify({ __list: "windows-update", count });

test("the summary marker is not mistaken for an update", () => {
  const items = parseWindowsUpdates(`${DEFENDER_LINE}\n${marker(1)}\n`);
  expect(items.map((item) => item.name)).toHaveLength(1);
  expect(items[0]!.id).toContain("9a788d9c");
});

test("reads the summary marker, including a zero count", () => {
  // The distinction that matters: 0 means "the search ran and found nothing",
  // null means "the search printed no summary at all".
  expect(parseListMarker(marker(0))).toBe(0);
  expect(parseListMarker(marker(3))).toBe(3);
  expect(parseListMarker(`${DEFENDER_LINE}\n${marker(1)}`)).toBe(1);
  // ConvertTo-Json wraps a one-element collection in an array.
  expect(parseListMarker(`[${marker(2)}]`)).toBe(2);
  // Missing, unreadable, or a bare update record: no marker.
  expect(parseListMarker("")).toBeNull();
  expect(parseListMarker(DEFENDER_LINE)).toBeNull();
  expect(parseListMarker("WARNING: noisy\n{not json}\n")).toBeNull();
  expect(parseListMarker('{"__list":"windows-update","count":"many"}')).toBeNull();
});

test("omits the hint when there is no KB or size", () => {
  const line = JSON.stringify({ UpdateID: "abc", Title: "Mystery update", SizeMB: 0 });
  const items = parseWindowsUpdates(line);
  expect(items[0]?.hint).toBeUndefined();
  expect(items[0]?.latest).toBe("update");
});

test("parses a single JSON array (ConvertTo-Json for many items)", () => {
  const array = JSON.stringify([
    { UpdateID: "a", Title: "One", KB: "111", SizeMB: 10 },
    { UpdateID: "b", Title: "Two", KB: "222", SizeMB: 20 },
  ]);
  const items = parseWindowsUpdates(array);
  expect(items.map((item) => item.id)).toEqual(["windows-update:a", "windows-update:b"]);
});

test("formatSize rounds sensibly", () => {
  expect(formatSize(512)).toBe("512 MB");
  expect(formatSize(2048)).toBe("2.0 GB");
  expect(formatSize(0)).toBe("");
  expect(formatSize(Number.NaN)).toBe("");
  // A sub-half-MB update must not collapse to "0 MB".
  expect(formatSize(0.4)).toBe("1 MB");
});

test("parseInstallResults handles arrays, single objects and junk", () => {
  const array = JSON.stringify([
    { UpdateID: "a", ResultCode: 2, RebootRequired: false },
    { UpdateID: "b", ResultCode: 4, Message: "boom" },
  ]);
  expect(parseInstallResults(array)).toHaveLength(2);
  expect(parseInstallResults(array)[1]?.Message).toBe("boom");

  const single = JSON.stringify({ UpdateID: "a", ResultCode: 2 });
  expect(parseInstallResults(single)).toHaveLength(1);

  expect(parseInstallResults("")).toEqual([]);
  expect(parseInstallResults("not json")).toEqual([]);
});

test("buildInstallScript embeds and escapes update ids", () => {
  const script = buildInstallScript(["a'b", "plain-id"], "C:\\out.json");
  expect(script).toContain("$ids = @('a''b', 'plain-id')");
  expect(script).toContain("$out = 'C:\\out.json'");
  expect(script).toContain("Microsoft.Update.UpdateColl");
  expect(script).toContain("WriteAllText");
});
