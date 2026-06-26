/**
 * Page Paramètres.
 *
 * Pilote la table sqlite `settings` via le client API typé :
 *   - `terms[]`          : termes de recherche (ajout / suppression).
 *   - `contractTypes`    : interrupteurs parmi "stage" et "CDI".
 *   - `salaryMin`        : salaire annuel minimum (0 = sans minimum).
 *   - `locations[]`      : villes acceptées (+ `remoteOk` pour le télétravail).
 *   - `enabledSources[]` : interrupteurs par jobboard connu.
 *
 * Chargement via GET /api/settings, sauvegarde via PUT /api/settings.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  X,
  Tags,
  Ban,
  FileSignature,
  Globe,
  TriangleAlert,
  Check,
  Save,
  CalendarClock,
  Banknote,
  MapPin,
  Layers,
  Pencil,
  Trash2,
} from "lucide-react";
import type { Settings, SearchProfileMeta } from "../../src/shared/types";
import { apiClient } from "../lib/api-client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Catalogue des types de contrat proposés par l'UI.
 * Source de vérité : contrat d'API (`contractTypes` ∈ {"stage", "CDI"}).
 */
const CONTRACT_TYPES = [
  { value: "stage", label: "Stage", hint: "Conventions de stage." },
  { value: "CDI", label: "CDI", hint: "Contrats à durée indéterminée." },
] as const;

/**
 * Catalogue des sources connues (= registry `src/sources/registry.ts`).
 * Une source présente dans `settings.enabledSources` mais absente du catalogue
 * reste affichée (cf. `sourceCatalog` plus bas) pour ne jamais la "perdre".
 */
const KNOWN_SOURCES: { name: string; label: string; ats?: boolean }[] = [
  { name: "wttj", label: "Welcome to the Jungle" },
  { name: "hellowork", label: "HelloWork" },
  { name: "linkedin", label: "LinkedIn" },
  { name: "jobteaser", label: "JobTeaser" },
  { name: "greenhouse", label: "Greenhouse (pages carrières)", ats: true },
  { name: "lever", label: "Lever (pages carrières)", ats: true },
];

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Déduplique une liste de termes de façon insensible à la casse, en
 * conservant le premier libellé rencontré et son ordre d'apparition.
 */
function dedupeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/* Logo de source avec repli monogramme. */
function SourceLogo({ source }: { source: string }) {
  const [casse, setCasse] = useState(false);
  return (
    <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-black/30">
      {casse ? (
        <span className="font-[family-name:var(--font-mono)] text-xs font-semibold uppercase text-[var(--color-ink-mute)]">
          {source.slice(0, 2)}
        </span>
      ) : (
        <img
          src={`/logos/${source}.svg`}
          alt=""
          width={22}
          height={22}
          className="size-[22px] object-contain"
          onError={() => setCasse(true)}
        />
      )}
    </div>
  );
}

function SectionTitle({
  icon,
  title,
  hint,
  id,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  id?: string;
}) {
  return (
    <div className="mb-5">
      <h2
        id={id}
        className="flex items-center gap-2.5 text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink-mute)] [&_svg]:size-4 [&_svg]:text-[var(--color-ink-faint)]"
      >
        <span aria-hidden="true" className="contents">
          {icon}
        </span>
        {title}
      </h2>
      <p className="mt-1.5 text-[0.85rem] text-[var(--color-ink-mute)]">{hint}</p>
    </div>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [newTerm, setNewTerm] = useState("");
  /** Saisie en cours du champ « Ajouter un mot banni » (titleBlacklist). */
  const [newBan, setNewBan] = useState("");
  /** Saisie en cours du champ « Ajouter un board », indexée par nom de source ATS. */
  const [boardDrafts, setBoardDrafts] = useState<Record<string, string>>({});
  /** Brouillon string du champ ancienneté (autorise un champ vide pendant l'édition). */
  const [ageDraft, setAgeDraft] = useState("");
  /** Brouillon string du champ salaire minimum (autorise un champ vide pendant l'édition). */
  const [salaryDraft, setSalaryDraft] = useState("");
  /** Saisie en cours du champ « Ajouter une ville ». */
  const [newLocation, setNewLocation] = useState("");
  /** Vrai dès qu'une modification non sauvegardée existe (évite un message trompeur au 1er chargement). */
  const [dirty, setDirty] = useState(false);
  /** Profils de recherche connus (vue allégée) + id du profil actif. */
  const [profiles, setProfiles] = useState<SearchProfileMeta[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>("");
  /** Vrai pendant la bascule de profil (persiste + recharge les critères). */
  const [switching, setSwitching] = useState(false);
  /** Saisie du champ « Nouveau profil ». */
  const [newProfileName, setNewProfileName] = useState("");
  /** Mode renommage du profil actif (champ inline) + brouillon. */
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  /** Pour rendre le focus au champ d'ajout après suppression d'un chip de terme. */
  const addInputRef = useRef<HTMLInputElement>(null);
  /** Idem pour le champ d'ajout de mot banni. */
  const addBanRef = useRef<HTMLInputElement>(null);
  /** Idem pour le champ d'ajout de ville. */
  const addLocationRef = useRef<HTMLInputElement>(null);

  /**
   * Applique une config fraîchement chargée dans l'état local (dédup + brouillons
   * numériques). Factorisé car réutilisé au montage, à la bascule et à la
   * suppression de profil.
   */
  function applyLoadedSettings(s: Settings): void {
    setSettings({
      ...s,
      terms: dedupeTerms(s.terms),
      titleBlacklist: dedupeTerms(s.titleBlacklist ?? []),
      atsBoards: s.atsBoards ?? {},
    });
    setAgeDraft(String(s.maxOfferAgeDays));
    setSalaryDraft(String(s.salaryMin));
  }

  /* Chargement initial : configuration effective (profil actif) + liste des profils. */
  useEffect(() => {
    let cancelled = false;
    Promise.all([apiClient.getSettings(), apiClient.getProfiles()])
      .then(([s, p]) => {
        if (cancelled) return;
        applyLoadedSettings(s);
        setProfiles(p.profiles);
        setActiveProfileId(p.activeProfileId);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Échec du chargement des paramètres",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sourceCatalog = useMemo(() => {
    if (!settings) return KNOWN_SOURCES;
    const extra = settings.enabledSources
      .filter((name) => !KNOWN_SOURCES.some((s) => s.name === name))
      .map((name) => ({ name, label: name }));
    return [...KNOWN_SOURCES, ...extra];
  }, [settings]);

  function patch(next: Settings): void {
    setSettings(next);
    setSaveState("idle");
    setDirty(true);
  }

  function addTerm(): void {
    if (!settings) return;
    const trimmed = newTerm.trim();
    if (!trimmed) return;
    patch({ ...settings, terms: dedupeTerms([...settings.terms, trimmed]) });
    setNewTerm("");
  }

  function removeTerm(index: number): void {
    if (!settings) return;
    patch({
      ...settings,
      terms: settings.terms.filter((_, i) => i !== index),
    });
    // Le chip supprimé disparaît du DOM : on évite de perdre le focus sur <body>
    // en le rendant au champ d'ajout.
    addInputRef.current?.focus();
  }

  function addBan(): void {
    if (!settings) return;
    const trimmed = newBan.trim();
    if (!trimmed) return;
    patch({ ...settings, titleBlacklist: dedupeTerms([...settings.titleBlacklist, trimmed]) });
    setNewBan("");
  }

  function removeBan(index: number): void {
    if (!settings) return;
    patch({
      ...settings,
      titleBlacklist: settings.titleBlacklist.filter((_, i) => i !== index),
    });
    // Cf. removeTerm : on ne perd pas le focus sur <body> quand le chip disparaît.
    addBanRef.current?.focus();
  }

  function toggleContractType(value: string): void {
    if (!settings) return;
    const active = settings.contractTypes.includes(value);
    const contractTypes = active
      ? settings.contractTypes.filter((c) => c !== value)
      : [...settings.contractTypes, value];
    patch({ ...settings, contractTypes });
  }

  function addBoard(source: string, raw: string): void {
    if (!settings) return;
    const token = raw.trim();
    if (!token) return;
    const current = settings.atsBoards[source] ?? [];
    if (current.some((b) => b.toLowerCase() === token.toLowerCase())) return;
    patch({
      ...settings,
      atsBoards: { ...settings.atsBoards, [source]: [...current, token] },
    });
  }

  function removeBoard(source: string, index: number): void {
    if (!settings) return;
    const current = settings.atsBoards[source] ?? [];
    patch({
      ...settings,
      atsBoards: { ...settings.atsBoards, [source]: current.filter((_, i) => i !== index) },
    });
  }

  /**
   * Met à jour l'ancienneté max depuis la saisie brute. On garde un brouillon
   * `string` distinct pour autoriser un champ visuellement VIDE pendant l'édition
   * (vider pour retaper ne doit pas claquer la valeur à 0 sous les doigts). Une
   * saisie vide / invalide / ≤ 0 vaut 0 = sans limite ; sinon entier de jours.
   */
  function onAgeChange(raw: string): void {
    setAgeDraft(raw);
    if (!settings) return;
    const n = raw.trim() === "" ? 0 : Number(raw);
    const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    patch({ ...settings, maxOfferAgeDays: next });
  }

  /** Salaire minimum annuel. Brouillon string distinct (cf. `onAgeChange`) ;
   *  vide/invalide/≤ 0 → 0 = sans minimum, sinon entier d'euros. */
  function onSalaryChange(raw: string): void {
    setSalaryDraft(raw);
    if (!settings) return;
    const n = raw.trim() === "" ? 0 : Number(raw);
    const next = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    patch({ ...settings, salaryMin: next });
  }

  function addLocation(): void {
    if (!settings) return;
    const trimmed = newLocation.trim();
    if (!trimmed) return;
    // « remote » est réservé à l'interrupteur Télétravail : on ne l'ajoute pas en ville.
    if (trimmed.toLowerCase() === "remote") {
      setNewLocation("");
      return;
    }
    const exists = settings.locations.some((l) => l.toLowerCase() === trimmed.toLowerCase());
    patch({ ...settings, locations: exists ? settings.locations : [...settings.locations, trimmed] });
    setNewLocation("");
  }

  function removeLocation(index: number): void {
    if (!settings) return;
    patch({ ...settings, locations: settings.locations.filter((_, i) => i !== index) });
    // Cf. removeTerm : on ne perd pas le focus sur <body> quand le chip disparaît.
    addLocationRef.current?.focus();
  }

  function toggleRemote(): void {
    if (!settings) return;
    patch({ ...settings, remoteOk: !settings.remoteOk });
  }

  function toggleSource(name: string): void {
    if (!settings) return;
    const active = settings.enabledSources.includes(name);
    const enabledSources = active
      ? settings.enabledSources.filter((s) => s !== name)
      : [...settings.enabledSources, name];
    patch({ ...settings, enabledSources });
  }

  /**
   * Garde-fous : une config sans aucune source active OU sans aucun type de
   * contrat rend tout run silencieusement inerte. Le contrat n'interdit pas les
   * tableaux vides, mais l'UI prévient l'utilisateur et bloque l'enregistrement.
   */
  const configWarnings = useMemo(() => {
    if (!settings) return [];
    const warnings: string[] = [];
    if (settings.enabledSources.length === 0) {
      warnings.push("Aucune source active : aucun run n'interrogera de jobboard.");
    }
    if (settings.contractTypes.length === 0) {
      warnings.push("Aucun type de contrat : aucune offre ne sera retenue.");
    }
    return warnings;
  }, [settings]);

  const canSave = settings !== null && configWarnings.length === 0;

  async function save(): Promise<void> {
    if (!settings || !canSave) return;
    setSaveState("saving");
    try {
      await apiClient.setSettings(settings);
      setSaveState("saved");
      setDirty(false);
    } catch {
      setSaveState("error");
    }
  }

  const activeProfileName =
    profiles.find((p) => p.id === activeProfileId)?.name ?? "";

  /**
   * Bascule le profil actif. Les critères édités appartiennent au profil COURANT :
   * on persiste d'abord les modifications non enregistrées (sinon on les perdrait),
   * puis on active le profil cible et on recharge SES critères.
   */
  async function switchProfile(id: string): Promise<void> {
    if (switching || id === activeProfileId || !settings) return;
    setSwitching(true);
    try {
      if (dirty) await apiClient.setSettings(settings);
      await apiClient.activateProfile(id);
      // Le serveur a basculé : on reflète l'actif TOUT DE SUITE, pour ne pas
      // risquer d'éditer/sauver ensuite dans le mauvais profil si le rechargement
      // des critères échoue derrière.
      setActiveProfileId(id);
      const s = await apiClient.getSettings();
      applyLoadedSettings(s);
      setDirty(false);
      setSaveState("idle");
    } catch {
      setSaveState("error");
      // Resynchronise l'actif affiché avec la vérité serveur (best-effort).
      try {
        const p = await apiClient.getProfiles();
        setProfiles(p.profiles);
        setActiveProfileId(p.activeProfileId);
      } catch {
        /* garde l'état courant */
      }
    } finally {
      setSwitching(false);
    }
  }

  async function createProfile(): Promise<void> {
    const name = newProfileName.trim();
    if (!name || switching || !settings) return;
    try {
      // Le clone serveur part du profil actif EN BASE : on persiste d'abord les
      // éditions à l'écran pour que le nouveau profil reprenne ce que l'on voit.
      if (dirty) {
        await apiClient.setSettings(settings);
        setDirty(false);
      }
      const meta = await apiClient.createProfile(name);
      setProfiles((ps) => [...ps, meta]);
      setNewProfileName("");
    } catch {
      setSaveState("error");
    }
  }

  async function renameActiveProfile(): Promise<void> {
    const name = renameDraft.trim();
    if (!name || !activeProfileId || switching) return;
    try {
      await apiClient.renameProfile(activeProfileId, name);
      setProfiles((ps) => ps.map((p) => (p.id === activeProfileId ? { ...p, name } : p)));
      setRenaming(false);
    } catch {
      setSaveState("error");
    }
  }

  /** Supprime le profil actif ; le serveur choisit le nouvel actif, qu'on recharge. */
  async function deleteActiveProfile(): Promise<void> {
    if (profiles.length <= 1 || !activeProfileId || switching) return;
    try {
      await apiClient.deleteProfile(activeProfileId);
      // `getProfiles` d'abord (vérité serveur sur le nouvel actif), puis ses critères.
      const p = await apiClient.getProfiles();
      setProfiles(p.profiles);
      setActiveProfileId(p.activeProfileId);
      const s = await apiClient.getSettings();
      applyLoadedSettings(s);
      setDirty(false);
      setSaveState("idle");
    } catch {
      setSaveState("error");
    }
  }

  if (loadError) {
    return (
      <section aria-label="Paramètres">
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]"
        >
          Erreur de chargement : {loadError}
        </div>
      </section>
    );
  }

  if (!settings) {
    return (
      <section aria-label="Paramètres" className="flex flex-col gap-5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-44 animate-pulse rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-panel)]/40"
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
      </section>
    );
  }

  return (
    <section aria-label="Paramètres" className="flex flex-col gap-6 pb-24">
      {/* --- Profil de recherche -------------------------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          id="settings-profile-heading"
          icon={<Layers />}
          title="Profil de recherche"
          hint="Chaque profil garde son propre jeu de critères (mots-clés, filtres, sources, lieux). Le profil actif est celui qu'utilise chaque run. La planification reste commune à tous les profils."
        />

        <div role="group" aria-labelledby="settings-profile-heading" className="flex flex-col gap-4">
          {/* Sélecteur du profil actif. */}
          <div className="flex flex-wrap items-center gap-3">
            <ProfileSelector
              profiles={profiles}
              activeId={activeProfileId}
              disabled={switching}
              onActivate={(id) => void switchProfile(id)}
            />
            <span role="status" aria-live="polite" className="text-[0.8rem] text-[var(--color-ink-mute)]">
              {switching ? "Bascule du profil…" : null}
            </span>
          </div>

          {/* Renommer / supprimer le profil actif. */}
          {renaming ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void renameActiveProfile();
              }}
            >
              <Input
                type="text"
                autoFocus
                aria-label={`Nouveau nom du profil « ${activeProfileName} »`}
                value={renameDraft}
                placeholder={activeProfileName}
                onChange={(e) => setRenameDraft(e.target.value)}
                className="flex-1"
              />
              <Button type="submit" variant="signal" size="sm" disabled={!renameDraft.trim()}>
                <Check aria-hidden="true" className="size-4" />
                Renommer
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(false)}>
                Annuler
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setRenameDraft(activeProfileName);
                  setRenaming(true);
                }}
                disabled={switching || !activeProfileId}
              >
                <Pencil aria-hidden="true" className="size-4" />
                Renommer
              </Button>
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => void deleteActiveProfile()}
                disabled={switching || profiles.length <= 1}
                title={
                  profiles.length <= 1 ? "Impossible de supprimer le dernier profil." : undefined
                }
              >
                <Trash2 aria-hidden="true" className="size-4" />
                Supprimer
              </Button>
            </div>
          )}

          {/* Créer un profil (clone des critères du profil actif). */}
          <form
            className="flex gap-2 border-t border-[var(--color-line)] pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void createProfile();
            }}
          >
            <Input
              type="text"
              aria-label="Nom du nouveau profil"
              value={newProfileName}
              placeholder="ex. Stage ML"
              onChange={(e) => setNewProfileName(e.target.value)}
              className="flex-1"
            />
            <Button type="submit" variant="signal" disabled={!newProfileName.trim() || switching}>
              <Plus aria-hidden="true" className="size-4" />
              Nouveau profil
            </Button>
          </form>
          <p className="text-[0.8rem] text-[var(--color-ink-mute)]">
            Un nouveau profil reprend les critères du profil actif comme point de départ ;
            activez-le pour l'éditer.
          </p>
        </div>
      </Card>

      {/* --- Termes de recherche -------------------------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          icon={<Tags />}
          title="Termes de recherche"
          hint="Chaque terme est interrogé sur chaque source active à chaque run."
        />

        {settings.terms.length === 0 ? (
          <p className="mb-4 text-sm italic text-[var(--color-ink-mute)]">
            Aucun terme. Ajoutez-en un ci-dessous.
          </p>
        ) : (
          <ul className="mb-4 flex flex-wrap gap-2">
            {settings.terms.map((term, index) => (
              <li
                key={`${index}-${term}`}
                className="group inline-flex items-center gap-2 rounded-full border border-[var(--color-line-strong)] bg-black/25 py-1.5 pl-3.5 pr-1.5 text-sm text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-signal)]/40"
              >
                <span className="font-[family-name:var(--font-mono)] text-[0.8rem]">{term}</span>
                <button
                  type="button"
                  aria-label={`Supprimer le terme « ${term} »`}
                  onClick={() => removeTerm(index)}
                  className="grid size-6 place-items-center rounded-full text-[var(--color-ink-mute)] transition-colors hover:bg-[var(--color-danger)]/15 hover:text-[var(--color-danger)]"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addTerm();
          }}
        >
          <Input
            ref={addInputRef}
            type="text"
            aria-label="Nouveau terme de recherche"
            value={newTerm}
            placeholder="ex. data engineer"
            onChange={(e) => setNewTerm(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="signal" disabled={!newTerm.trim()}>
            <Plus aria-hidden="true" className="size-4" />
            Ajouter
          </Button>
        </form>
      </Card>

      {/* --- Mots bannis (titre) -------------------------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          icon={<Ban />}
          title="Mots bannis (titre)"
          hint="Une offre est écartée si l'un de ces mots apparaît, en mot entier, dans son titre. Insensible à la casse et aux accents."
        />

        {settings.titleBlacklist.length === 0 ? (
          <p className="mb-4 text-sm italic text-[var(--color-ink-mute)]">
            Aucun mot banni. Ajoutez-en un pour écarter les titres hors-sujet.
          </p>
        ) : (
          <ul className="mb-4 flex flex-wrap gap-2">
            {settings.titleBlacklist.map((word, index) => (
              <li
                key={`${index}-${word}`}
                className="group inline-flex items-center gap-2 rounded-full border border-[var(--color-line-strong)] bg-black/25 py-1.5 pl-3.5 pr-1.5 text-sm text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-danger)]/40"
              >
                <span className="font-[family-name:var(--font-mono)] text-[0.8rem]">{word}</span>
                <button
                  type="button"
                  aria-label={`Retirer le mot banni « ${word} »`}
                  onClick={() => removeBan(index)}
                  className="grid size-6 place-items-center rounded-full text-[var(--color-ink-mute)] transition-colors hover:bg-[var(--color-danger)]/15 hover:text-[var(--color-danger)]"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addBan();
          }}
        >
          <Input
            ref={addBanRef}
            type="text"
            aria-label="Nouveau mot banni dans le titre"
            value={newBan}
            placeholder="ex. sales"
            onChange={(e) => setNewBan(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="signal" disabled={!newBan.trim()}>
            <Plus aria-hidden="true" className="size-4" />
            Ajouter
          </Button>
        </form>
      </Card>

      {/* --- Types de contrat ----------------------------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          id="settings-contract-heading"
          icon={<FileSignature />}
          title="Types de contrat"
          hint="Seules les offres correspondant à ces types sont retenues."
        />
        <div
          role="group"
          aria-labelledby="settings-contract-heading"
          className="grid gap-2.5 sm:grid-cols-2"
        >
          {CONTRACT_TYPES.map((ct) => {
            const active = settings.contractTypes.includes(ct.value);
            return (
              <ToggleRow
                key={ct.value}
                active={active}
                onToggle={() => toggleContractType(ct.value)}
                title={ct.label}
                hint={ct.hint}
              />
            );
          })}
        </div>
      </Card>

      {/* --- Salaire minimum ------------------------------------------ */}
      <Card className="animate-rise p-6">
        <SectionTitle
          id="settings-salary-heading"
          icon={<Banknote />}
          title="Salaire minimum"
          hint="Salaire annuel brut minimum pour qu'une offre soit retenue."
        />
        <div
          role="group"
          aria-labelledby="settings-salary-heading"
          className="flex items-center gap-3"
        >
          <Input
            type="number"
            min={0}
            step={1000}
            inputMode="numeric"
            aria-label="Salaire annuel minimum, en euros"
            value={salaryDraft}
            onChange={(e) => onSalaryChange(e.target.value)}
            className="w-32 font-[family-name:var(--font-mono)]"
          />
          <span className="text-sm text-[var(--color-ink-soft)]">€ / an</span>
        </div>
        <p className="mt-3 text-[0.8rem] text-[var(--color-ink-mute)]">
          0 = aucun minimum. Une offre dont le salaire n'est pas affiché est toujours conservée.
        </p>
      </Card>

      {/* --- Localisation --------------------------------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          id="settings-locations-heading"
          icon={<MapPin />}
          title="Localisation"
          hint="Chaque ville déclenche une recherche distincte sur les sources qui filtrent par lieu. Le télétravail s'active à part."
        />

        {settings.locations.length === 0 ? (
          <p className="mb-4 text-sm italic text-[var(--color-ink-mute)]">
            Aucune ville : la recherche n'est pas restreinte géographiquement.
          </p>
        ) : (
          <ul className="mb-4 flex flex-wrap gap-2">
            {settings.locations.map((city, index) => (
              <li
                key={`${index}-${city}`}
                className="group inline-flex items-center gap-2 rounded-full border border-[var(--color-line-strong)] bg-black/25 py-1.5 pl-3.5 pr-1.5 text-sm text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-signal)]/40"
              >
                <span className="font-[family-name:var(--font-mono)] text-[0.8rem]">{city}</span>
                <button
                  type="button"
                  aria-label={`Supprimer la ville « ${city} »`}
                  onClick={() => removeLocation(index)}
                  className="grid size-6 place-items-center rounded-full text-[var(--color-ink-mute)] transition-colors hover:bg-[var(--color-danger)]/15 hover:text-[var(--color-danger)]"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addLocation();
          }}
        >
          <Input
            ref={addLocationRef}
            type="text"
            aria-label="Nouvelle ville"
            value={newLocation}
            placeholder="ex. Paris"
            onChange={(e) => setNewLocation(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" variant="signal" disabled={!newLocation.trim()}>
            <Plus aria-hidden="true" className="size-4" />
            Ajouter
          </Button>
        </form>

        <div className="mt-4">
          <ToggleRow
            active={settings.remoteOk}
            onToggle={toggleRemote}
            title="Télétravail accepté"
            hint="Inclut les offres 100 % remote, en plus des villes."
          />
        </div>
      </Card>

      {/* --- Ancienneté max ------------------------------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          id="settings-age-heading"
          icon={<CalendarClock />}
          title="Ancienneté"
          hint="Âge maximum de mise en ligne d'une offre pour être retenue au fetch."
        />
        <div role="group" aria-labelledby="settings-age-heading" className="flex items-center gap-3">
          <Input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            aria-label="Ancienneté maximale, en jours"
            value={ageDraft}
            onChange={(e) => onAgeChange(e.target.value)}
            className="w-24 font-[family-name:var(--font-mono)]"
          />
          <span className="text-sm text-[var(--color-ink-soft)]">jours</span>
        </div>
        <p className="mt-3 text-[0.8rem] text-[var(--color-ink-mute)]">
          0 = aucune limite : toutes les offres sont retenues quelle que soit leur date de
          publication.
        </p>
      </Card>

      {/* --- Sources actives ------------------------------------------ */}
      <Card className="animate-rise p-6">
        <SectionTitle
          id="settings-sources-heading"
          icon={<Globe />}
          title="Sources"
          hint="Jobboards interrogés à chaque run."
        />
        <div
          role="group"
          aria-labelledby="settings-sources-heading"
          className="flex flex-col gap-2.5"
        >
          {sourceCatalog.map((src) => {
            const active = settings.enabledSources.includes(src.name);
            const isAts = KNOWN_SOURCES.find((k) => k.name === src.name)?.ats === true;
            const boards = settings.atsBoards[src.name] ?? [];
            return (
              <div key={src.name} className="flex flex-col gap-2.5">
                <ToggleRow
                  active={active}
                  onToggle={() => toggleSource(src.name)}
                  title={src.label}
                  hint={src.name}
                  leading={<SourceLogo source={src.name} />}
                />
                {isAts && active && (
                  <div
                    role="group"
                    aria-label={`Boards ${src.label}`}
                    className="ml-3 flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] border-l-2 border-l-[var(--color-signal)]/40 bg-black/20 p-4"
                  >
                    {boards.length === 0 ? (
                      <p className="text-sm italic text-[var(--color-ink-mute)]">
                        Aucun board. Ajoutez un identifiant d'entreprise ci-dessous.
                      </p>
                    ) : (
                      <ul className="flex flex-wrap gap-2">
                        {boards.map((board, index) => (
                          <li
                            key={`${index}-${board}`}
                            className="group inline-flex items-center gap-2 rounded-full border border-[var(--color-line-strong)] bg-black/25 py-1.5 pl-3.5 pr-1.5 text-sm text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-signal)]/40"
                          >
                            <span className="font-[family-name:var(--font-mono)] text-[0.8rem]">
                              {board}
                            </span>
                            <button
                              type="button"
                              aria-label={`Retirer le board « ${board} »`}
                              onClick={() => removeBoard(src.name, index)}
                              className="grid size-6 place-items-center rounded-full text-[var(--color-ink-mute)] transition-colors hover:bg-[var(--color-danger)]/15 hover:text-[var(--color-danger)]"
                            >
                              <X aria-hidden="true" className="size-3.5" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        addBoard(src.name, boardDrafts[src.name] ?? "");
                        setBoardDrafts((d) => ({ ...d, [src.name]: "" }));
                      }}
                    >
                      <Input
                        type="text"
                        aria-label={`Ajouter un board ${src.label}`}
                        value={boardDrafts[src.name] ?? ""}
                        placeholder="ex. stripe"
                        onChange={(e) =>
                          setBoardDrafts((d) => ({ ...d, [src.name]: e.target.value }))
                        }
                        className="flex-1"
                      />
                      <Button
                        type="submit"
                        variant="signal"
                        size="sm"
                        disabled={!(boardDrafts[src.name] ?? "").trim()}
                      >
                        <Plus aria-hidden="true" className="size-4" />
                        Ajouter
                      </Button>
                    </form>

                    <p className="text-[0.8rem] text-[var(--color-ink-mute)]">
                      Le board est l'identifiant d'entreprise de l'ATS — ex. «&nbsp;stripe&nbsp;»
                      pour <span className="font-[family-name:var(--font-mono)]">boards.greenhouse.io/…/stripe</span>.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* --- Avertissements ------------------------------------------- */}
      {configWarnings.length > 0 && (
        <div
          id="config-warnings"
          role="alert"
          className="flex flex-col gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-amber)]/30 bg-[var(--color-amber)]/[0.07] px-4 py-3.5"
        >
          {configWarnings.map((warning) => (
            <p
              key={warning}
              className="flex items-center gap-2.5 text-[0.85rem] text-[var(--color-amber)]"
            >
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
              {warning}
            </p>
          ))}
        </div>
      )}

      {/* --- Barre de sauvegarde collante ----------------------------- */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-line)] bg-[var(--color-surface)]/85 backdrop-blur-md lg:left-[248px]">
        <div className="mx-auto flex max-w-[1080px] items-center justify-between gap-4 px-5 py-3.5 sm:px-8 lg:px-12">
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "flex items-center gap-2 text-[0.82rem]",
              saveState === "saved"
                ? "text-[var(--color-signal)]"
                : saveState === "error"
                  ? "text-[var(--color-danger)]"
                  : "text-[var(--color-ink-mute)]",
            )}
          >
            {saveState === "saved" && (
              <>
                <Check aria-hidden="true" className="size-4" />
                Paramètres enregistrés.
              </>
            )}
            {saveState === "error" && (
              <>
                <TriangleAlert aria-hidden="true" className="size-4" />
                Échec de l'enregistrement.
              </>
            )}
            {saveState === "idle" &&
              (dirty
                ? "Modifications non enregistrées, appliquées au prochain run."
                : "Configuration à jour.")}
            {saveState === "saving" && "Enregistrement…"}
          </span>

          <Button
            variant="signal"
            size="lg"
            onClick={save}
            disabled={saveState === "saving" || !canSave}
            aria-describedby={configWarnings.length > 0 ? "config-warnings" : undefined}
          >
            <Save aria-hidden="true" className="size-4" />
            {saveState === "saving" ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Sélecteur du profil actif (choix exclusif). Sémantique `radiogroup`/`radio`
 * avec roving tabindex, mais — contrairement à `Segmented` — la **sélection ne
 * suit PAS le focus** : les flèches déplacent seulement le focus, l'activation
 * (coûteuse : POST + rechargement serveur) ne se fait qu'au clic ou via
 * Entrée/Espace. Cela évite d'activer chaque profil traversé au clavier.
 */
function ProfileSelector({
  profiles,
  activeId,
  disabled,
  onActivate,
}: {
  profiles: SearchProfileMeta[];
  activeId: string;
  disabled: boolean;
  onActivate: (id: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    let next = index;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (index + 1) % profiles.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
      next = (index - 1 + profiles.length) % profiles.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = profiles.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      // Active le profil FOCUS (la sélection ne suit pas le focus).
      e.preventDefault();
      const opt = profiles[index];
      if (opt) onActivate(opt.id);
      return;
    } else return;
    e.preventDefault();
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Profil actif"
      className="inline-flex flex-wrap items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-line)] bg-black/30 p-1"
    >
      {profiles.map((p, index) => {
        const active = p.id === activeId;
        return (
          <button
            key={p.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onActivate(p.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "inline-flex items-center rounded-[var(--radius-xs)] px-3 py-1.5 text-xs font-medium " +
                "transition-all duration-200 ease-[var(--ease-out-expo)] disabled:opacity-60",
              active
                ? "bg-[var(--color-signal)]/12 text-[var(--color-signal)] shadow-[inset_0_0_0_1px_#c8f24c40]"
                : "text-[var(--color-ink-mute)] hover:text-[var(--color-ink)]",
            )}
          >
            {p.name}
          </button>
        );
      })}
    </div>
  );
}

/** Ligne d'interrupteur réutilisable (type de contrat / source). */
function ToggleRow({
  active,
  onToggle,
  title,
  hint,
  leading,
}: {
  active: boolean;
  onToggle: () => void;
  title: string;
  hint: string;
  leading?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={active}
      aria-label={title}
      className={cn(
        "flex items-center gap-3 rounded-[var(--radius-md)] border p-3.5 text-left transition-all duration-200",
        active
          ? "border-[var(--color-signal)]/35 bg-[var(--color-signal)]/[0.05]"
          : "border-[var(--color-line)] bg-black/15 hover:border-[var(--color-line-strong)]",
      )}
    >
      {leading}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate text-[0.9rem] font-medium",
            active ? "text-[var(--color-ink)]" : "text-[var(--color-ink-soft)]",
          )}
        >
          {title}
        </div>
        <div className="truncate font-[family-name:var(--font-mono)] text-[0.72rem] text-[var(--color-ink-faint)]">
          {hint}
        </div>
      </div>
      {/* Interrupteur purement visuel : tout le bouton-ligne porte l'action. */}
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-[250ms]",
          active
            ? "border-[var(--color-signal)]/50 bg-[var(--color-signal)]/25"
            : "border-[var(--color-line-strong)] bg-black/40",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 size-4 rounded-full transition-all duration-[250ms]",
            active
              ? "translate-x-4 bg-[var(--color-signal)] shadow-[0_0_12px_var(--color-signal-glow)]"
              : "translate-x-0 bg-[var(--color-ink-mute)]",
          )}
        />
      </span>
    </button>
  );
}
