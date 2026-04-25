import type { Notifier, NotifyProgressInput } from "@conclave-ai/core";

/**
 * v0.11 — fan a progress stage out to every notifier that opted in to
 * `notifyProgress`. Failures here are NEVER fatal: progress is
 * telemetry, and a 429 / network blip MUST NOT kill a review. We log
 * each failure to stderr (so a CI run still has a paper trail) and
 * continue.
 *
 * Why: this is called from the review/autofix happy path, often from
 * inside a try block that already has a verdict. Throwing here would
 * either lose the verdict (caller doesn't catch) or quietly suppress a
 * real bug (caller catches everything). Centralising the swallow here
 * makes the policy obvious from one place.
 */
export async function emitProgress(
  notifiers: Notifier[],
  input: NotifyProgressInput,
): Promise<void> {
  if (notifiers.length === 0) return;
  await Promise.all(
    notifiers.map(async (n) => {
      const fn = n.notifyProgress;
      if (typeof fn !== "function") return;
      try {
        await fn.call(n, input);
      } catch (err) {
        process.stderr.write(
          `conclave progress: ${n.id} notifyProgress failed — ${(err as Error).message}\n`,
        );
      }
    }),
  );
}
