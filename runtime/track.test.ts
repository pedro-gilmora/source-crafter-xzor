import { expect, test } from "bun:test";
import { changed, flush, QUEUED } from "./track";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** What the queue runs: a binding that is its own dep for bit 0. */
const binding = (run: () => void) => ({ flags: 0, mask: 1, stateHasChanged: run });

test("a binding that throws does not drop the ones queued after it; the error is reported", async () => {
  const seen: string[] = [];
  const bad = binding(() => {
    seen.push("bad");
    throw new Error("boom");
  });
  const good = binding(() => seen.push("good"));
  const errors: unknown[] = [];
  const onError = (e: unknown) => {
    errors.push((e as { error?: unknown }).error ?? e);
    (e as Event).preventDefault?.();
  };
  window.addEventListener("error", onError);
  process.on("uncaughtException", onError);
  try {
    changed(bad, 0);
    changed(good, 0);
    flush();
    expect(seen).toEqual(["bad", "good"]);
    expect(bad.flags & QUEUED).toBe(0);
    expect(good.flags & QUEUED).toBe(0);

    // Later changes still flush.
    changed(good, 0);
    flush();
    expect(seen).toEqual(["bad", "good", "good"]);
    await tick();
  } finally {
    window.removeEventListener("error", onError);
    process.off("uncaughtException", onError);
  }
  expect(errors.map(String)).toEqual(["Error: boom"]);
});
