import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { matchesAnyTerm, fetchJson } from "./shared";

test("matchesAnyTerm : match insensible à la casse et aux accents", () => {
  assert.equal(matchesAnyTerm("Senior Data Engineer", ["data engineer"]), true);
  assert.equal(matchesAnyTerm("Ingénieur Données", ["ingenieur donnees"]), true);
});

test("matchesAnyTerm : aucun terme ne matche", () => {
  assert.equal(matchesAnyTerm("Account Executive", ["data engineer", "ml engineer"]), false);
});

test("matchesAnyTerm : liste de termes vide → false (rien ne passe)", () => {
  assert.equal(matchesAnyTerm("Data Engineer", []), false);
});

test("fetchJson : renvoie le JSON parsé sur 200", async () => {
  mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
  );
  assert.deepEqual(await fetchJson("https://x.test/a"), { ok: 1 });
  mock.restoreAll();
});

test("fetchJson : renvoie null sur statut non-2xx (best-effort)", async () => {
  mock.method(globalThis, "fetch", async () => new Response("", { status: 404 }));
  assert.equal(await fetchJson("https://x.test/b"), null);
  mock.restoreAll();
});

test("fetchJson : renvoie null si fetch jette (réseau)", async () => {
  mock.method(globalThis, "fetch", async () => { throw new Error("ECONNRESET"); });
  assert.equal(await fetchJson("https://x.test/c"), null);
  mock.restoreAll();
});
