# job-agregator

Agrégateur de jobboards **maison**, déterministe et sans interface : il récupère
les offres à partir de **termes choisis à la main**, applique un **filtrage
déterministe**, et pousse les offres retenues dans une **base Notion**.

Fork allégé de `Job_watcher` (voisin) — voir `CLAUDE.md` pour les conventions.

## Flux

```
config/search.config.ts (termes, exclusions, salaire, lieux, contrat)
        │
        ▼
[par terme × par source]  fetch  ──►  dédup (sqlite, hash composite)
        │
        ▼
filtre déterministe (exclude / salaryMin / locations / contrat)
        │
        ▼
score déterministe  ──►  export Notion (idempotent, anti-doublon)
```

## Installation

```bash
npm install          # installe les deps + le binaire Chromium (Playwright)
cp .env.example .env # puis renseigne NOTION_API_KEY et NOTION_DATABASE_ID
```

## Configuration

Tout se pilote depuis `config/search.config.ts` (édition = `git diff`) :

```ts
export const config: SearchConfig = {
  terms: ["data engineer", "machine learning engineer"],
  exclude: ["stage", "stagiaire", "alternance", "apprentissage"],
  salaryMin: 45000,
  locations: ["Paris", "remote"],
  contractTypes: ["CDI"],
  remote: "any",
  defaultRadiusKm: 30,
  maxPagesPerSource: 3,
};
```

## Lancer

```bash
npm run fetch        # run réel → crée les pages Notion
npm run fetch:dry    # dry-run → log seulement, ne touche pas Notion
npm run typecheck    # vérification TypeScript
```

## Automatisation (cron local)

```cron
# toutes les 4 h
0 */4 * * * cd /chemin/job-agregator && /usr/bin/npm run fetch >> data/cron.log 2>&1
```

La base sqlite (`data/job-agregator.db`) persiste localement le dédup et le flag
« déjà poussé dans Notion » : un run interrompu ne crée jamais de doublon.

## Base Notion attendue

La base Notion cible doit exposer ces propriétés :

| Propriété | Type |
|---|---|
| `Name` | Title |
| `Poste` | Rich text |
| `Source` | Select |
| `Lien offre` | URL |
| `Score` | Number |
| `Priorité` | Select (🔴 Haute / 🟠 Moyenne / 🟢 Basse) |
| `Statut` | Select (🔵 À postuler …) |
| `Type contrat` | Select |
| `Localisation` | Rich text |
| `Date publication` | Date |
| `Date relance` | Date |

## Source WTTJ : session requise (connexion unique)

Welcome to the Jungle a déplacé sa **recherche par mot-clé**
(`/fr/jobs-matches?classic-search=1`) **derrière l'authentification** : un client
non connecté est redirigé vers la page de connexion. La source WTTJ rejoue donc
une **session Playwright** que tu exportes **une seule fois** :

```bash
npm run wttj:login   # ouvre une fenêtre WTTJ → connecte-toi → reviens, Entrée
```

- Tu te connectes **toi-même** dans la fenêtre ouverte (email/mot de passe ou
  « Continuer avec … ») : **aucun mot de passe ne transite par le code**.
- La session est écrite dans `data/wttj-session.json` (gitignored ; surchargeable
  via `WTTJ_STORAGE_STATE`). À relancer quand elle expire — la source le signale
  alors par un WARN explicite (« Redirigé vers la page de connexion »).
- Sans session, WTTJ est **best-effort** : il loggue la consigne et renvoie `[]`
  sans casser le run.
- Pré-requis : un environnement **graphique** (le navigateur s'ouvre en visible).

## Sources

- **MVP** : WTTJ (session requise, ci-dessus), HelloWork (scraping Playwright + stealth).
- **Phase 1.5** (à porter depuis `Job_watcher/src/sources`) : Indeed, LinkedIn
  (via email forwarding), Google Alerts (RSS), Station F, career pages.
- **France Travail** (API officielle) : ajoutable trivialement, même interface
  `ScrapingSource`.

> Les sources legacy sont **best-effort** : une source qui échoue logge l'erreur
> et renvoie `[]` sans casser le run.
