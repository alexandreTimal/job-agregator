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
`Offer`, `OfferFilter` (`"all" | "liked"`), `OfferSort` (`"recent" | "score"`),
`Settings`, `SourceCount`, `Run`, `Stats`, `RunEvent`.

## Routes

### GET /api/offers

Liste les offres visibles (exclut systématiquement `deleted = 1`).

Query params :

| Param    | Valeurs                | Défaut    | Rôle                                    |
| -------- | ---------------------- | --------- | --------------------------------------- |
| `filter` | `all` \| `liked`       | `all`     | `liked` ne renvoie que les favoris.     |
| `sort`   | `recent` \| `score`    | `recent`  | Tri ; les likées remontent en tête.     |

- `recent` : tri par `publishedAt ?? firstSeenAt` décroissant.
- `score`  : tri par `score` décroissant puis date décroissante.
- Dans tous les cas, `liked = true` passe en tête.

Réponse `200` : `Offer[]`.

### POST /api/offers/:id/like

Bascule l'état favori d'une offre.

- Param de chemin `:id` : identifiant numérique de l'offre.
- Corps : `{ "liked": boolean }`.
- Réponse `200` : `{ "ok": true }`.
- `404` si l'`id` est inconnu.

### POST /api/offers/:id/delete

Soft-delete d'une offre : elle disparaît de l'UI, reste connue du dédup et
n'est jamais re-proposée.

- Param de chemin `:id` : identifiant numérique de l'offre.
- Corps : aucun.
- Réponse `200` : `{ "ok": true }`.
- `404` si l'`id` est inconnu.

### GET /api/settings

Lit la configuration effective (table sqlite `settings`).

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
- `cronEnabled` : booléen. Quand vrai, le scheduler in-process déclenche un run à
  chaque horaire de `cronTimes` (défaut `false`).
- `cronTimes` : horaires quotidiens `"HH:MM"` (heure locale, `00:00`→`23:59`),
  défaut `["08:00", "20:00"]`. À chaque horaire, un run est lancé puis une
  notification bureau annonce le nombre de nouvelles offres. Au démarrage du
  serveur, si un créneau a été manqué (PC éteint), un run de rattrapage est
  déclenché une fois.

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
- `cronEnabled` : booléen obligatoire.
- `cronTimes` : tableau de chaînes `"HH:MM"` valides ; toute valeur hors format
  rend le corps invalide. Après écriture, le scheduler est rechargé.
- Réponse `200` : `{ "ok": true }`.
- `400` si le corps est mal formé.

### GET /api/stats

Statistiques agrégées (requêtes sqlite + table `runs`).

Réponse `200` : `Stats`

```json
{
  "today": 3,
  "week": 18,
  "duplicates": 42,
  "bySource": [{ "source": "wttj", "count": 12, "logo": "/logos/wttj.svg" }],
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
