import { expect, test } from "bun:test";
import { parseWingetUpgrade } from "../src/sources/winget";

// Real `winget upgrade` output captured on Windows, including a row whose
// Version cell ("< 173.1.0.13333") is wider than the "Version" header token.
const SAMPLE = [
  "Name                    Id                     Version         Available     Source",
  "-----------------------------------------------------------------------------------",
  "Rockstar Games Launcher RockstarGames.Launcher 1.0.108.2970    1.0.109.3031  winget",
  "Ubisoft Connect         Ubisoft.Connect        < 173.1.0.13333 173.1.0.13333 winget",
  "2 upgrades available.",
  "3 package(s) have version numbers that cannot be determined. Use --include-unknown to see all results.",
  "",
].join("\r\n");

test("parses winget's fixed-width upgrade table", () => {
  const items = parseWingetUpgrade(SAMPLE);

  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({
    id: "winget:RockstarGames.Launcher",
    source: "winget",
    name: "Rockstar Games Launcher",
    current: "1.0.108.2970",
    latest: "1.0.109.3031",
  });
  expect(items[1]).toMatchObject({
    id: "winget:Ubisoft.Connect",
    name: "Ubisoft Connect",
    current: "< 173.1.0.13333",
    latest: "173.1.0.13333",
  });
  expect(items[0]?.meta?.packageSource).toBe("winget");
});

test("ignores the trailing footer lines", () => {
  const items = parseWingetUpgrade(SAMPLE);
  expect(items.some((item) => item.name.includes("available"))).toBe(false);
  expect(items.some((item) => item.name.includes("package(s)"))).toBe(false);
});

test("returns nothing when there is no table", () => {
  expect(parseWingetUpgrade("No installed package found matching input criteria.")).toEqual([]);
  expect(parseWingetUpgrade("")).toEqual([]);
});
