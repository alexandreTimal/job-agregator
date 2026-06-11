import { test } from "node:test";
import assert from "node:assert/strict";
import { mapGreenhouseJob } from "./greenhouse";

const SAMPLE = {
  title: "Senior Data Engineer",
  company_name: "Stripe",
  location: { name: "Paris, France" },
  absolute_url: "https://stripe.com/jobs/search?gh_jid=123",
  first_published: "2026-06-02T11:35:23-04:00",
  updated_at: "2026-06-05T15:44:04-04:00",
};

test("mapGreenhouseJob : mappe vers RawScrapeResult", () => {
  assert.deepEqual(mapGreenhouseJob(SAMPLE), {
    title: "Senior Data Engineer",
    company: "Stripe",
    location: "Paris, France",
    salary: null,
    contractType: null,
    urlSource: "https://stripe.com/jobs/search?gh_jid=123",
    publishedRaw: "2026-06-02T11:35:23-04:00",
  });
});

test("mapGreenhouseJob : champs absents → null, fallback updated_at", () => {
  const r = mapGreenhouseJob({ title: "X", absolute_url: "u", updated_at: "2026-01-01T00:00:00Z" });
  assert.equal(r.company, null);
  assert.equal(r.location, null);
  assert.equal(r.publishedRaw, "2026-01-01T00:00:00Z");
});
