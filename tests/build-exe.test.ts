/**
 * Guards the build-script version mapping.
 *
 * The exe's Windows file version is derived from package.json's `version` so
 * there is a single source of truth; this locks the normalisation so a stray
 * prerelease tag or extra component can't produce a malformed value.
 */
import { expect, test } from "bun:test";
import pkg from "../package.json";
import { windowsVersion } from "../scripts/build-exe";

test("pads semver to four Windows components", () => {
  expect(windowsVersion("1.0.0")).toBe("1.0.0.0");
  expect(windowsVersion("1.2.3")).toBe("1.2.3.0");
  expect(windowsVersion("1.2.3.4")).toBe("1.2.3.4");
});

test("drops prerelease and build metadata", () => {
  expect(windowsVersion("2.1.0-beta.3")).toBe("2.1.0.0");
  expect(windowsVersion("2.1.0+build.7")).toBe("2.1.0.0");
});

test("trims extra components and clamps to 16 bits", () => {
  expect(windowsVersion("1.2.3.4.5")).toBe("1.2.3.4");
  expect(windowsVersion("70000.2.3")).toBe("65535.2.3.0");
});

test("the committed version maps to a plain a.b.c.d string", () => {
  expect(windowsVersion(pkg.version)).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
});
