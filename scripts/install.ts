/**
 * Installs the compiled updater-tui.exe into the user's local bin directory
 * (`$HOME/.local/bin`, falling back to `%USERPROFILE%\.local\bin`).
 *
 * Asks for confirmation before touching anything. Pass `--yes` to skip the
 * prompt (useful for scripted installs).
 *
 * Run: bun run scripts/install.ts [--yes]
 */
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const EXE = "updater-tui.exe";
const SOURCE = join(process.cwd(), "dist", EXE);
const ASSUME_YES = Bun.argv.includes("--yes") || Bun.argv.includes("-y");

function home(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? "";
}

function binDir(): string {
  return join(home(), ".local", "bin");
}

/** Whether `dir` is present in PATH (case-insensitive on Windows). */
function isOnPath(dir: string): boolean {
  const parts = (process.env.PATH ?? "").split(";").filter(Boolean);
  const normalise = (value: string): string =>
    value.replace(/[\\/]+$/, "").toLowerCase();
  return parts.some((part) => normalise(part) === normalise(dir));
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  // `--yes` means "don't ask" — never touch stdin.
  if (ASSUME_YES) return true;

  // With no interactive stdin (piped, redirected, or run from a service) there
  // is nobody to answer, so don't wait forever — make the caller use --yes.
  if (!process.stdin.isTTY) {
    console.error(
      "✖ Not an interactive terminal. Re-run with `--yes` to install without confirmation.",
    );
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (answer === "") return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * The Windows file version embedded in an exe (e.g. `1.0.0.0`), or undefined
 * when the file is missing or unreadable. Read from the artifact itself rather
 * than package.json, so it reflects what is actually being shipped.
 */
async function exeVersion(path: string): Promise<string | undefined> {
  if (!(await Bun.file(path).exists())) return undefined;
  const literal = path.replace(/'/g, "''");
  const proc = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Item -LiteralPath '${literal}').VersionInfo.FileVersion`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const text = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return text === "" ? undefined : text;
}

const source = Bun.file(SOURCE);
if (!(await source.exists())) {
  console.error(`✖ ${SOURCE} not found. Run \`bun run build:exe\` first.`);
  process.exit(1);
}

const dir = binDir();
const target = join(dir, EXE);

// Warn when the exe about to be installed carries the same version as the one
// already in place — the usual symptom of forgetting to bump `version` in
// package.json before shipping. The prompt then defaults to "no".
const incoming = await exeVersion(SOURCE);
const installed = await exeVersion(target);
const unchanged = incoming !== undefined && incoming === installed;

if (unchanged) {
  console.log(`⚠ Version unchanged: both exes report ${incoming}.`);
  console.log("  Bump `version` in package.json (then `bun run build:exe`) if this ships a change.");
} else if (incoming !== undefined) {
  console.log(`Version ${installed ?? "(not installed)"} → ${incoming}`);
}

const prompt = unchanged
  ? `Install anyway (same version ${incoming})? [y/N] `
  : `Install ${SOURCE} to ${target}? [Y/n] `;

if (!(await confirm(prompt, !unchanged))) {
  console.log("Cancelled.");
  process.exit(0);
}

await mkdir(dir, { recursive: true });

// Write to a temp name first, then rename. `rename` replaces an existing file
// atomically, which works when `updater-tui.exe` is closed. Only if that fails
// (the target is locked by a running process) fall back to removing it first —
// which fails loudly rather than leaving the exe half-overwritten.
const staging = `${target}.new`;
try {
  await copyFile(SOURCE, staging);
  try {
    await rename(staging, target);
  } catch {
    await rm(target, { force: true });
    await rename(staging, target);
  }
} catch (err) {
  await rm(staging, { force: true }).catch(() => {});
  console.error(`✖ Failed to install: ${err instanceof Error ? err.message : String(err)}`);
  console.error("  If updater-tui is running, close it and retry.");
  process.exit(1);
}

const sizeMB = (source.size / 1024 / 1024).toFixed(1);
console.log(`✔ Installed ${EXE} (${sizeMB} MB) to ${dir}`);

if (!isOnPath(dir)) {
  console.log(`\n⚠ ${dir} is not on your PATH. Add it to run \`updater-tui\` from anywhere.`);
}
