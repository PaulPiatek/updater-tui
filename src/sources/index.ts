import type { LoadedConfig } from "../config";
import type { Source } from "../types";
import { createCustomSource } from "./custom";
import { npmSource } from "./npm";
import { wingetSource } from "./winget";
import { windowsUpdateSource } from "./windows-update";

/**
 * The built-in sources that don't depend on the config. To add a new package
 * manager, implement `Source` and append it here — nothing else needs to change.
 */
export const builtinSources: Source[] = [
  npmSource,
  wingetSource,
  windowsUpdateSource,
];

/**
 * All sources for a run: the built-ins plus a `custom` source built from the
 * config's `scripts` (omitted when no scripts are configured).
 */
export function createSources(config: LoadedConfig): Source[] {
  if (config.scripts.length === 0) return builtinSources;
  return [...builtinSources, createCustomSource(config.scripts)];
}

export function findSource(
  sources: Source[],
  id: string,
): Source | undefined {
  return sources.find((source) => source.id === id);
}
