import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLeverPosting } from "./lever";

test("mapLeverPosting : mappe vers RawScrapeResult (createdAt ms → ISO)", () => {
  const r = mapLeverPosting(
    {
      text: "Data Engineer",
      categories: { location: "Paris, France", commitment: "Permanent" },
      hostedUrl: "https://jobs.lever.co/swile/abc",
      createdAt: 1756369018244,
    },
    "swile",
  );
  assert.equal(r.title, "Data Engineer");
  assert.equal(r.company, "swile");
  assert.equal(r.location, "Paris, France");
  assert.equal(r.contractType, "Permanent");
  assert.equal(r.urlSource, "https://jobs.lever.co/swile/abc");
  assert.equal(r.publishedRaw, new Date(1756369018244).toISOString());
});

test("mapLeverPosting : champs absents → null", () => {
  const r = mapLeverPosting({ text: "X", hostedUrl: "u" }, "acme");
  assert.equal(r.location, null);
  assert.equal(r.contractType, null);
  assert.equal(r.publishedRaw, null);
});
