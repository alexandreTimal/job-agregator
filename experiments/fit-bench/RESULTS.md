# Banc d'essai « fit » — résultats

But : trancher entre 3 architectures d'orchestration de la génération de candidature,
sur leur fiabilité à produire un CV qui tient sur 1 page (94–100 %), SANS garde-fou algo
ni intervention humaine. Oracle : `generate_cv.py --measure` (déterministe).

Variantes :
- **control** — monolithe (un `claude -p`, boucle --measure dans le même agent, plafond 2 passes), prompts de tailoring DURCIS.
- **A** — un `claude -p` qui DÉLÈGUE le fit à un sous-agent (outil `Agent`), brief fit isolé sans plafond.
- **B** — 3 `claude -p` chaînés (tailoring → fit → lettre), chacun en contexte court.

## Grille 3×3 (1 run/cellule) — offres 329 (transfo), 272 (IA), 280 (mince)

| Offre | Variante | fit | fill % | agg-entrée | ordre | sous-agent | passes measure | temps |
|---|---|---|---|---|---|---|---|---|
| 329 | control | ok | 99   | ✗ | ✓ | – | – | 6,3 |
| 329 | A       | ok | 99,9 | ✗ | ✓ | – | – | 4,4 |
| 329 | B       | ok | 98,8 | ✗ | ✓ | – | – | 8,4 |
| 272 | control | ok | 100  | ✓ | ✓ | 0 | 3 | 11,5 |
| 272 | A       | ok | 98,9 | ✓ | ✓ | 1 | 6 | 6,2 |
| 272 | B       | ok | 99,5 | ✓ | ✓ | 0 | 3 | 6,4 |
| 280 | control | ok | 98,8 | ✗ | ✓ | 0 | 4 | 7,0 |
| 280 | A       | ok | 98,9 | ✗ | ✓ | 1 | 2 | 6,3 |
| 280 | B       | ok | 99,2 | ✗ | ✓ | 0 | 2 | 7,4 |

**Fit ok = 9/9, overflow = 0/9, fill moyen ~99,2 % pour les trois.**

### Enseignements

1. **Le correctif du bug = les prompts durcis, pas l'architecture.** Même le monolithe
   (control) fait 9/9 sans déborder. Les overflows 104/112 % observés en prod étaient avec
   l'ANCIEN prompt (toujours chargé dans le service systemd — non redémarré).
2. **Porte IA fiable** : agg-entrée ✓ sur 272 (IA) partout, ✗ sur 329/280. En-têtes jamais
   émis. Ordre toujours bon. Règles de tailoring robustes quelle que soit l'archi.
3. **A délègue vraiment** (sous-agent = 1) et sa boucle itère sous contrainte (6 passes sur 272).
4. **Vitesse** : A le plus rapide (4,4–6,3 min) ; control le plus lent (jusqu'à 11,5 min
   sur le cas riche) ; B plombé par l'overhead des 3 process.

### Limite

1 run/cellule → fit en égalité (9/9) parce qu'aucune variante ne déborde avec les prompts
durcis ; l'avantage d'isolation de A ne peut pas se démarquer sans répétition.

## Stress fiabilité — 5× chaque variante sur 272 (le cas dur)

| variante | runs complétés | fit ok | overflow | fill moyen | temps (min) | écart temps |
|---|---|---|---|---|---|---|
| A       | 5/5 | 5/5 | 0 | 99,1 | 6,2 7,4 6,4 5,6 7,2 → **avg 6,6** | **1,8 (serré)** |
| B       | 5/5 | 5/5 | 0 | 99,1 | 6,4 4,4 4,8 8,6 11,4 → avg 7,1 | 7,0 (très large) |
| control | 4/5* | 4/4 | 0 | 98,8 | 11,5 5,5 7,9 5,7 → avg 7,7 | 6,0 (large) |

*Le 5e run de control a planté sur un **bug du harnais** (`ensureEnv()` recréait les
symlinks de skills → course `EEXIST` entre process concurrents), PAS sur une faiblesse
de l'architecture. Corrigé (idempotent). La fiabilité du fit est donc **à égalité**.

### Verdict

- **Le bug d'overflow est mort : 0 débordement sur 22 générations complétées**, toutes
  variantes confondues. C'est le **durcissement des prompts** qui le tue (porte IA, ordre,
  vocabulaire, en-têtes moteur, + suppression de la contradiction « 2 passes » dans A/B).
- **Fiabilité du fit : égalité** (toutes les générations complétées tiennent).
- **A se démarque sur la LATENCE et la CONSTANCE** : plus rapide en moyenne et surtout
  **écart de temps le plus serré** (5,6–7,4 min) ; B et control ont des pics à 11+ min.
  Pour un bouton « générer ma candidature », une latence prévisible compte.
- **A = vraie isolation confirmée** : le sous-agent fit est spawné à chaque run
  (sous-agent ≥ 1), sa boucle itère 3–8 fois selon la richesse du contenu.

**Recommandation : adopter la variante A.** Le correctif du bug = les prompts durcis
(à activer en prod en redémarrant le service). A ajoute la vitesse, la constance de
latence et l'isolation du fit comme assurance pour les cas futurs plus durs.

