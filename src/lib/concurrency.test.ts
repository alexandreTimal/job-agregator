import { test } from "node:test";
import assert from "node:assert/strict";
import { pLimit, withTimeout, TimeoutError } from "./concurrency";

test("pLimit : jamais plus de n tâches en vol", async () => {
  const limit = pLimit(2);
  let inFlight = 0;
  let maxInFlight = 0;
  const task = () =>
    limit(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
    });
  await Promise.all([task(), task(), task(), task(), task()]);
  assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight}`);
});

test("pLimit : renvoie les résultats dans l'ordre des appels", async () => {
  const limit = pLimit(2);
  const out = await Promise.all([1, 2, 3].map((n) => limit(async () => n * 10)));
  assert.deepEqual(out, [10, 20, 30]);
});

test("withTimeout : résout si la promesse termine à temps", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 50), "ok");
});

test("withTimeout : rejette avec TimeoutError au-delà du délai", async () => {
  await assert.rejects(
    () => withTimeout(new Promise((r) => setTimeout(() => r("tard"), 50)), 10),
    TimeoutError,
  );
});
