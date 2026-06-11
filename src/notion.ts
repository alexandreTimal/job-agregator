import type { ScoredOffer } from "./lib/types";
import { createLogger } from "./lib/logger";
import { isNotifiedNotion, markNotifiedNotion } from "./store/sqlite";

const logger = createLogger("NOTION");

const NOTION_API_URL = "https://api.notion.com/v1/pages";
const NOTION_VERSION = "2022-06-28";
const RATE_LIMIT_MS = 350;
const RELANCE_DAYS = 7;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildNotionProperties(offer: ScoredOffer): Record<string, unknown> {
  const publishedIso = offer.publishedAt ? offer.publishedAt.toISOString().split("T")[0] : null;
  const relanceIso = offer.publishedAt
    ? new Date(offer.publishedAt.getTime() + RELANCE_DAYS * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0]
    : null;

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: offer.company ?? "N/A" } }] },
    Poste: { rich_text: [{ text: { content: offer.title } }] },
    Source: { select: { name: offer.sourceName } },
    "Lien offre": { url: offer.urlSource },
    Score: { number: offer.score },
    Priorité: { select: { name: offer.priority } },
    Statut: { select: { name: "🔵 À postuler" } },
  };

  if (offer.contractType) properties["Type contrat"] = { select: { name: offer.contractType } };
  if (offer.location) properties.Localisation = { rich_text: [{ text: { content: offer.location } }] };
  if (publishedIso) properties["Date publication"] = { date: { start: publishedIso } };
  if (relanceIso) properties["Date relance"] = { date: { start: relanceIso } };

  return properties;
}

async function createNotionPage(offer: ScoredOffer, apiKey: string, dbId: string): Promise<boolean> {
  const response = await fetch(NOTION_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: buildNotionProperties(offer),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error(`Échec création page: ${offer.title}`, {
      status: response.status,
      body: body.slice(0, 200),
    });
    return false;
  }

  return true;
}

/**
 * Pousse les offres retenues vers Notion. Idempotent : une offre déjà notifiée
 * (flag `notified_notion` en sqlite) est ignorée — un run interrompu ne crée
 * jamais de doublon.
 */
export async function pushToNotion(
  offers: ScoredOffer[],
  opts: { dryRun: boolean },
): Promise<void> {
  const apiKey = process.env.NOTION_API_KEY;
  const dbId = process.env.NOTION_DATABASE_ID;

  if (!apiKey || !dbId) {
    logger.warn("NOTION_API_KEY ou NOTION_DATABASE_ID non configuré — skip Notion");
    return;
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const offer of offers) {
    if (isNotifiedNotion(offer.hash)) {
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      logger.info(`DRY-RUN: créerait "${offer.title}" (${offer.company ?? "N/A"}) [${offer.sourceName}, score ${offer.score}]`);
      created++;
      continue;
    }

    try {
      const success = await createNotionPage(offer, apiKey, dbId);
      if (success) {
        created++;
        markNotifiedNotion(offer.hash);
      } else {
        errors++;
      }
    } catch (error) {
      errors++;
      logger.error(`Exception pour "${offer.title}"`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await sleep(RATE_LIMIT_MS);
  }

  logger.info(`Notion: ${created} créées, ${skipped} déjà notifiées, ${errors} erreurs`);
}
