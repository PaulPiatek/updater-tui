/**
 * Shared test helper: wait for a frame in *real time*.
 *
 * OpenTUI 0.8's test renderer stops pumping as soon as its scheduler is idle
 * (`waitForFrame` bails after a few milliseconds, and its `isRunning` is false
 * for a test renderer). The app's progress, though, comes from async children —
 * a spawned package manager, an elevated batch — and from the renderer's
 * animation clock, neither of which is a pending render. So the tests poll:
 * render, look, sleep, repeat, until the deadline.
 */
import type { createTestRenderer } from "@opentui/core/testing";

export type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

/** Renders until `predicate` matches and returns that frame; throws on timeout. */
export async function frameText(
  setup: Setup,
  predicate: (frame: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms; last frame:\n${frame}`);
    }
    await Bun.sleep(50);
  }
}
