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
  "atsBoards": { "greenhouse": ["stripe"], "lever": ["swile"] }
}
```

- `atsBoards` : Record de tokens d'entreprise par source ATS (`greenhouse`,
  `lever`). Optionnel en PUT (absent → `{}` par défaut).

### PUT /api/settings

Remplace la configuration effective.

- Corps : `Settings` (même forme que la réponse de GET /api/settings).
- `contractTypes` : valeurs possibles `"stage"` et `"CDI"`.
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

### GET /api/run/stream (SSE)

Flux Server-Sent Events de progression du run en cours. Chaque message `data:`
est un `RunEvent` sérialisé en JSON.

```
data: {"type":"progress","term":"data engineer","source":"wttj","found":12}

data: {"type":"done","message":"run terminé"}
```

- `type: "progress"` : avancement (`term` / `source` / `found` best-effort).
- `type: "done"`     : run terminé proprement.
- `type: "error"`    : run échoué (`message` renseigné).

Le flux se ferme après l'événement `done` ou `error`.
