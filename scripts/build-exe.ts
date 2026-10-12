#!/usr/bin/env bun
/**
 * Compiles `dist/updater-tui.exe`.
 *
 * The Windows file/product version the exe carries is read from package.json —
 * the same field `--version` prints — so the two can never drift. Bump
 * `version` in package.json before shipping; `install:exe` warns if you forget.
 *
 * Run: bun run build:exe
 */
import pkg from "../package.json";

/** Windows versions are `a.b.c.d` with 16-bit components; pad/trim/normalise. */
export function windowsVersion(version: string): string {
  const release = (version.split("-")[0] ?? "").split("+")[0] ?? "";
  const parts = release
    .split(".")
    .slice(0, 4)
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) && n > 0 ? String(Math.min(n, 0xffff)) : "0";
    });
  while (parts.length < 4) parts.push("0");
  return parts.join(".");
}

const args = [
  "bun",
  "build",
  "--compile",
  "--target=bun-windows-x64",
  "--outfile=dist/updater-tui.exe",
  "--windows-icon=assets/icon.ico",
  "--windows-title=updater-tui",
  "--windows-publisher=Paul",
  `--windows-version=${windowsVersion(pkg.version)}`,
  "--windows-description=Interactive updater (TUI) for npm, winget, Windows Update and custom scripts",
  "./src/index.ts",
];

if (import.meta.main) {
  console.log(`Building dist/updater-tui.exe (version ${pkg.version})…`);
  const proc = Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}
