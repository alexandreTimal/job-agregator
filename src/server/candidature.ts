/**
 * Génération de candidature par offre (cf. docs/api-contract.md).
 *
 * Une « candidature » = un CV adapté (PDF) + une lettre de motivation, produits
 * pour une offre donnée par un agent `claude` lancé EN LOCAL sur l'abonnement de
 * l'utilisateur (mode headless `-p`, AUCUNE clé API). Le serveur spawn `claude`
 * comme un sous-process — exactement le patron du run pipeline (qui spawn `tsx`),
 * mais ici :
 *   - UNE candidature PAR OFFRE, indépendantes : plusieurs peuvent tourner en
 *     parallèle (pas de verrou global ; plafond de concurrence + file d'attente).
 *   - l'agent déroule les skills cv-tailoring + cv-render (boucle de fit) +
 *     lettre-motivation et écrit les fichiers dans `data/candidatures/<offerId>/`.
 *
 * État : en mémoire serveur (statut live par offre) + persistance best-effort
 * dans `meta.json` (pour retrouver `generatedAt`/`error` après redémarrage ;
 * `ready` se redéduit aussi de la présence des fichiers).
 *
 * Le contrôle humain est ASYNCHRONE (modèle « brouillon auto, revue dans l'UI ») :
 * l'agent décide seul (dosage IA selon le poste, coupes via la boucle --measure,
 * garde-fous d'honnêteté toujours actifs) ; l'utilisateur ouvre le PDF + la lettre
 * et relance si besoin.
 */
import type { FastifyReply } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { CandidatureEvent, CandidatureState, CandidatureStatus } from "../shared/types";
import { getOfferById } from "../store/sqlite";

/** Racine du dépôt (src/server/candidature.ts → ../../..). */
const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
/** Dossier des candidatures générées (sous data/, gitignored). */
const CANDIDATURES_DIR = resolve(PROJECT_ROOT, "data/candidatures");
/** Interpréteur Python du venv (weasyprint n'est pas dans le python système). */
const VENV_PY = resolve(PROJECT_ROOT, ".venv/bin/python");
/** Moteur de rendu du CV (data-driven, mode --measure). */
const GENERATE_CV = resolve(PROJECT_ROOT, "candidature-toolkit/skills/cv-render/generate_cv.py");

/**
 * Binaire `claude` à spawn. Le service systemd a un PATH minimal qui n'inclut PAS
 * `~/.local/bin` (où vit `claude`) : on résout donc explicitement (env d'abord,
 * puis emplacement utilisateur standard, puis repli sur le PATH).
 */
function resolveClaudeBin(): string {
  if (process.env.CANDIDATURE_CLAUDE_BIN) return process.env.CANDIDATURE_CLAUDE_BIN;
  const local = resolve(homedir(), ".local/bin/claude");
  if (existsSync(local)) return local;
  return "claude";
}
const CLAUDE_BIN = resolveClaudeBin();
/**
 * Modèle de l'agent. Défaut Sonnet : la tâche est très structurée (skills
 * déterministes + boucle de fit), Sonnet suffit et coûte ~5× moins de quota
 * qu'Opus. Surchargeable (`CANDIDATURE_MODEL=opus` pour les cas difficiles).
 */
const MODEL = process.env.CANDIDATURE_MODEL ?? "sonnet";
/** Nombre maximum de générations simultanées (ménage l'abonnement). */
const CONCURRENCY = Math.max(1, Number(process.env.CANDIDATURE_CONCURRENCY ?? 3));
/** Délai max d'une génération avant abandon (SIGTERM puis SIGKILL). */
const TIMEOUT_MS = Math.max(60_000, Number(process.env.CANDIDATURE_TIMEOUT_MS ?? 900_000));
/** Grâce avant escalade SIGKILL après un SIGTERM (timeout/annulation). */
const KILL_GRACE_MS = 5_000;
/** Intervalle du heartbeat SSE. */
const HEARTBEAT_MS = 15_000;

/**
 * Outils autorisés à l'agent headless (le strict nécessaire, pas de bypass total).
 * `Agent` est inclus pour DÉLÉGUER la mise en page à un sous-agent « fit » à contexte
 * court (cf. buildPrompt) : le banc d'essai `experiments/fit-bench/` a montré que cette
 * isolation donne la latence la plus rapide ET la plus constante, à fiabilité de fit égale.
 */
const ALLOWED_TOOLS = ["Skill", "Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "TodoWrite", "Agent"];

/**
 * Config MCP VIDE : avec `--strict-mcp-config`, l'agent ne charge AUCUN serveur
 * MCP. CRITIQUE pour le coût : sans ça, le headless hérite de tous les serveurs MCP
 * du projet (Canva, Notion, Gmail, Supabase, Vercel…) dont les schémas d'outils
 * gonflent le system prompt à ~170 k tokens, RELUS à chaque tour d'agent (→ millions
 * de tokens de cache pour une simple candidature). Vidé, le system prompt tombe à ~30 k.
 */
const EMPTY_MCP_CONFIG = resolve(CANDIDATURES_DIR, ".mcp-empty.json");
try {
  mkdirSync(CANDIDATURES_DIR, { recursive: true });
  writeFileSync(EMPTY_MCP_CONFIG, '{"mcpServers":{}}');
} catch {
  /* best-effort : si l'écriture échoue, le spawn signalera l'absence du fichier */
}

/** Les 3 skills dont l'agent a besoin (le reste du projet est inutile pour un CV). */
const CANDIDATURE_SKILLS = ["cv-tailoring", "cv-render", "lettre-motivation"];

/**
 * « Home » minimal de l'agent, HORS du repo : un dossier projet ne contenant QUE
 * les 3 skills candidature (en symlink) + un CLAUDE.md minuscule. En lançant
 * `claude` depuis ce home avec `--setting-sources project`, l'agent ne charge PAS
 * les 87 skills du projet (bmad/wds…), ni les 19 skills user (seo…), ni le gros
 * CLAUDE.md du repo : son system prompt tombe d'environ moitié (~36 k → ~18 k),
 * relu à chaque tour → ~moitié de tokens. Hors-repo pour éviter que `claude` ne
 * remonte aux CLAUDE.md ancêtres. `--add-dir PROJECT_ROOT` rouvre l'accès au venv
 * et aux dossiers de sortie. Repli sur le repo entier si la construction échoue.
 */
const AGENT_HOME = resolve(homedir(), ".cache/job-agregator/candidature-home");
let AGENT_HOME_READY = false;
function ensureAgentHome(): void {
  try {
    const skillsDir = resolve(AGENT_HOME, ".claude/skills");
    mkdirSync(skillsDir, { recursive: true });
    for (const name of CANDIDATURE_SKILLS) {
      const dst = resolve(skillsDir, name);
      try { rmSync(dst, { force: true, recursive: true }); } catch { /* lien absent */ }
      symlinkSync(resolve(PROJECT_ROOT, "candidature-toolkit/skills", name), dst, "dir");
    }
    writeFileSync(
      resolve(AGENT_HOME, "CLAUDE.md"),
      "# Home de l'agent candidature\n\nSeuls les skills cv-tailoring, cv-render, lettre-motivation sont disponibles ici.\n",
    );
    AGENT_HOME_READY = true;
  } catch {
    AGENT_HOME_READY = false; // repli : on lancera depuis le repo entier
  }
}
ensureAgentHome();

/** Chemins des artefacts d'une offre. */
function paths(offerId: number) {
  const dir = resolve(CANDIDATURES_DIR, String(offerId));
  return {
    dir,
    cv: resolve(dir, "cv.pdf"),
    lettre: resolve(dir, "lettre.md"),
    json: resolve(dir, "cv-offre.json"),
    meta: resolve(dir, "meta.json"),
  };
}

/** Métadonnées persistées d'une candidature (best-effort). */
interface CandidatureMeta {
  status: CandidatureStatus;
  generatedAt: string | null;
  error: string | null;
}

function readMeta(offerId: number): CandidatureMeta | null {
  const { meta } = paths(offerId);
  if (!existsSync(meta)) return null;
  try {
    return JSON.parse(readFileSync(meta, "utf8")) as CandidatureMeta;
  } catch {
    return null;
  }
}

function writeMeta(offerId: number, meta: CandidatureMeta): void {
  const p = paths(offerId);
  try {
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.meta, JSON.stringify(meta, null, 2), "utf8");
  } catch {
    /* persistance best-effort : un échec d'écriture ne casse pas la génération */
  }
}

/**
 * Construit le prompt autonome passé à `claude -p`. Tout est en chemins ABSOLUS
 * (l'agent headless ne peut rien deviner) : venv pour le rendu, dossier de sortie
 * par offre. Interdit toute question/validation : c'est un brouillon revu ensuite.
 */
function buildPrompt(
  offerId: number,
  offer: { title: string; company: string | null; url: string; location: string | null },
  instruction: string | undefined,
): string {
  const p = paths(offerId);
  const entreprise = offer.company ? ` · entreprise : ${offer.company}` : "";
  const lieu = offer.location ? ` · lieu : ${offer.location}` : "";
  const consigne = instruction?.trim()
    ? `\nCONSIGNE SUPPLÉMENTAIRE DE L'UTILISATEUR (à respecter) : ${instruction.trim()}\n`
    : "";
  return `Tu es en mode AUTONOME NON-INTERACTIF. N'utilise JAMAIS AskUserQuestion, ne demande aucune validation, ne t'arrête pas pour confirmer. Si un skill propose "montrer un récap avant de générer", saute cette étape. Va à l'essentiel : pas d'exploration superflue, pas de commentaires longs entre les actions.

TÂCHE : prépare la candidature complète d'Alexandre Timal pour cette offre.
- Intitulé : ${offer.title}${entreprise}${lieu}
- URL : ${offer.url}

RÉCUPÉRATION DE L'OFFRE — IMPORTANT (évite les boucles) :
- Fais UNE SEULE tentative WebFetch sur l'URL ci-dessus.
- Si elle renvoie peu ou rien (jobboard protégé), NE CHERCHE PAS l'annonce ailleurs (pas d'autres WebFetch, pas de WebSearch) : appuie-toi sur l'intitulé + l'entreprise + le lieu + ta compréhension du type de poste, signale dans le récap que l'annonce n'a pas pu être lue intégralement, et CONTINUE. Mieux vaut un brouillon que tu reverras qu'une chasse coûteuse.
${consigne}
DÉROULÉ (skills : cv-tailoring, cv-render, lettre-motivation) :
1. cv-tailoring : repositionne le CV dans le vocabulaire de l'annonce. Honnêteté OBLIGATOIRE : ne jamais inventer une compétence absente, jamais "Python"/"ML"/"RAG", signaler les gaps.
   DOSAGE IA — PORTE BINAIRE : l'agrégateur d'offres (projet perso IA) ne devient une ENTRÉE D'EXPÉRIENCE que si l'ANNONCE elle-même demande IA/GenAI/LLM/agents/ML/automatisation/data science dans ses missions ou son profil. Une entreprise qui "fait de l'IA quelque part" (practice Data/IA, secteur tech, mot "numérique" dans le titre) NE compte PAS. Par défaut (offre sans exigence IA explicite) : PAS d'entrée d'expérience pour l'agrégateur, au maximum UNE ligne dans Compétences.
   ORDRE DES EXPÉRIENCES : les expériences en cours (date finissant par "Present") d'abord, puis les terminées par récence décroissante. Ne jamais placer un projet en cours sous une expérience terminée plus ancienne.
   VOCABULAIRE : repère les termes exacts de l'annonce (ex. "cahier des charges", "comité de pilotage", "recette/homologation", "conduite du changement") et réinjecte-les MOT POUR MOT dans les puces là où c'est honnêtement vrai (un synonyme rate le scan recruteur).
   SOURCE DE VÉRITÉ UNIQUE : le fichier profil-master.md du skill. N'explore PAS le code de ce repo (src/, web/, CLAUDE.md…) pour "enrichir" une expérience : le projet "agrégateur d'offres / job-agregator" est l'outil qui te lance, décris-le UNIQUEMENT depuis profil-master.md, jamais en lisant son code.
   CLOISONNEMENT DES PROJETS : TrackMate (marketplace moto) et l'agrégateur d'offres (outillage perso) sont DEUX projets sans aucun rapport. Ne JAMAIS fusionner leurs faits : les détails de pipeline/agrégation/logs vont dans l'entrée "Projet personnel" dédiée, jamais dans une puce TrackMate.
2. cv-render (CONTENU SEULEMENT) : écris le JSON adapté dans ${p.json}. N'émets PAS les en-têtes de section (h_exp/h_form/h_dist/h_comp/h_int) : le moteur les pose avec l'orthographe correcte, les retaper introduit des fautes. NE LANCE NI --measure NI le rendu toi-même : la mise en page est DÉLÉGUÉE (étape 3). Le dossier peut contenir d'anciens fichiers d'une génération précédente : NE les ouvre PAS, écris par-dessus.
   Calibre le volume sur le CV maître (~70 lignes : expérience ~26, distinctions ~8, compétences ~8, formation ~6, intérêts ~4) pour partir près de la cible.
3. MISE EN PAGE — DÉLÈGUE À UN SOUS-AGENT : appelle l'outil Agent (subagent_type "general-purpose") avec EXACTEMENT le prompt ci-dessous, et ATTENDS qu'il termine (il aura mesuré, ajusté le contenu et rendu ${p.cv}). Ne fais PAS la boucle de fit toi-même.
---DÉBUT DU PROMPT DU SOUS-AGENT---
Tu es un SPÉCIALISTE DE MISE EN PAGE de CV. Mission unique : faire que le CV décrit par le JSON ${p.json} tienne sur 1 page, remplissage 94–100 %, puis le rendre en PDF.
OUTIL DE MESURE (déterministe) : ${VENV_PY} ${GENERATE_CV} ${p.json} --measure → JSON : status ("ok" | "overflow" | "underfull"), fits, header_fits, fill_ratio (1.0 = 100 %), overflow_lines, slack_lines, advice.
PROTOCOLE STRICT — boucle SANS LIMITE de passes :
1) Mesure.
2) Si status == "overflow" : coupe AU MOINS (overflow_lines + 1) lignes dans les puces LES MOINS pertinentes pour l'offre — condense, ne supprime jamais un fait entier ; coupe FRANCHE d'un coup. Si status == "underfull" : RALLONGE les puces les plus pertinentes avec du détail réel issu de profil-master.md (jamais broder ni inventer). Si header_fits == false : raccourcis le champ sub1 (titre).
3) Re-mesure. Répète tant que status != "ok" OU header_fits != true.
INTERDICTION ABSOLUE : ne lance JAMAIS le rendu PDF tant que ta DERNIÈRE mesure n'est pas status=="ok" ET header_fits==true. Il n'y a AUCUN nombre maximum de passes ; continue jusqu'à ok.
Quand (et seulement quand) la dernière mesure est ok : rends le PDF : ${VENV_PY} ${GENERATE_CV} ${p.json} --out ${p.cv}
Tu ne touches qu'au CONTENU des puces, jamais aux faits ; tu n'inventes rien.
---FIN DU PROMPT DU SOUS-AGENT---
4. lettre-motivation : lettre ~300-350 mots, français, ton direct, chaque affirmation adossée à une expérience réelle, pas de tiret cadratin. Écris-la dans ${p.lettre}.

SORTIES OBLIGATOIRES (écris réellement ces fichiers) : ${p.json} ; ${p.cv} (rendu par le sous-agent) ; ${p.lettre}
Termine par un récap de 3 lignes : remplissage du CV, dosage IA, gaps éventuels.`;
}

/** Une génération en cours (process + minuteries + dernières lignes de stderr). */
interface Running {
  child: ChildProcess;
  timeout: ReturnType<typeof setTimeout>;
  killTimer: ReturnType<typeof setTimeout> | null;
  /** Fin de la sortie d'erreur de l'agent, gardée pour expliquer un échec. */
  stderrTail: string;
}

/**
 * Gestionnaire de candidatures : file + plafond de concurrence + diffusion SSE.
 * État live en mémoire (statut par offre) ; persistance dans meta.json.
 */
class CandidatureManager {
  /** Statut live par offre (source de vérité pour queued/generating/failed). */
  private live = new Map<number, CandidatureState>();
  /** Process en cours, par offre. */
  private running = new Map<number, Running>();
  /** File d'attente (offres en `queued`, dans l'ordre de demande). */
  private queue: number[] = [];
  /** Abonnés au flux SSE global des changements d'état. */
  private subscribers = new Set<FastifyReply>();

  /** État courant d'une offre : live si connu, sinon redéduit du disque. */
  getState(offerId: number): CandidatureState {
    const live = this.live.get(offerId);
    if (live) return { ...live, ...this.fileFlags(offerId) };
    return this.fromDisk(offerId);
  }

  /** Drapeaux cvReady/lettreReady lus sur le disque. */
  private fileFlags(offerId: number): { cvReady: boolean; lettreReady: boolean } {
    const p = paths(offerId);
    return { cvReady: existsSync(p.cv), lettreReady: existsSync(p.lettre) };
  }

  /** État reconstruit depuis le disque (après redémarrage serveur). */
  private fromDisk(offerId: number): CandidatureState {
    const flags = this.fileFlags(offerId);
    const meta = readMeta(offerId);
    const ready = flags.cvReady && flags.lettreReady;
    return {
      offerId,
      status: ready ? "ready" : meta?.status === "failed" ? "failed" : "none",
      cvReady: flags.cvReady,
      lettreReady: flags.lettreReady,
      generatedAt: meta?.generatedAt ?? null,
      error: meta?.status === "failed" ? meta?.error ?? null : null,
    };
  }

  /**
   * Demande la génération de la candidature d'une offre. Idempotent tant qu'une
   * génération est en cours/attente pour cette offre (renvoie l'état courant sans
   * relancer). Sur `none`/`ready`/`failed`, (re)lance une génération.
   */
  request(offerId: number, instruction?: string): CandidatureState {
    const current = this.getState(offerId);
    if (current.status === "generating" || current.status === "queued") {
      return current; // déjà en route : pas de doublon
    }
    if (instruction?.trim()) this.pendingInstruction.set(offerId, instruction.trim());
    const queued: CandidatureState = {
      offerId,
      status: "queued",
      cvReady: current.cvReady,
      lettreReady: current.lettreReady,
      generatedAt: current.generatedAt,
      error: null,
    };
    this.setState(queued);
    this.queue.push(offerId);
    this.pump();
    return queued;
  }

  /** Met à jour l'état live d'une offre et diffuse l'événement SSE. */
  private setState(state: CandidatureState, phase?: string): void {
    this.live.set(state.offerId, state);
    const event: CandidatureEvent = phase ? { ...state, phase } : { ...state };
    this.broadcast(event);
  }

  /** Démarre autant de générations en attente que le plafond le permet. */
  private pump(): void {
    while (this.running.size < CONCURRENCY && this.queue.length > 0) {
      const offerId = this.queue.shift()!;
      // Une offre peut avoir été re-demandée et déjà retirée : on ignore les
      // doublons éventuels (statut déjà generating).
      if (this.running.has(offerId)) continue;
      this.spawn(offerId);
    }
  }

  /** Spawn `claude -p` pour une offre et câble son cycle de vie. */
  private spawn(offerId: number): void {
    const offer = getOfferById(offerId);
    if (!offer) {
      this.fail(offerId, "offre inconnue");
      return;
    }
    const p = paths(offerId);
    try {
      mkdirSync(p.dir, { recursive: true });
    } catch {
      /* le spawn échouera plus loin si le dossier est vraiment inaccessible */
    }

    const instruction = this.pendingInstruction.get(offerId);
    this.pendingInstruction.delete(offerId);
    const prompt = buildPrompt(offerId, offer, instruction);

    this.setState(
      { offerId, status: "generating", cvReady: existsSync(p.cv), lettreReady: existsSync(p.lettre), generatedAt: this.live.get(offerId)?.generatedAt ?? null, error: null },
      "génération en cours (cv-tailoring → rendu → lettre)",
    );

    let child: ChildProcess;
    try {
      // detached: leader de groupe → on peut tuer toute la chaîne au timeout.
      // Home minimal si dispo (system prompt ~÷2), sinon repli sur le repo entier.
      const cwd = AGENT_HOME_READY ? AGENT_HOME : PROJECT_ROOT;
      const homeArgs = AGENT_HOME_READY
        ? ["--setting-sources", "project", "--add-dir", PROJECT_ROOT]
        : [];
      child = spawn(
        CLAUDE_BIN,
        [
          "-p", prompt,
          "--allowedTools", ...ALLOWED_TOOLS,
          "--permission-mode", "acceptEdits",
          // Environnement DÉPOUILLÉ (coût) : aucun serveur MCP, pas de Chrome, Sonnet,
          // et (si home minimal) seulement les 3 skills candidature.
          "--strict-mcp-config", "--mcp-config", EMPTY_MCP_CONFIG,
          "--no-chrome",
          "--model", MODEL,
          ...homeArgs,
          "--output-format", "text",
        ],
        { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true },
      );
    } catch (err) {
      this.fail(offerId, err instanceof Error ? err.message : "spawn impossible");
      this.pump();
      return;
    }

    const timeout = setTimeout(() => this.signal(offerId, "SIGTERM", true), TIMEOUT_MS);
    if (typeof timeout.unref === "function") timeout.unref();
    const rec: Running = { child, timeout, killTimer: null, stderrTail: "" };
    this.running.set(offerId, rec);

    // stdout/stderr : journalisés côté serveur (le récap final n'est pas rediffusé).
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => process.stderr.write(`[candidature ${offerId}] ${c}`));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      process.stderr.write(`[candidature ${offerId}!] ${c}`);
      rec.stderrTail = (rec.stderrTail + c).slice(-1200); // on garde la fin pour diagnostiquer un échec
    });

    child.on("error", (err) => this.finish(offerId, err.message));
    child.on("close", (code) => this.finish(offerId, code === 0 ? null : `code ${code ?? "inconnu"}`));
  }

  /** Instructions de relance en attente d'un spawn (consommées au démarrage). */
  private pendingInstruction = new Map<number, string>();

  /** Fin d'une génération : succès si les fichiers existent, sinon échec. */
  private finish(offerId: number, errReason: string | null): void {
    const rec = this.running.get(offerId);
    if (!rec) return; // déjà fini (double close/error)
    clearTimeout(rec.timeout);
    if (rec.killTimer) clearTimeout(rec.killTimer);
    const stderrTail = rec.stderrTail;
    this.running.delete(offerId);

    const flags = this.fileFlags(offerId);
    const ok = flags.cvReady && flags.lettreReady;
    if (ok) {
      const generatedAt = new Date().toISOString();
      const state: CandidatureState = { offerId, status: "ready", cvReady: true, lettreReady: true, generatedAt, error: null };
      writeMeta(offerId, { status: "ready", generatedAt, error: null });
      this.setState(state);
    } else {
      // Dernières lignes de stderr de l'agent (les plus parlantes) pour expliquer l'échec.
      const tail = stderrTail.replace(/\s+/g, " ").trim().slice(-280);
      const base = errReason
        ? `génération échouée (${errReason})`
        : "génération terminée mais fichiers manquants (CV ou lettre)";
      this.fail(offerId, tail ? `${base} : ${tail}` : base, flags);
    }
    this.pump();
  }

  /** Marque une offre en échec (état + persistance). */
  private fail(offerId: number, message: string, flags?: { cvReady: boolean; lettreReady: boolean }): void {
    const f = flags ?? this.fileFlags(offerId);
    const generatedAt = this.live.get(offerId)?.generatedAt ?? readMeta(offerId)?.generatedAt ?? null;
    const state: CandidatureState = { offerId, status: "failed", cvReady: f.cvReady, lettreReady: f.lettreReady, generatedAt, error: message };
    writeMeta(offerId, { status: "failed", generatedAt, error: message });
    this.setState(state);
  }

  /** Envoie un signal au GROUPE du process (timeout/annulation), avec escalade. */
  private signal(offerId: number, sig: NodeJS.Signals, escalate: boolean): void {
    const rec = this.running.get(offerId);
    if (!rec) return;
    const pid = rec.child.pid;
    try {
      if (typeof pid === "number") process.kill(-pid, sig);
      else rec.child.kill(sig);
    } catch {
      try { rec.child.kill(sig); } catch { /* déjà mort */ }
    }
    if (escalate && !rec.killTimer) {
      rec.killTimer = setTimeout(() => this.signal(offerId, "SIGKILL", false), KILL_GRACE_MS);
      if (typeof rec.killTimer.unref === "function") rec.killTimer.unref();
    }
  }

  /* --------------------------- SSE --------------------------- */

  /** Abonne un flux SSE : envoie d'abord un instantané des candidatures actives. */
  subscribe(reply: FastifyReply): void {
    for (const state of this.live.values()) {
      this.send(reply, { ...state, ...this.fileFlags(state.offerId) });
    }
    this.subscribers.add(reply);
    reply.raw.on("close", () => this.subscribers.delete(reply));
  }

  private send(reply: FastifyReply, event: CandidatureEvent): void {
    if (reply.raw.writableEnded) return;
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private broadcast(event: CandidatureEvent): void {
    for (const reply of this.subscribers) this.send(reply, event);
  }

  /**
   * Tue toutes les générations en cours. À appeler à l'ARRÊT du serveur : les
   * process `claude` sont `detached` (groupe à part pour le kill au timeout), donc
   * ils SURVIVRAIENT au redémarrage du service sans ça — devenant orphelins, et au
   * redémarrage suivant le manager (état mémoire reparti de zéro, fichiers « ready »
   * sur disque) en spawnerait un doublon. On coupe net à l'arrêt.
   */
  shutdownAll(): void {
    for (const offerId of [...this.running.keys()]) {
      this.signal(offerId, "SIGTERM", false);
    }
  }
}

export const candidatureManager = new CandidatureManager();
export { paths as candidaturePaths, HEARTBEAT_MS };
