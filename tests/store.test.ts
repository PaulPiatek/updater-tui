import { describe, expect, test } from "bun:test";
import { parseStoreUpdates, stripAnsi } from "../src/sources/store";

const B = "\u001b[38;5;238m"; // border
const H = "\u001b[38;5;189m"; // header / emphasis
const D = "\u001b[38;5;8m"; // dim
const Z = "\u001b[0m";

/**
 * REAL `store updates` output, captured from StoreCLI v22608.1401.5.0 with one
 * pending update. Note the shape: it is `store installed`'s table (Name /
 * Publisher / Version / Date — no target version), followed by an interactive
 * install prompt that fails under a pipe. This is the fixture the parser is
 * built against.
 */
const REAL_UPDATES_SAMPLE =
  "Checking for updates…\r\n" +
  "\r\n" +
  `${D}── ${Z}\u001b[38;5;69mUpdates available (1 found)${Z}${D} ─────────────────────────────────────────────────${Z}\r\n` +
  "\r\n" +
  `${H}Store-managed update available${Z}\r\n` +
  `${D}This Store app update can be installed immediately.${Z}\r\n` +
  `${B}┌──────────────────┬───────────────────────┬──────────────┬────────────┐${Z}\r\n` +
  `${B}│${Z} ${H}Name${Z}             ${B}│${Z} ${H}Publisher${Z}             ${B}│${Z} ${H}Version${Z}      ${B}│${Z} ${H}Date${Z}       ${B}│${Z}\r\n` +
  `${B}├──────────────────┼───────────────────────┼──────────────┼────────────┤${Z}\r\n` +
  `${B}│${Z} Windows Terminal ${B}│${Z} Microsoft Corporation ${B}│${Z} 1.24.11321.0 ${B}│${Z} 2026-10-01 ${B}│${Z}\r\n` +
  `${B}└──────────────────┴───────────────────────┴──────────────┴────────────┘${Z}\r\n` +
  "\r\n" +
  `Would you like to install the 1 Store update(s) now? \u001b[38;5;12m[y/n]${Z} \u001b[38;5;2m(y)${Z}: \r\n` +
  `${D}Failed to read input in non-interactive mode.${Z}\r\n`;

/**
 * REAL `store installed` output, trimmed to two apps. It proves the renderer's
 * wrapped-cell layout: "Microsoft Corporation" wraps onto a second physical
 * line. Kept because `updates` and `installed` share the renderer.
 */
const INSTALLED_SAMPLE =
  `${B}┌──────────────────────┬─────────────────────┬────────────────────┬────────────┐${Z}\r\n` +
  `${B}│${Z} ${H}Name${Z}                 ${B}│${Z} ${H}Publisher${Z}           ${B}│${Z} ${H}Version${Z}            ${B}│${Z} ${H}Date${Z}       ${B}│${Z}\r\n` +
  `${B}├──────────────────────┼─────────────────────┼────────────────────┼────────────┤${Z}\r\n` +
  `${B}│${Z} App Installer        ${B}│${Z} Microsoft           ${B}│${Z} 1.29.380.0         ${B}│${Z} 2026-09-18 ${B}│${Z}\r\n` +
  `${B}│${Z}                      ${B}│${Z} Corporation         ${B}│${Z}                    ${B}│${Z}            ${B}│${Z}\r\n` +
  `${B}│${Z} Spotify              ${B}│${Z} Spotify AB          ${B}│${Z} 1.2.3              ${B}│${Z} 2026-01-01 ${B}│${Z}\r\n` +
  `${B}└──────────────────────┴─────────────────────┴────────────────────┴────────────┘${Z}`;

/** Builds one `│ a │ b │ c │` line in the StoreCLI's coloured style. */
const cells = (...values: string[]): string =>
  `${B}│${Z} ${values.join(` ${B}│${Z} `)} ${B}│${Z}`;

const headerRow = (...names: string[]): string =>
  `${B}┌────┐${Z}\r\n` +
  names.map((name) => `${B}│${Z} ${H}${name}${Z}`).join(" ") +
  `\r\n${B}├────┤${Z}`;

describe("stripAnsi", () => {
  test("removes SGR sequences", () => {
    expect(stripAnsi("\u001b[38;5;8mNo updates found.\u001b[0m")).toBe("No updates found.");
  });
});

describe("parseStoreUpdates", () => {
  test("parses the real captured output, ignoring the install prompt", () => {
    const items = parseStoreUpdates(REAL_UPDATES_SAMPLE);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "store:Windows Terminal",
      source: "store",
      name: "Windows Terminal",
      current: "1.24.11321.0",
      // There is no target-version column in the table.
      latest: "update",
    });
  });

  test("parses the real captured table shape (ANSI + wrapped publisher)", () => {
    const items = parseStoreUpdates(INSTALLED_SAMPLE);

    expect(items.map((item) => item.name)).toEqual(["App Installer", "Spotify"]);
    expect(items[0]?.current).toBe("1.29.380.0");
    expect(items[0]?.latest).toBe("update");
  });

  test("joins a wrapped name across physical lines", () => {
    const sample =
      `${headerRow("Name", "Publisher", "Version")}\r\n` +
      `${cells("English (United", "Microsoft", "10.0.1")}\r\n` +
      `${cells("Kingdom) Pack", "Corporation", "")}\r\n`;
    const [item] = parseStoreUpdates(sample);
    expect(item?.name).toBe("English (United Kingdom) Pack");
    expect(item?.current).toBe("10.0.1");
  });

  test("handles more than one table", () => {
    const sample =
      `${headerRow("Name", "Version")}\r\n` +
      `${cells("One", "1.0")}\r\n` +
      `${headerRow("Name", "Version")}\r\n` +
      `${cells("Two", "2.0")}\r\n`;
    expect(parseStoreUpdates(sample).map((item) => item.name)).toEqual(["One", "Two"]);
  });

  test("uses an available column as latest when present", () => {
    const sample =
      `${headerRow("Name", "Version", "Available")}\r\n` +
      `${cells("Spotify", "1.2.3", "1.2.4")}\r\n`;
    expect(parseStoreUpdates(sample)[0]).toMatchObject({ current: "1.2.3", latest: "1.2.4" });
  });

  test("skips up-to-date rows if the list ever includes them", () => {
    const sample =
      `${headerRow("Name", "State")}\r\n` +
      `${cells("Calculator", "Up to date")}\r\n` +
      `${cells("Photos", "Update available")}\r\n`;
    expect(parseStoreUpdates(sample).map((item) => item.name)).toEqual(["Photos"]);
  });

  test("prefers a product id column for the upgrade key", () => {
    const sample =
      `${headerRow("Name", "Id", "Available")}\r\n` +
      `${cells("Visual Studio Code", "9NCBCSZSJRSB", "1.2.4")}\r\n`;
    const [item] = parseStoreUpdates(sample);
    expect(item?.meta?.storeId).toBe("9NCBCSZSJRSB");
  });

  test("returns nothing for an empty list or a no-table document", () => {
    expect(parseStoreUpdates("Checking for updates…\r\n\r\nNo updates found.")).toEqual([]);
    expect(parseStoreUpdates("")).toEqual([]);
  });
});
