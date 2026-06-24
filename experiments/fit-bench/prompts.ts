/**
 * Prompts du banc d'essai. Le tronc (décodage offre + règles de tailoring durcies)
 * est commun ; seule la GESTION DU FIT change entre variantes :
 *  - control : monolithe de prod (boucle --measure dans le même agent, plafond 2 passes).
 *  - A / B   : brief « fit » isolé (contexte court, mono-tâche, boucle SANS plafond).
 */
import { VENV_PY, GENERATE_CV, type Offer } from "./lib.ts";

export interface Paths { json: string; cv: string; lettre: string; }

const NONINTERACTIVE =
  `Tu es en mode AUTONOME NON-INTERACTIF. N'utilise JAMAIS AskUserQuestion, ne demande aucune validation, ne t'arrête pas pour confirmer. Va à l'essentiel : pas d'exploration superflue, pas de commentaires longs entre les actions.`;

function offerBlock(offer: Offer): string {
  const entreprise = offer.company ? ` · entreprise : ${offer.company}` : "";
  const lieu = offer.location ? ` · lieu : ${offer.location}` : "";
  return `- Intitulé : ${offer.title}${entreprise}${lieu}
- URL : ${offer.url}

RÉCUPÉRATION DE L'OFFRE (évite les boucles) : UNE SEULE tentative WebFetch sur l'URL. Si elle renvoie peu/rien (jobboard protégé), NE CHERCHE PAS ailleurs : appuie-toi sur l'intitulé + entreprise + lieu + ta compréhension du poste, et CONTINUE.`;
}

const TAILORING = `cv-tailoring : repositionne le CV dans le vocabulaire de l'annonce. Honnêteté OBLIGATOIRE : ne jamais inventer une compétence absente, jamais "Python"/"ML"/"RAG", signaler les gaps.
SOURCE DE VÉRITÉ UNIQUE : le profil-master.md du skill. N'explore PAS le code de ce repo pour "enrichir" une expérience.
CLOISONNEMENT : TrackMate (marketplace moto) et l'agrégateur d'offres (outillage perso) sont DEUX projets distincts, ne jamais fusionner leurs faits.
DOSAGE IA — PORTE BINAIRE : l'agrégateur d'offres ne devient une ENTRÉE D'EXPÉRIENCE que si l'ANNONCE demande explicitement IA/GenAI/LLM/agents/ML/automatisation. Sinon : PAS d'entrée d'expérience, au maximum UNE ligne dans Compétences.
ORDRE : expériences en cours (date finissant par "Présent") d'abord, puis terminées par récence décroissante.
VOCABULAIRE : réinjecte MOT POUR MOT les termes de l'annonce (ex. "cahier des charges", "comité de pilotage", "recette/homologation", "conduite du changement") là où c'est honnêtement vrai.
EN-TÊTES : n'émets PAS les champs h_exp/h_form/h_dist/h_comp/h_int dans le JSON (le moteur les pose avec l'orthographe correcte).`;

/** Brief « fit » ISOLÉ (variantes A/B) : mono-tâche, boucle sans plafond, le rendu est verrouillé tant que la dernière mesure n'est pas ok. */
export function fitBrief(p: Paths): string {
  return `Tu es un SPÉCIALISTE DE MISE EN PAGE de CV. Mission unique : faire que le CV décrit par le JSON ${p.json} tienne sur 1 page, remplissage 94–100 %, puis le rendre en PDF.

OUTIL DE MESURE (déterministe) : ${VENV_PY} ${GENERATE_CV} ${p.json} --measure
→ renvoie un JSON : status ("ok" | "overflow" | "underfull"), fits (bool), header_fits (bool), fill_ratio (1.0 = 100 %), overflow_lines, slack_lines, advice.

PROTOCOLE STRICT — boucle SANS LIMITE de passes :
1. Mesure.
2. Si status == "overflow" : coupe AU MOINS (overflow_lines + 1) lignes dans les puces LES MOINS pertinentes pour l'offre — condense, ne supprime jamais un fait entier. Fais une coupe FRANCHE d'un coup (over-couper légèrement vaut mieux que sous-couper).
   Si status == "underfull" : RALLONGE les puces les plus pertinentes avec du détail réel issu de profil-master.md (chiffres, précisions). Jamais broder ni inventer.
   Si header_fits == false : raccourcis le champ sub1 (titre).
3. Re-mesure. Répète tant que status != "ok" OU header_fits != true.
INTERDICTION ABSOLUE : ne lance JAMAIS le rendu PDF tant que ta DERNIÈRE mesure ne renvoie pas status=="ok" ET header_fits==true. Il n'y a pas de nombre maximum de passes ; continue jusqu'à ok.

Quand (et seulement quand) la dernière mesure est ok : rends le PDF :
${VENV_PY} ${GENERATE_CV} ${p.json} --out ${p.cv}
Tu ne touches qu'au CONTENU des puces, jamais aux faits ; tu n'inventes rien.`;
}

const LETTER = (p: Paths) =>
  `lettre-motivation : lettre ~300-350 mots, français, ton direct, chaque affirmation adossée à une expérience réelle, pas de tiret cadratin. Écris-la dans ${p.lettre}.`;

/** CONTROL = monolithe de prod (avec budget + boucle dans le même agent, plafond 2 passes). */
export function buildControlPrompt(offer: Offer, p: Paths): string {
  return `${NONINTERACTIVE}

TÂCHE : prépare la candidature complète d'Alexandre Timal pour cette offre.
${offerBlock(offer)}

DÉROULÉ (skills : cv-tailoring, cv-render, lettre-motivation) :
1. ${TAILORING}
2. cv-render : écris le JSON adapté dans ${p.json}. N'ouvre PAS d'anciens fichiers, écris par-dessus.
   BUDGET DE PAGE : le CV doit faire 1 page pleine (94–100 %). Le CV maître fait ~70 lignes (expérience ~26, distinctions ~8, compétences ~8, formation ~6, intérêts ~4). Calibre ton JSON sur ce volume pour rentrer DU PREMIER COUP.
   Puis : lance --measure UNE fois (${VENV_PY} ${GENERATE_CV} ${p.json} --measure). Applique le conseil en UN edit franc. Re-mesure UNE fois. AU PLUS 2 passes : ne rends JAMAIS tant que --measure renvoie "fits": false. Vise "fits": true à 94–100 %.
   Rendu : ${VENV_PY} ${GENERATE_CV} ${p.json} --out ${p.cv}
3. ${LETTER(p)}

SORTIES OBLIGATOIRES : ${p.json} ; ${p.cv} ; ${p.lettre}`;
}

/** VARIANTE A = un seul agent, mais il DÉLÈGUE le fit à un sous-agent (outil Agent). */
export function buildVariantAPrompt(offer: Offer, p: Paths): string {
  return `${NONINTERACTIVE}

TÂCHE : prépare la candidature complète d'Alexandre Timal pour cette offre.
${offerBlock(offer)}

DÉROULÉ :
1. ${TAILORING}
2. cv-render (CONTENU SEULEMENT) : écris le JSON adapté dans ${p.json}. NE LANCE NI --measure NI le rendu toi-même : tu n'as pas à gérer la mise en page.
3. DÉLÈGUE LA MISE EN PAGE À UN SOUS-AGENT : appelle l'outil Agent (subagent_type "general-purpose") avec EXACTEMENT ce prompt, et attends qu'il termine (il aura mesuré, ajusté et rendu ${p.cv}) :
---DÉBUT DU PROMPT DU SOUS-AGENT---
${fitBrief(p)}
---FIN DU PROMPT DU SOUS-AGENT---
4. ${LETTER(p)}

SORTIES OBLIGATOIRES : ${p.json} ; ${p.cv} (rendu par le sous-agent) ; ${p.lettre}`;
}

/** VARIANTE B = 3 process chaînés. Chaque prompt tourne dans un `claude -p` séparé. */
export function buildVariantB_tailoring(offer: Offer, p: Paths): string {
  return `${NONINTERACTIVE}

TÂCHE : produis UNIQUEMENT le CONTENU du CV d'Alexandre Timal (JSON), adapté à cette offre. NE mesure PAS, NE rends PAS de PDF, N'écris PAS de lettre — une autre étape s'en charge.
${offerBlock(offer)}

1. ${TAILORING}
2. Écris le JSON adapté dans ${p.json} (et rien d'autre). N'ouvre pas d'ancien fichier, écris par-dessus.

SORTIE OBLIGATOIRE : ${p.json}`;
}
export function buildVariantB_fit(p: Paths): string {
  return `${NONINTERACTIVE}\n\n${fitBrief(p)}\n\nSORTIE OBLIGATOIRE : ${p.cv}`;
}
export function buildVariantB_letter(offer: Offer, p: Paths): string {
  return `${NONINTERACTIVE}

TÂCHE : rédige UNIQUEMENT la lettre de motivation d'Alexandre Timal pour cette offre.
${offerBlock(offer)}

Le CV adapté est déjà dans ${p.json} (tu peux le lire pour t'aligner).
${LETTER(p)}

SORTIE OBLIGATOIRE : ${p.lettre}`;
}
