import type { Source, UpgradeItem, UpgradeOptions, UpgradeResult } from "../types";
import { run, which } from "../proc";

const WINGET = which("winget", "winget.exe");

const isSeparator = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.length > 3 && /^-+$/.test(trimmed);
};

/**
 * Parses the fixed-width table printed by `winget upgrade`.
 *
 * Winget (as of v1.x) has no JSON output, so we read the table:
 *
 *   Name                    Id                     Version         Available     Source
 *   -----------------------------------------------------------------------------------
 *   Rockstar Games Launcher RockstarGames.Launcher 1.0.108.2970    1.0.109.3031  winget
 *
 * Every table line is padded to exactly the header width and the header is
 * rendered with the same column widths as the data, so slicing data rows at the
 * header's token offsets is reliable. Exported for unit testing.
 */
export function parseWingetUpgrade(stdout: string): UpgradeItem[] {
  const lines = stdout.split(/\r?\n/);

  // Find the header: a line containing Id/Available followed by a dashes line.
  const headerIndex = lines.findIndex(
    (line, i) =>
      line.includes("Id") &&
      line.includes("Available") &&
      isSeparator(lines[i + 1] ?? ""),
  );
  if (headerIndex === -1) return [];

  const header = lines[headerIndex]!;
  const width = header.length;

  const tokens = [...header.matchAll(/\S+/g)];
  const starts = tokens.map((match) => match.index);
  const columnIndex = new Map(tokens.map((match, i) => [match[0], i]));

  const cellAt = (line: string, name: string): string => {
    const i = columnIndex.get(name);
    if (i === undefined) return "";
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : line.length;
    return line.slice(start, end).trim();
  };

  const items: UpgradeItem[] = [];

  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;

    if (isSeparator(line)) continue;
    // All rows are padded to the table width; anything else ends the table.
    if (line.length !== width) break;

    const id = cellAt(line, "Id");
    const available = cellAt(line, "Available");
    if (!id || !available) continue;

    const name = cellAt(line, "Name") || id;
    const current = cellAt(line, "Version") || "unknown";
    const sourceName = cellAt(line, "Source") || undefined;

    items.push({
      id: `winget:${id}`,
      source: "winget",
      name,
      current,
      latest: available,
      meta: { wingetId: id, packageSource: sourceName },
    });
  }

  return items;
}

function quote(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/** Upgrades packages installed through the Windows Package Manager. */
export const wingetSource: Source = {
  id: "winget",
  title: "Windows Package Manager (winget)",

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    if (!Bun.which("winget")) return false;
    try {
      const res = await run([WINGET, "--version"]);
      return res.code === 0;
    } catch {
      return false;
    }
  },

  async list(): Promise<UpgradeItem[]> {
    const res = await run([
      WINGET,
      "upgrade",
      "--disable-interactivity",
      "--accept-source-agreements",
    ]);

    const items = parseWingetUpgrade(res.stdout);
    if (items.length === 0 && res.code !== 0) {
      throw new Error(res.stderr.trim() || `winget upgrade exited with code ${res.code}`);
    }
    return items;
  },

  async upgrade(item, opts: UpgradeOptions): Promise<UpgradeResult> {
    const wingetId = (item.meta?.wingetId as string | undefined) ?? item.name;
    const packageSource = item.meta?.packageSource as string | undefined;

    const args = [
      WINGET,
      "upgrade",
      "--id",
      wingetId,
      "--exact",
      "--include-unknown",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
      "--silent",
    ];
    if (packageSource) args.push("--source", packageSource);

    const command = ["winget", ...args.slice(1)].map(quote).join(" ");

    if (opts.dryRun) {
      return { item, ok: true, command };
    }

    const res = await run(args);
    const output = `${res.stdout}${res.stderr}`.trim();

    return {
      item,
      ok: res.code === 0,
      command,
      output,
      error:
        res.code === 0
          ? undefined
          : res.stderr.trim() || output || `exit code ${res.code}`,
    };
  },
};
