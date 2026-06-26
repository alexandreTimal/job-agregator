# Contrat d'API — job-agregator (UI web locale)

Source de vérité partagée entre `src/server/` (Fastify) et `web/` (React/Vite).
Les formes JSON correspondent EXACTEMENT aux types de `src/shared/types.ts`,
importés des deux côtés. **Contrat figé** : toute modification doit être
synchronisée ici ET dans `src/shared/types.ts`.

- Transport : HTTP/JSON, serveur lié à `127.0.0.1` uniquement (mono-utilisateur).
- Toutes les dates sont des chaînes ISO 8601 (UTC).
- Les corps de requête/réponse sont en `application/json`, sauf le flux SSE.

## Types (rappel)

Voir `src/shared/types.ts` pour les définitions canoniques :
`Offer`, `OfferFilter` (`"all" | "liked" | "applied"`), `OfferSort` (`"recent" | "score"`),
`Settings`, `SearchProfile`, `SearchProfileMeta`, `ProfilesState`, `SourceCount`, `Run`, `Stats`, `RunEvent`,
`CandidatureStatus` (`"none" | "queued" | "generating" | "ready" | "failed"`),
`CandidatureState`, `CandidatureEvent`.

`Offer` porte deux champs liés au suivi de candidature :

- `appliedAt` : date (ISO 8601) du clic « J'ai postulé », ou `null` si non postulée.
  Sert à la fois de drapeau « postulée » et de point de départ de la relance.
- `followUpAt` : date de relance **dérivée** = `appliedAt` + 3 jours ouvrables
  (samedi/dimanche sautés, sans jours fériés), ou `null`. Jamais persistée :
  recalculée côté serveur à chaque lecture.

## Routes

### GET /api/offers

Liste les offres visibles (exclut systématiquement `deleted = 1`).

Query params :

| Param    | Valeurs                       | Défaut    | Rôle                                              |
| -------- | ----------------------------- | --------- | ------------------------------------------------- |
| `filter` | `all` \| `liked` \| `applied` | `all`     | `all` = offres non triées (ni likées ni postulées) ; `liked` = favoris ; `applied` = offres postulées. |
| `sort`   | `recent` \| `score`           | `recent`  | Tri ; les likées remontent en tête.               |

- `recent` : tri par `publishedAt ?? firstSeenAt` décroissant.
- `score`  : tri par `score` décroissant puis date décroissante.
- `all` exclut les offres `liked = true` et `appliedAt != null` : liker ou postuler une offre la déplace vers l'onglet dédié.
- `liked = true` passe en tête dans tout filtre pouvant en contenir (`liked`, et `applied` pour une offre likée + postulée) ; `all` n'en contient jamais, l'ordre y est donc sans effet.

Réponse `200` : `Offer[]`.

### POST /api/offers/:id/like

Bascule l'état favori d'une offre.

- Param de chemin `:id` : identifiant numérique de l'offre.
- Corps : `{ "liked": boolean }`.
- Réponse `200` : `{ "ok": true }`.
- `404` si l'`id` est inconnu.

### POST /api/offers/:id/applied

Marque (ou démarque) une offre comme « postulée ».

- Param de chemin `:id` : identifiant numérique de l'offre.
- Corps : `{ "applied": boolean }`.
- `applied: true` fige l'instant courant dans `appliedAt` ; `applied: false`
  repasse `appliedAt` (et donc `followUpAt`) à `null`.
- Réponse `200` : `{ "ok": true, "appliedAt": string | null, "followUpAt": string | null }`
  — les dates recalculées, pour une mise à jour optimiste côté UI sans rechargement.
- `400` si le corps est mal formé (champ `applied` non booléen).
- `404` si l'`id` est inconnu.

### POST /api/offers/:id/delete

Soft-delete d'une offre : elle disparaît de l'UI, reste connue du dédup et
n'est jamais re-proposée.

- Param de chemin `:id` : identifiant numérique de l'offre.
- Corps : aucun.
- Réponse `200` : `{ "ok": true }`.
- `404` si l'`id` est inconnu.

### GET /api/settings

Lit la configuration effective (table sqlite `settings`) : le cron global FUSIONNÉ avec
les 9 critères du **profil de recherche actif** (cf. section « Profils »). La forme
`Settings` reste inchangée ; l'orchestrateur et le filtre n'ont aucune notion de profil.

Réponse `200` : `Settings`

```json
{
  "terms": ["data engineer"],
  "contractTypes": ["CDI"],
  "enabledSources": ["wttj", "hellowork"],
  "atsBoards": { "greenhouse": ["stripe"], "lever": ["swile"] },
  "salaryMin": 45000,
  "locations": ["Paris", "Lyon"],
  "remoteOk": true,
  "maxOfferAgeDays": 7,
  "titleBlacklist": ["sales", "lead"],
  "cronEnabled": false,
  "cronTimes": ["08:00", "20:00"]
}
```

- `atsBoards` : Record de tokens d'entreprise par source ATS (`greenhouse`,
  `lever`). Optionnel en PUT (absent → `{}` par défaut).
- `salaryMin` : salaire annuel minimum en €. Entier ≥ 0 ; `0` = sans minimum.
  Une offre sans salaire (ou non parsable) est conservée (filtre lenient).
- `locations` : villes acceptées (sans `"remote"`, géré par `remoteOk`). Pilote
  AUSSI la recherche : chaque ville déclenche une requête distincte sur les
  sources qui filtrent par lieu (hellowork, linkedin), aucune n'acceptant
  plusieurs villes à la fois. Liste vide = aucune contrainte de ville. Une offre
  sans lieu est conservée (filtre lenient).
- `remoteOk` : booléen. Quand vrai, les offres en télétravail sont acceptées en
  plus des `locations` (post-filtre ; n'ajoute pas de requête de recherche).
- `maxOfferAgeDays` : ancienneté max de mise en ligne, en jours. Entier ≥ 0 ;
  `0` = sans limite (défaut `7`). Une offre sans date de publication est conservée
  (filtre lenient).
- `titleBlacklist` : mots qui écartent une offre quand ils apparaissent comme MOT
  ENTIER dans le TITRE seul (jamais l'entreprise), insensible casse/accents. Une
  entrée multi-mots matche la séquence exacte. Distinct d'`exclude` (statique,
  sous-chaîne, titre + entreprise). Liste vide = aucun bannissement.
- `cronEnabled` : booléen. Quand vrai, le scheduler in-process déclenche un run à
  chaque horaire de `cronTimes` (défaut `false`).
- `cronTimes` : horaires quotidiens `"HH:MM"` (heure locale, `00:00`→`23:59`),
  défaut `["08:00", "20:00"]`. À chaque horaire, un run est lancé. Au démarrage du
  serveur, si un créneau a été manqué (PC éteint), un run de rattrapage est
  déclenché une fois.

**Notification bureau de fin de run** : à la fin de **tout** run — planifié (cron)
comme manuel (`POST /api/run`) — une notification bureau (`notify-send`/libnotify,
best-effort) annonce le bilan : succès « X offres trouvées · Y nouvelles », ou le
message d'erreur en cas d'échec. Aucune notif n'élève d'erreur (binaire absent /
session sans `DISPLAY` → WARN loggé, run inchangé).

### PUT /api/settings

Remplace la configuration effective.

- Corps : `Settings` (même forme que la réponse de GET /api/settings).
- `contractTypes` : valeurs possibles `"stage"` et `"CDI"`.
- `salaryMin` : entier ≥ 0 obligatoire (`0` = sans minimum). Un nombre non entier
  ou négatif rend le corps invalide.
- `locations` : tableau de chaînes obligatoire (peut être vide) ; `remoteOk` :
  booléen obligatoire.
- `maxOfferAgeDays` : entier ≥ 0 obligatoire (`0` = sans limite). Un nombre
  non entier ou négatif rend le corps invalide.
- `titleBlacklist` : tableau de chaînes (peut être vide). Lenient comme
  `atsBoards` : absent → `[]`. Les chaînes sont trimmées et dédoublonnées.
- `cronEnabled` : booléen obligatoire.
- `cronTimes` : tableau de chaînes `"HH:MM"` valides ; toute valeur hors format
  rend le corps invalide. Après écriture, le scheduler est rechargé.
- Réponse `200` : `{ "ok": true }`.
- `400` si le corps est mal formé.
- Les 9 critères (`terms`…`titleBlacklist`) sont écrits dans le **profil actif** ;
  `cronEnabled`/`cronTimes` dans les clés globales. Les autres profils sont intacts.

## Profils de recherche

Un **profil** capture les 9 critères de recherche/filtrage (tout `Settings` SAUF
`cronEnabled`/`cronTimes`, qui restent globaux). Un seul profil est **actif** ; chaque run
et `GET/PUT /api/settings` opèrent sur le profil actif. Les profils vivent dans la table
clé/valeur `settings` (clés `searchProfiles` + `activeProfileId`) — aucune table SQL dédiée.
Toujours ≥ 1 profil ; une base antérieure est migrée paresseusement vers un profil
« Par défaut » construit depuis les critères existants.

Types : `SearchProfile` (`id`, `name` + les 9 critères), `SearchProfileMeta` (`{id, name}`),
`ProfilesState` (`{ activeProfileId, profiles: SearchProfileMeta[] }`).

### GET /api/profiles

Réponse `200` : `ProfilesState`

```json
{ "activeProfileId": "default",
  "profiles": [ { "id": "default", "name": "Par défaut" }, { "id": "p1", "name": "Stage ML" } ] }
```

### POST /api/profiles

Crée un profil dont les critères **clonent le profil actif** (point de départ). Ne l'active
PAS.

- Corps : `{ "name": string }` (non vide après trim).
- Réponse `200` : `SearchProfileMeta` (`{ id, name }`) — l'`id` est généré (stable, jamais ré-affecté).
- `400` si `name` absent/vide.

### POST /api/profiles/:id/activate

Bascule le profil actif. Sans corps. Après activation, `GET /api/settings` rend les critères
du nouveau profil actif.

- Réponse `200` : `{ "ok": true }`.
- `404` si l'`id` n'existe pas.

### PATCH /api/profiles/:id

Renomme un profil.

- Corps : `{ "name": string }` (non vide après trim).
- Réponse `200` : `{ "ok": true }`.
- `400` si `name` absent/vide ; `404` si l'`id` n'existe pas.

### DELETE /api/profiles/:id

Supprime un profil. Si c'est l'actif, le serveur active automatiquement un autre profil.

- Sans corps. Réponse `200` : `{ "ok": true }`.
- `404` si l'`id` n'existe pas ; `409` s'il s'agit du **dernier** profil (toujours ≥ 1).

### GET /api/stats

Statistiques agrégées (requêtes sqlite + table `runs`).

`byLocation` (`LabeledCount[]`) : répartition par lieu, triée par volume, limitée
aux 8 lieux les plus fréquents ; la traîne est regroupée dans un seau `"Autres"`
et les offres sans lieu dans `"Non précisé"`. `byContract` (`LabeledCount[]`) :
répartition par type de contrat, classe binaire `"Stage"` / `"CDI"` (dérivée à
l'insertion depuis le `contractType` source, repli sur le titre). Le pourcentage
est calculé côté UI sur le total.

Réponse `200` : `Stats`

```json
{
  "today": 3,
  "week": 18,
  "duplicates": 42,
  "bySource": [{ "source": "wttj", "count": 12, "logo": "/logos/wttj.svg" }],
  "byLocation": [
    { "label": "Paris", "count": 9 },
    { "label": "Autres", "count": 3 },
    { "label": "Non précisé", "count": 2 }
  ],
  "byContract": [
    { "label": "CDI", "count": 13 },
    { "label": "Stage", "count": 5 }
  ],
  "lastRuns": [
    {
      "id": 7,
      "startedAt": "2026-06-11T08:00:00.000Z",
      "durationMs": 41230,
      "found": 50,
      "new": 6,
      "duplicates": 44,
      "perSource": { "wttj": 30, "hellowork": 20 }
    }
  ]
}
```

### POST /api/run

Déclenche un run du pipeline (sous-process `tsx src/index.ts`). Verrou en
mémoire serveur : un seul run à la fois.

- Corps : aucun.
- Réponse `202` : `{ "ok": true }` — run démarré.
- Réponse `423` (Locked) : `{ "ok": false, "error": "run already in progress" }`
  — un run est déjà en cours.

### GET /api/run/status

État du verrou de run en mémoire serveur. Permet à l'UI de savoir, après un
changement de page (le `RunButton` est démonté/remonté), s'il faut se reconnecter
au flux SSE pour reprendre le suivi d'un run toujours en cours.

- Corps : aucun.
- Réponse `200` : `{ "running": boolean }` — `true` si un run est en cours.

### POST /api/run/cancel

Annule le run en cours en tuant son groupe de process (npx → tsx → node →
chromium : pas de navigateur orphelin).

- Corps : aucun.
- Réponse `202` : `{ "ok": true }` — annulation acceptée.
- Réponse `409` (Conflict) : `{ "ok": false, "error": "no run in progress" }`
  — aucun run en cours.

L'annulation se manifeste sur le flux SSE comme un événement terminal `done`
avec `message: "Recherche annulée"` (et non un `error`) : aucun nouveau type de
`RunEvent` n'est introduit.

### GET /api/run/stream (SSE)

Flux Server-Sent Events de progression du run en cours. Chaque message `data:`
est un `RunEvent` sérialisé en JSON.

```
data: {"type":"progress","phase":"start","totalSources":8,"totalTerms":5}

data: {"type":"progress","phase":"source-start","source":"linkedin"}

data: {"type":"progress","phase":"source-progress","source":"linkedin","term":"data engineer","termIndex":2,"totalTerms":5}

data: {"type":"progress","phase":"source-done","source":"linkedin","found":12,"sourcesDone":3,"totalSources":8}

data: {"type":"done","message":"run terminé","newOffers":6}
```

- `type: "progress"` : avancement. `phase` (optionnel) distingue les sous-étapes —
  tous les champs sont optionnels (compat ascendante) :
  - `"start"`          : lancement du run (`totalSources`, `totalTerms`).
  - `"source-start"`   : une source démarre son fetch (`source`).
  - `"source-progress"`: une source web avance sur ses termes (`source`, `term`,
    `termIndex` 1-based, `totalTerms`).
  - `"source-done"`    : une source a fini (`source`, `found`, `sourcesDone`,
    `totalSources` → compteur global d'avancement).
  - Absence de `phase` : format historique (`term` / `source` / `found` best-effort).
- `type: "done"`     : run terminé proprement. `newOffers` (optionnel) porte le
  nombre de nouvelles offres du run, utilisé par la notification bureau du cron.
- `type: "error"`    : run échoué (`message` renseigné).

Le flux se ferme après l'événement `done` ou `error`.

## Candidature par offre (CV adapté + lettre)

Génère, pour une offre, un **CV adapté (PDF)** + une **lettre de motivation**, via
un agent `claude` lancé EN LOCAL sur l'abonnement de l'utilisateur (mode headless,
**aucune clé API**). Modèle « brouillon auto, revue dans l'UI » : l'agent décide
seul (dosage IA selon le poste, boucle de fit, garde-fous d'honnêteté) ; on ouvre
les fichiers et on relance si besoin. **Une candidature par offre, indépendantes :
plusieurs peuvent générer en parallèle** (plafond de concurrence + file, pas de
verrou global — contrairement au run). Artefacts dans `data/candidatures/<id>/`.

### POST /api/offers/:id/candidature

Lance (ou relance) la génération de la candidature d'une offre.

- Param de chemin `:id` : identifiant numérique de l'offre.
- Corps (optionnel) : `{ "instruction"?: string }` — consigne libre transmise à
  l'agent pour une relance orientée (ex. « insiste plus sur le commercial »).
- Idempotent tant qu'une génération est `queued`/`generating` pour cette offre
  (renvoie l'état courant sans relancer). Sur `none`/`ready`/`failed`, (re)lance.
- Réponse `202` : `{ "ok": true, "state": CandidatureState }`.
- `400` si l'`id` est invalide ; `404` si l'`id` est inconnu.

### GET /api/offers/:id/candidature

État courant de la candidature d'une offre.

- Réponse `200` : `CandidatureState`

```json
{
  "offerId": 220,
  "status": "ready",
  "cvReady": true,
  "lettreReady": true,
  "generatedAt": "2026-06-13T11:18:16.772Z",
  "error": null
}
```

- `status` : `none` (rien demandé) · `queued` (en file) · `generating` (agent en
  cours) · `ready` (CV + lettre disponibles) · `failed` (voir `error`).
- `cvReady` / `lettreReady` : présence des fichiers sur disque.
- Après redémarrage serveur, l'état live est perdu : il est redéduit du disque
  (`ready` si les deux fichiers existent, sinon `meta.json` pour `failed`).

### GET /api/offers/:id/candidature/cv

Sert le PDF du CV en `application/pdf` (en-tête `Content-Disposition: inline`, pour
ouverture dans un onglet). `404` si le CV n'est pas encore généré.

### GET /api/offers/:id/candidature/lettre

Sert la lettre en `text/markdown; charset=utf-8` (inline). `404` si absente.

### GET /api/candidatures/stream (SSE)

Flux Server-Sent Events des changements d'état de **toutes** les candidatures.
Chaque message `data:` est un `CandidatureEvent` (un `CandidatureState` + un champ
optionnel `phase`, libellé d'avancement humain). Au branchement, un **instantané**
de l'état de chaque candidature active est envoyé, puis les événements live.

```
data: {"offerId":220,"status":"queued","cvReady":false,"lettreReady":false,"generatedAt":null,"error":null}

data: {"offerId":220,"status":"generating","cvReady":false,"lettreReady":false,"generatedAt":null,"error":null,"phase":"génération en cours (cv-tailoring → rendu → lettre)"}

data: {"offerId":220,"status":"ready","cvReady":true,"lettreReady":true,"generatedAt":"2026-06-13T11:18:16.772Z","error":null}
```

Contrairement au flux de run, ce flux **ne se ferme pas** sur un terminal global
(les candidatures sont indépendantes et continues) : il reste ouvert avec heartbeat.
