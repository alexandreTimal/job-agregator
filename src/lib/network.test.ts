import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForConnectivity } from "./network";

test("retourne true dès la première sonde réussie (aucune attente)", async () => {
  let probes = 0;
  let sleeps = 0;
  const ok = await waitForConnectivity({
    attempts: 5,
    probe: async () => {
      probes++;
      return true;
    },
    sleep: async () => {
      sleeps++;
    },
  });
  assert.equal(ok, true);
  assert.equal(probes, 1);
  assert.equal(sleeps, 0);
});

test("réessaie jusqu'au premier succès de la sonde", async () => {
  let probes = 0;
  const ok = await waitForConnectivity({
    attempts: 10,
    probe: async () => {
      probes++;
      return probes >= 3;
    },
    sleep: async () => {},
  });
  assert.equal(ok, true);
  assert.equal(probes, 3);
});

test("retourne false après épuisement des tentatives", async () => {
  let probes = 0;
  const ok = await waitForConnectivity({
    attempts: 4,
    probe: async () => {
      probes++;
      return false;
    },
    sleep: async () => {},
  });
  assert.equal(ok, false);
  assert.equal(probes, 4);
});

test("n'attend pas après la dernière tentative échouée", async () => {
  let sleeps = 0;
  await waitForConnectivity({
    attempts: 3,
    probe: async () => false,
    sleep: async () => {
      sleeps++;
    },
  });
  // 3 tentatives → au plus 2 attentes intercalaires.
  assert.equal(sleeps, 2);
});

test("une sonde qui lève est traitée comme un échec, pas une exception", async () => {
  let probes = 0;
  const ok = await waitForConnectivity({
    attempts: 3,
    probe: async () => {
      probes++;
      if (probes < 2) throw new Error("EAI_AGAIN");
      return true;
    },
    sleep: async () => {},
  });
  assert.equal(ok, true);
  assert.equal(probes, 2);
});
