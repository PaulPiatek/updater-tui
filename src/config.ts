import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { UpgradeItem } from "./types";

/** A custom executable the user wants to run as part of an update. */
export interface CustomScript {
  /** Shown in the picker; falls back to the executable's file name. */
  name?: string;
  /** Path to the executable / script. May be relative to the config file. */
  path: string;
  /**
   * Interpreter to run `path` with, e.g. a Python or PowerShell executable.
   * When set the command becomes `<interpreter> <path> <args>`. Use this for
   * script types Windows can't execute directly (e.g. `.py` with no file
   * association).
   */
  interpreter?: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /**
   * Working directory to start it in. Defaults to the directory the executable
   * lives in, so scripts run "where they reside".
   */
  cwd?: string;
}

/** Rules loaded from config files. */
export interface UpdaterConfig {
  /** Patterns that hide an item from the list entirely. */
  ignore: string[];
  /** Patterns that keep an item visible but locked (not upgradable). */
  pin: string[];
  /** Custom executables exposed as the `custom` source. */
  scripts: CustomScript[];
}

export interface LoadedConfig extends UpdaterConfig {
  /** Paths that existed and were loaded (lowest precedence first). */
  files: string[];
  /** Human-readable problems (missing files are not errors). */
  errors: string[];
  /** The user config path that is created on first run if missing. */
  userPath: string;
  /** The project config path, if one exists in the working directory. */
  projectPath: string | null;
  /**
   * Scripts with `path`/`cwd` resolved to absolute paths. The `scripts` field
   * inherited from `UpdaterConfig` holds the raw config entries.
   */
  scripts: ResolvedScript[];
}

/** A custom script with absolute paths, ready to run. */
export interface ResolvedScript {
  name: string;
  path: string;
  cwd: string;
  args: string[];
  /** Interpreter executable with its path resolved, if one was configured. */
  interpreter?: string;
  /** The first element of the command to spawn (interpreter or script path). */
  target: string;
}

/** A config file may specify either or both keys. */
type PartialConfig = Partial<UpdaterConfig>;

/**
 * Locates the config files.
 *
 * The user config is `$USER/.config/updater/config.json` (falling back to
 * `%APPDATA%/updater` when there is no home directory). A project-local
 * `updater.config.json` in the working directory overrides it per key.
 */
export function configPaths(cwd: string): { user: string; project: string } {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  const user = home
    ? join(home, ".config", "updater", "config.json")
    : join(process.env.APPDATA ?? ".", "updater", "config.json");

  return { user, project: join(cwd, "updater.config.json") };
}

/** The config written on first run. */
export function defaultConfigText(): string {
  return `${JSON.stringify({ ignore: [], pin: [], scripts: [] }, null, 2)}\n`;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Normalizes the `scripts` array, dropping entries without a usable path. */
function asScripts(value: unknown): CustomScript[] {
  if (!Array.isArray(value)) return [];
  const scripts: CustomScript[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      // Shorthand: just a path.
      if (entry.trim()) scripts.push({ path: entry });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : "";
    if (!path.trim()) continue;

    const script: CustomScript = { path };
    if (typeof record.name === "string" && record.name.trim()) script.name = record.name;
    if (typeof record.cwd === "string" && record.cwd.trim()) script.cwd = record.cwd;
    if (typeof record.interpreter === "string" && record.interpreter.trim()) {
      script.interpreter = record.interpreter;
    }
    if (Array.isArray(record.args)) script.args = asStringArray(record.args);
    scripts.push(script);
  }
  return scripts;
}

/** Resolves a script path/cwd relative to the config file that declared it. */
export function resolveScript(
  script: CustomScript,
  configDir: string,
): ResolvedScript {
  const isAbsolute = (value: string): boolean =>
    /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");

  const absPath = isAbsolute(script.path) ? script.path : join(configDir, script.path);
  const cwd = script.cwd
    ? isAbsolute(script.cwd)
      ? script.cwd
      : join(configDir, script.cwd)
    : dirname(absPath);
  const name = script.name ?? basename(absPath);

  const interpreter = script.interpreter
    ? isAbsolute(script.interpreter)
      ? script.interpreter
      : join(configDir, script.interpreter)
    : undefined;

  return {
    path: absPath,
    cwd,
    name,
    args: script.args ?? [],
    interpreter,
    // With an interpreter the command is `<interpreter> <script> <args>`;
    // otherwise the script itself is the executable.
    target: interpreter ?? absPath,
  };
}

async function readConfigFile(
  path: string,
): Promise<{ config: PartialConfig | null; error?: string }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { config: null };

  try {
    const parsed = JSON.parse(await file.text()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { config: null, error: `${path}: expected a JSON object` };
    }
    const record = parsed as Record<string, unknown>;
    const config: PartialConfig = {};
    if ("ignore" in record) config.ignore = asStringArray(record.ignore);
    if ("pin" in record) config.pin = asStringArray(record.pin);
    if ("scripts" in record) config.scripts = asScripts(record.scripts);
    return { config };
  } catch (err) {
    return { config: null, error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Loads the user config and then the project config, with the project values
 * overriding the user values per key. Exported separately so tests don't depend
 * on the machine's real config files.
 */
export async function loadConfigFiles(paths: { user: string; project: string }): Promise<LoadedConfig> {
  const userRead = await readConfigFile(paths.user);
  const projectRead = await readConfigFile(paths.project);

  const files: string[] = [];
  const errors: string[] = [];
  if (userRead.config) files.push(paths.user);
  if (projectRead.config) files.push(paths.project);
  if (userRead.error) errors.push(userRead.error);
  if (projectRead.error) errors.push(projectRead.error);

  const scripts = projectRead.config?.scripts ?? userRead.config?.scripts ?? [];
  const scriptsDir = projectRead.config ? dirname(paths.project) : dirname(paths.user);

  return {
    ignore: projectRead.config?.ignore ?? userRead.config?.ignore ?? [],
    pin: projectRead.config?.pin ?? userRead.config?.pin ?? [],
    scripts: scripts.map((script) => resolveScript(script, scriptsDir)),
    files,
    errors,
    userPath: paths.user,
    projectPath: projectRead.config ? paths.project : null,
  };
}

/**
 * Loads config for the given working directory, creating the user config file
 * (with empty lists) the first time it is missing.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<LoadedConfig> {
  const paths = configPaths(cwd);

  if (!(await Bun.file(paths.user).exists())) {
    try {
      await mkdir(dirname(paths.user), { recursive: true });
      await Bun.write(paths.user, defaultConfigText());
    } catch {
      // A read-only home is fine — we just run without a config file.
    }
  }

  return loadConfigFiles(paths);
}

const regexCache = new Map<string, RegExp>();

/**
 * Converts a rule pattern to a regex. `*` matches any characters **including**
 * `/` (so `npm:*` and `@types/*` behave as expected) and `?` matches one
 * character. Matching is case-insensitive.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${escaped}$`, "i");
  regexCache.set(pattern, regex);
  return regex;
}

/**
 * Whether a rule matches an item.
 *
 * A rule is `[source:]pattern`, e.g. `npm:@types/*`, `winget:Ubisoft.Connect`,
 * `npm:*` or just `@opencode/*`. A bare pattern also matches the source id, so
 * `"npm"` hides every npm package.
 */
export function matchesRule(entry: string, item: UpgradeItem): boolean {
  const colon = entry.indexOf(":");
  const sourcePattern = colon === -1 ? null : entry.slice(0, colon);
  const namePattern = colon === -1 ? entry : entry.slice(colon + 1);

  if (sourcePattern !== null && !globToRegExp(sourcePattern).test(item.source)) {
    return false;
  }

  if (namePattern === "") return true;

  const regex = globToRegExp(namePattern);
  if (regex.test(item.name) || regex.test(item.id)) return true;
  // Bare pattern that names a source ("npm") means "everything in that source".
  return sourcePattern === null && regex.test(item.source);
}

export interface ConfigApplication {
  /** Items to show, with `pinned` set where applicable. */
  kept: UpgradeItem[];
  ignored: number;
  pinned: number;
}

/** Splits items into visible (optionally pinned) and ignored. Ignore wins. */
export function applyConfig(items: UpgradeItem[], config: UpdaterConfig): ConfigApplication {
  const kept: UpgradeItem[] = [];
  let ignored = 0;
  let pinned = 0;

  for (const item of items) {
    if (config.ignore.some((entry) => matchesRule(entry, item))) {
      ignored++;
      continue;
    }
    if (config.pin.some((entry) => matchesRule(entry, item))) {
      pinned++;
      kept.push({ ...item, pinned: true });
      continue;
    }
    kept.push(item);
  }

  return { kept, ignored, pinned };
}
