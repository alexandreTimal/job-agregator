export const meta = {
  name: 'build-web-ui',
  description: "Construit l'UI web 3 pages (Fastify + Vite/React) pour job-agregator en multi-agent parallèle : fondation bloquante → lanes dev/review/fix en pipeline → run + fix global",
  whenToUse: "Implémenter l'interface web (Paramètres / Stats / Offres) décidée en brainstorming, en remplacement de Notion",
  phases: [
    { title: 'Foundation', detail: 'schéma sqlite, settings, contrat API + types partagés, scaffold Fastify/Vite, shell front mocké' },
    { title: 'Dev+Review+Fix', detail: 'lanes fichiers-disjoints, chaque lane dev → review → fix en pipeline' },
    { title: 'Integration', detail: 'run global end-to-end + fix de compatibilité + typecheck' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXTE PARTAGÉ — injecté dans chaque agent (ils démarrent sans mémoire).
// Décisions issues de la session de brainstorming 2026-06-11.
// ─────────────────────────────────────────────────────────────────────────────
const ARCH = `
PROJET : job-agregator — agrégateur de jobboards déterministe, sans LLM.
Stack actuelle : Node + TypeScript (ESM, "type":"module") + better-sqlite3 + Playwright.
Pipeline existant : config.terms → fetch (par terme × source) → dedup sqlite → filtre déterministe → (export Notion, À SUPPRIMER).
On ajoute une UI web LOCALE (un seul utilisateur, localhost) qui REMPLACE Notion.

CONVENTIONS (cf CLAUDE.md) — À RESPECTER :
- Commentaires et messages en français, orthographe accentuée correcte.
- Filtre = fonctions pures déterministes dans src/filter.ts. Aucun critère codé en dur ailleurs.
- Les sources (src/sources/*) ne font QUE fetch+normaliser ; elles n'écrivent pas en base, ne filtrent pas.
- Dedup centralisé dans src/store/sqlite.ts, clé = hash composite (title+company+location), pas l'URL.
- Secrets via .env (gitignored). data/ et *.db gitignored.
- NB : la clause "pas de web app / React" du CLAUDE.md est LEVÉE pour cette UI locale assumée (la mise à jour du CLAUDE.md fait partie de la Phase 0).

ARCHI CIBLE DÉCIDÉE :
- Run du pipeline = SOUS-PROCESS : le serveur web spawn \`tsx src/index.ts\`, lit stdout (lignes de progression), pousse à l'UI via SSE. Le code du pipeline reste lançable en CLI. Verrou en mémoire serveur : un seul run à la fois (2e POST /api/run → 423).
- Config = table sqlite \`settings\` (clé/valeur), SEEDÉE une 1ère fois depuis config/search.config.ts, puis lue à chaque run. Champs pilotés par l'UI : terms[], contractTypes (valeurs possibles "stage" et "CDI"), enabledSources[].
- Suppression d'offre = SOFT-DELETE (colonne \`deleted\`), cachée de l'UI, connue du dedup, jamais re-proposée.
- Like = colonne \`liked\` (0/1), sert au filtre "favoris" et au tri (likées en tête).
- Ancienneté = vraie date scrapée : colonne \`published_at\` (nullable), remplie best-effort par les sources ; UI affiche published_at ?? first_seen_at.
- Stats = requêtes sur sqlite + table \`runs\` (1 ligne/lancement : started_at, duration_ms, found, new, duplicates, per_source json). Le pipeline compte désormais new vs duplicates (fini l'INSERT OR IGNORE muet) et écrit la ligne runs.
- Logos sources = assets locaux public/logos/{sourceName}.svg.
- Accès = bind 127.0.0.1 uniquement.

SCHÉMA SQLITE ACTUEL (src/store/sqlite.ts) :
  seen_offers(id, hash UNIQUE, title, company, url, source, score, first_seen_at, notified_notion)
  + fonctions initDb, getDb, isOfferSeen, insertOffer, markNotifiedNotion, isNotifiedNotion, closeDb.
DELTAS À APPLIQUER : + colonnes liked/deleted/published_at sur seen_offers ; + tables settings et runs ; nouvelles fonctions d'accès (setLiked, setDeleted, listOffers, get/setSettings, insertRun, getStats…). notified_notion devient obsolète (laisser la colonne, ne plus l'utiliser).

TYPES EXISTANTS (src/lib/types.ts) : RawJobOffer{title,company,location,salary,contractType,urlSource,sourceName,publishedAt:Date|null,...}, ScoredOffer extends RawJobOffer {hash,score,priority}.
INTERFACE SOURCE (src/lib/source-interface.ts) : ScrapingSource{name; fetch(opts?):Promise<RawJobOffer[]>}.
REGISTRY (src/sources/registry.ts) : export const sources = [wttjSource, helloworkSource].
ORCHESTRATEUR (src/index.ts) : boucle terms × sources, dedup via Map+isNotifiedNotion, insertOffer, passesFilters, scoreOffer, puis pushToNotion (À REMPLACER : ne plus pousser Notion ; toutes les offres retenues restent en base, lisibles par l'UI).
`.trim()

const API = `
CONTRAT D'API (REST, JSON) — source de vérité partagée web/ ↔ src/server/ :
- GET    /api/offers?filter=all|liked&sort=recent|score   → Offer[] (hors deleted=1)
- POST   /api/offers/:id/like      body {liked:boolean}    → {ok:true}
- POST   /api/offers/:id/delete                            → {ok:true} (soft-delete)
- GET    /api/settings              → {terms:string[], contractTypes:string[], enabledSources:string[]}
- PUT    /api/settings  body idem   → {ok:true}
- GET    /api/stats                 → {today:number, week:number, duplicates:number, bySource:{source:string,count:number,logo:string}[], lastRuns:Run[]}
- POST   /api/run                   → 202 si démarré, 423 si run déjà en cours
- GET    /api/run/stream (SSE)      → events {type:'progress'|'done'|'error', term?, source?, found?, message?}
Types partagés dans src/shared/types.ts (Offer, Settings, Stats, Run, RunEvent), importés par web/ ET src/server/.
`.trim()

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMAS de sortie structurée
// ─────────────────────────────────────────────────────────────────────────────
const FOUNDATION_SCHEMA = {
  type: 'object',
  required: ['ready', 'filesCreated', 'summary'],
  properties: {
    ready: { type: 'boolean', description: 'true si les contrats sont figés et le scaffold compile' },
    filesCreated: { type: 'array', items: { type: 'string' } },
    schemaChanges: { type: 'string', description: 'résumé des deltas sqlite appliqués' },
    apiContractPath: { type: 'string' },
    sharedTypesPath: { type: 'string' },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}
const DEV_SCHEMA = {
  type: 'object',
  required: ['lane', 'filesTouched', 'summary'],
  properties: {
    lane: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    contractDeviations: { type: 'array', items: { type: 'string' }, description: 'écarts éventuels au contrat API/types partagés' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['lane', 'verdict', 'issues'],
  properties: {
    lane: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'needs-fix'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
}
const FIX_SCHEMA = {
  type: 'object',
  required: ['lane', 'resolved', 'fixesApplied'],
  properties: {
    lane: { type: 'string' },
    resolved: { type: 'boolean' },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
  },
}
const INTEGRATION_SCHEMA = {
  type: 'object',
  required: ['typecheckPass', 'ranSuccessfully', 'summary'],
  properties: {
    typecheckPass: { type: 'boolean' },
    ranSuccessfully: { type: 'boolean', description: 'le serveur démarre et le bouton run déclenche bien le pipeline' },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    smokeTest: { type: 'string', description: 'ce qui a été vérifié end-to-end' },
    remainingIssues: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// LANES — périmètres de fichiers DISJOINTS (garantie anti-collision).
// ─────────────────────────────────────────────────────────────────────────────
const LANES = [
  {
    key: 'A-orchestrateur',
    owns: 'src/index.ts, src/sources/registry.ts, src/filter.ts (et SUPPRIMER src/notion.ts)',
    brief: `Adapter l'orchestrateur et le filtre :
- src/index.ts : lire la config EFFECTIVE depuis sqlite (getSettings()) au lieu de config/search.config.ts directement ; ne lancer que les sources de enabledSources ; compter new vs duplicates pendant le dedup ; à la fin, écrire UNE ligne dans la table runs (insertRun) avec found/new/duplicates/per_source/duration_ms ; émettre la progression sur stdout en lignes parsables (ex: \`PROGRESS {"type":"progress","term":...,"source":...,"found":N}\`) pour que le serveur les relaie en SSE ; SUPPRIMER tout appel Notion (pushToNotion). Garder le run lançable en CLI (\`tsx src/index.ts\`).
- src/sources/registry.ts : exposer un moyen de filtrer les sources par enabledSources (ex: getEnabledSources(names)).
- src/filter.ts : s'assurer que contractTypes accepte "stage" ET "CDI" comme valeurs sélectionnables (rester pur/déterministe).
- Supprimer src/notion.ts et toute référence.`,
  },
  {
    key: 'B-sources-dates',
    owns: 'src/sources/wttj.ts, src/sources/hellowork.ts',
    brief: `Remplir la vraie date de publication (aujourd'hui \`publishedAt: null\` dans les deux). Extraire best-effort la date depuis le DOM/payload de chaque jobboard et la mettre dans RawJobOffer.publishedAt (Date|null). Best-effort STRICT : si la date est introuvable, laisser null sans casser le fetch. Ne RIEN changer d'autre au contrat ScrapingSource.`,
  },
  {
    key: 'C-api-fastify',
    owns: 'src/server/** (index.ts, routes/offers.ts, routes/settings.ts, routes/stats.ts, routes/run.ts)',
    brief: `Implémenter le serveur Fastify selon le CONTRAT D'API. bind 127.0.0.1. Servir le SPA buildé (web/dist) en statique. routes : offers (list filtrée hors deleted, like, soft-delete), settings (get/put dans la table settings), stats (today/week/duplicates/bySource/lastRuns depuis sqlite + runs), run (POST = spawn \`tsx src/index.ts\` avec VERROU mémoire : 423 si déjà en cours ; relayer les lignes PROGRESS du stdout du sous-process vers /api/run/stream en SSE). Utiliser les fonctions d'accès de src/store/sqlite.ts (NE PAS réécrire le schéma) et les types de src/shared/types.ts.`,
  },
  {
    key: 'D-page-settings',
    owns: 'web/pages/Settings.tsx (+ composants web/components propres à cette page)',
    brief: `Page Paramètres : éditer terms[] (ajout/suppression), contractTypes (cases stage / CDI), enabledSources (cases par jobboard). Charge via GET /api/settings, sauvegarde via PUT /api/settings. Consommer le client API typé et les types partagés. Se coder contre le mock fourni par la fondation si le backend n'est pas prêt.`,
  },
  {
    key: 'E-page-stats',
    owns: 'web/pages/Stats.tsx (+ composants propres)',
    brief: `Page Stats : offres trouvées aujourd'hui / cette semaine, nombre de doublons, répartition par source (avec logo public/logos/{source}.svg), et historique des derniers runs. Charge via GET /api/stats. Graphes simples (pas de lib lourde nécessaire). Types partagés + client API typé.`,
  },
  {
    key: 'F-page-offers',
    owns: 'web/pages/Offers.tsx (+ composants propres : carte offre, bouton run)',
    brief: `Page Offres : liste (titre, logo source, ancienneté = published_at ?? first_seen_at en "il y a X"), bouton Liker (POST like), bouton Supprimer (POST delete, retire de la liste), filtre favoris + tri. Bouton "Lancer la recherche" : POST /api/run (gérer le 423 "déjà en cours", désactiver pendant l'exécution), s'abonner à /api/run/stream (SSE) pour une barre de progression live, rafraîchir la liste à la fin. Types partagés + client API typé.`,
  },
  {
    key: 'G-logos',
    owns: 'public/logos/wttj.svg, public/logos/hellowork.svg',
    brief: `Créer deux petits logos SVG (simples, lisibles, ~24-32px) pour les sources "wttj" (Welcome to the Jungle) et "hellowork", nommés par sourceName exact utilisé dans le code. Aucun autre fichier.`,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 0 — FONDATION (bloquante)
// ─────────────────────────────────────────────────────────────────────────────
phase('Foundation')
log('Phase 0 — Fondation : gel des contrats partagés (bloquant)')

const foundation = await agent(`Tu es l'agent FONDATION. Tu figes les contrats partagés AVANT tout dev parallèle. Travaille dans le repo courant.

${ARCH}

${API}

TÂCHES (dans cet ordre) :
1. src/store/sqlite.ts : ajouter colonnes liked (BOOLEAN DEFAULT 0), deleted (BOOLEAN DEFAULT 0), published_at (DATETIME NULL) à seen_offers (via ALTER idempotents ou migration au démarrage) ; créer table settings(key TEXT PRIMARY KEY, value TEXT) et table runs(id INTEGER PK AUTOINCREMENT, started_at DATETIME DEFAULT CURRENT_TIMESTAMP, duration_ms INTEGER, found INTEGER, new INTEGER, duplicates INTEGER, per_source TEXT). Ajouter les fonctions d'accès : listOffers(filter,sort), setLiked, setDeleted, getSettings, setSettings, insertRun, getStats. Garder l'API existante en place.
2. src/settings.ts : getSettings()/setSettings() au-dessus de la table settings, SEED initial depuis config/search.config.ts (terms, contractTypes, enabledSources = noms des sources actuelles) si la table est vide. C'est la config EFFECTIVE lue par l'orchestrateur.
3. src/shared/types.ts : définir et exporter Offer, Settings, Stats, Run, RunEvent EXACTEMENT selon le CONTRAT D'API. Ces types sont la source de vérité.
4. docs/api-contract.md : écrire le contrat d'API ci-dessus en clair (routes, params, shapes, codes 202/423).
5. Scaffold : ajouter à package.json les deps (fastify, vite, react, react-dom, @vitejs/plugin-react) et devDeps de types ; scripts "dev" (lance Fastify + Vite en parallèle), "build" (vite build), "start" (serveur sur le build). Créer la config Vite (web/), tsconfig pour web/, squelettes vides src/server/index.ts + routes/, dossier public/logos/.
6. web/lib/api-client.ts : client typé (fetch) contre le contrat, importe src/shared/types.ts. Fournir aussi un MOCK activable (ex: VITE_MOCK=1) renvoyant des données factices, pour que les pages se codent sans backend.
7. web/ shell : routeur 3 pages (Paramètres / Stats / Offres), layout + nav, App monté sur les pages (les .tsx des pages seront écrits par d'autres agents — crée des stubs minimaux qui importent web/pages/{Settings,Stats,Offers}).
8. Mettre à jour CLAUDE.md : acter l'ajout de l'UI web locale (lever la clause "pas de web app/React" pour ce périmètre) et documenter le flux settings sqlite → filter, et le run en sous-process.
9. Lancer \`npm install\` puis \`npx tsc --noEmit\` sur le périmètre fondation et corriger jusqu'au vert (les stubs de pages doivent compiler).

CONTRAINTE : tu produis les INTERFACES que d'autres agents vont consommer. Sois strict sur src/shared/types.ts et docs/api-contract.md : ils ne doivent plus bouger. Ne code PAS le contenu des 3 pages ni les routes serveur complètes (juste des stubs qui compilent). Renvoie ready:true seulement si le scaffold compile.`,
  { schema: FOUNDATION_SCHEMA, label: 'phase0:foundation', phase: 'Foundation' })

if (!foundation || !foundation.ready) {
  log('⛔ Fondation non prête — arrêt avant fan-out. Blockers : ' + JSON.stringify(foundation?.blockers ?? 'agent null'))
  return { aborted: true, reason: 'foundation-not-ready', foundation }
}
log('✅ Fondation figée : ' + (foundation.summary || '').slice(0, 200))

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — DEV → REVIEW → FIX en PIPELINE (lanes concurrentes, sans barrière)
// ─────────────────────────────────────────────────────────────────────────────
phase('Dev+Review+Fix')
log(`Phase 1 — ${LANES.length} lanes en pipeline (dev → review → fix), fichiers disjoints`)

const laneResults = await pipeline(
  LANES,

  // Stage 1 — DEV
  (lane) => agent(`Tu es l'agent DEV de la lane ${lane.key}. Tu n'édites QUE : ${lane.owns}. N'écris dans AUCUN autre fichier (les autres lanes travaillent en parallèle sur des fichiers disjoints).

${ARCH}

${API}

La FONDATION est déjà en place (schéma sqlite, src/settings.ts, src/shared/types.ts, docs/api-contract.md, scaffold Fastify/Vite, web/lib/api-client.ts avec mock). Lis-les avant de coder ; ne les modifie pas.

TON PÉRIMÈTRE :
${lane.brief}

Respecte les conventions du projet (français, déterministe, pureté du filtre). Importe les types partagés. Pour les pages front, code contre le mock si besoin. Quand tu as fini, vérifie que tes fichiers compilent (\`npx tsc --noEmit\`, en ignorant les erreurs provenant de fichiers hors de ton périmètre encore incomplets).`,
    { schema: DEV_SCHEMA, label: `dev:${lane.key}`, phase: 'Dev+Review+Fix' }),

  // Stage 2 — REVIEW
  (dev, lane) => {
    if (!dev) return null
    return agent(`Tu es l'agent REVIEWER de la lane ${lane.key}. Revue ADVERSARIALE et ciblée du travail DEV sur : ${lane.owns}.

${ARCH}

${API}

Le DEV déclare : ${JSON.stringify(dev).slice(0, 1500)}

Vérifie SPÉCIFIQUEMENT :
- Conformité au CONTRAT D'API et aux types partagés (src/shared/types.ts) — tout écart est un blocker.
- Respect des conventions CLAUDE.md (français, filtre pur/déterministe, sources qui ne font que fetch, dedup centralisé).
- Pas d'écriture hors périmètre ${lane.owns}.
- Bugs réels (gestion d'erreur, cas null comme published_at, verrou run, soft-delete vs dedup, SSE).
Lis les fichiers concernés. Sois précis : fichier + description. verdict='needs-fix' s'il y a au moins un blocker/major.`,
      { schema: REVIEW_SCHEMA, label: `review:${lane.key}`, phase: 'Dev+Review+Fix' })
  },

  // Stage 3 — FIX
  (review, lane) => {
    if (!review) return null
    if (review.verdict === 'pass' && (review.issues || []).length === 0) {
      return { lane: lane.key, resolved: true, fixesApplied: ['(aucun correctif nécessaire — review pass)'], remaining: [] }
    }
    return agent(`Tu es l'agent FIXER de la lane ${lane.key}. Corrige UNIQUEMENT les problèmes remontés par la review, dans ton périmètre : ${lane.owns}. N'élargis pas le scope.

${ARCH}

${API}

ISSUES À CORRIGER : ${JSON.stringify(review.issues)}

Applique les correctifs, puis revérifie la compilation de tes fichiers. resolved=true seulement si tous les blockers/majors sont traités.`,
      { schema: FIX_SCHEMA, label: `fix:${lane.key}`, phase: 'Dev+Review+Fix' })
  },
)

const laneOk = laneResults.filter(Boolean)
log(`Phase 1 terminée : ${laneOk.length}/${LANES.length} lanes traitées`)

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — RUN + FIX GLOBAL (barrière : tout est mergé dans l'arbre)
// ─────────────────────────────────────────────────────────────────────────────
phase('Integration')
log('Phase 2 — Intégration : run global end-to-end + fix de compatibilité')

const integration = await agent(`Tu es l'agent INTÉGRATION. Toutes les lanes ont livré dans l'arbre de travail courant. Ton job : garantir la COMPATIBILITÉ GLOBALE après les fix de chaque lane.

${ARCH}

${API}

RÉSULTATS DES LANES : ${JSON.stringify(laneResults).slice(0, 3000)}

TÂCHES :
1. Débrancher les mocks front : câbler web/lib/api-client.ts sur le vrai backend (VITE_MOCK off), monter les 3 pages réelles dans le shell.
2. \`npm install\` si besoin, puis \`npx tsc --noEmit\` sur TOUT le projet → corriger tout drift de types entre lanes (c'est ici qu'on rattrape les incompatibilités qui n'apparaissent que tout assemblé : signatures sqlite, shapes API, format des événements SSE, noms de sources/logos).
3. \`npm run build\` (vite) → corriger les erreurs de build.
4. Smoke test end-to-end : démarrer le serveur (\`npm run start\` ou équivalent, en arrière-plan, bind 127.0.0.1), vérifier que GET /api/offers, /api/settings, /api/stats répondent, et que POST /api/run démarre bien le sous-process \`tsx src/index.ts\` et émet du SSE (un --dry-run / run court suffit ; ne dépends pas du réseau jobboard si instable — vérifie au moins que le spawn et le verrou 423 fonctionnent). Arrête le serveur ensuite.
5. Corriger tout ce qui bloque le flux complet bouton "Lancer la recherche" → pipeline → écriture runs → rafraîchissement UI.

Renvoie typecheckPass, ranSuccessfully, la liste des fix de compatibilité appliqués, ce que le smoke test a couvert, et les problèmes restants éventuels.`,
  { schema: INTEGRATION_SCHEMA, label: 'global:run-fix', phase: 'Integration' })

log('✅ Intégration terminée : typecheck=' + integration?.typecheckPass + ' run=' + integration?.ranSuccessfully)

return {
  foundation,
  lanes: laneResults,
  integration,
}
