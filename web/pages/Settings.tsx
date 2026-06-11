/**
 * Page Paramètres.
 *
 * Pilote la table sqlite `settings` via le client API typé :
 *   - `terms[]`          : termes de recherche (ajout / suppression).
 *   - `contractTypes`    : cases à cocher parmi "stage" et "CDI".
 *   - `enabledSources[]` : cases à cocher par jobboard connu.
 *
 * Chargement via GET /api/settings, sauvegarde via PUT /api/settings.
 * Se code contre le mock fourni par la fondation tant que le backend n'est
 * pas prêt (cf. web/lib/api-client.ts, mode VITE_MOCK).
 */
import { useEffect, useMemo, useState } from "react";
import type { Settings } from "../../src/shared/types";
import { apiClient } from "../lib/api-client";

/**
 * Catalogue des types de contrat proposés par l'UI.
 * Source de vérité : contrat d'API (`contractTypes` ∈ {"stage", "CDI"}).
 */
const CONTRACT_TYPES = [
  { value: "stage", label: "Stage" },
  { value: "CDI", label: "CDI" },
] as const;

/**
 * Catalogue des sources connues (= registry `src/sources/registry.ts`).
 * L'UI affiche une case par source ; `enabledSources` indique les actives.
 * Une source présente dans `settings.enabledSources` mais absente du catalogue
 * reste affichée (cf. `sourceCatalog` plus bas) pour ne jamais la "perdre".
 */
const KNOWN_SOURCES: { name: string; label: string }[] = [
  { name: "wttj", label: "Welcome to the Jungle" },
  { name: "hellowork", label: "HelloWork" },
];

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Déduplique une liste de termes de façon insensible à la casse, en
 * conservant le premier libellé rencontré et son ordre d'apparition.
 *
 * Appliqué au chargement (le backend / seed peut renvoyer des doublons ou des
 * variantes de casse) ET côté ajout, pour que l'invariant « un seul terme par
 * forme normalisée » tienne sur tous les chemins.
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

export default function Settings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [newTerm, setNewTerm] = useState("");

  /* Chargement initial de la configuration effective. */
  useEffect(() => {
    let cancelled = false;
    apiClient
      .getSettings()
      .then((s) => {
        // Normalise les termes dès le chargement : le seed initial ou le backend
        // peuvent renvoyer des doublons (ou des variantes de casse) que l'UI ne
        // doit jamais afficher deux fois.
        if (!cancelled) setSettings({ ...s, terms: dedupeTerms(s.terms) });
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

  /**
   * Sources à afficher : le catalogue connu, complété par les sources actives
   * inconnues du catalogue (afin de ne jamais masquer une source activée).
   */
  const sourceCatalog = useMemo(() => {
    if (!settings) return KNOWN_SOURCES;
    const extra = settings.enabledSources
      .filter((name) => !KNOWN_SOURCES.some((s) => s.name === name))
      .map((name) => ({ name, label: name }));
    return [...KNOWN_SOURCES, ...extra];
  }, [settings]);

  /* Toute édition repasse l'état de sauvegarde à "idle". */
  function patch(next: Settings): void {
    setSettings(next);
    setSaveState("idle");
  }

  function addTerm(): void {
    if (!settings) return;
    const trimmed = newTerm.trim();
    if (!trimmed) return;
    // dedupeTerms garantit l'invariant « une seule forme normalisée » même si
    // settings.terms contenait déjà un doublon résiduel.
    patch({ ...settings, terms: dedupeTerms([...settings.terms, trimmed]) });
    setNewTerm("");
  }

  /**
   * Supprime le terme à la position `index`. On retire PAR INDEX (et non par
   * valeur) pour ne jamais effacer plusieurs occurrences d'un coup si un
   * doublon résiduel subsistait malgré la déduplication.
   */
  function removeTerm(index: number): void {
    if (!settings) return;
    patch({
      ...settings,
      terms: settings.terms.filter((_, i) => i !== index),
    });
  }

  function toggleContractType(value: string): void {
    if (!settings) return;
    const active = settings.contractTypes.includes(value);
    const contractTypes = active
      ? settings.contractTypes.filter((c) => c !== value)
      : [...settings.contractTypes, value];
    patch({ ...settings, contractTypes });
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
   * Garde-fous de configuration : une config sans aucune source active OU sans
   * aucun type de contrat rend tout run silencieusement inerte (aucune source
   * interrogée / aucun type retenu). Le contrat n'interdit pas les tableaux
   * vides, mais l'UI prévient l'utilisateur et bloque l'enregistrement.
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
    } catch {
      setSaveState("error");
    }
  }

  if (loadError) {
    return (
      <section aria-label="Paramètres">
        <p role="alert">Erreur de chargement : {loadError}</p>
      </section>
    );
  }

  if (!settings) {
    return (
      <section aria-label="Paramètres">
        <p>Chargement des paramètres…</p>
      </section>
    );
  }

  return (
    <section aria-label="Paramètres" className="settings">
      <h1>Paramètres</h1>

      {/* --- Termes de recherche -------------------------------------- */}
      <fieldset className="settings-group">
        <legend>Termes de recherche</legend>
        <p className="settings-hint">
          Chaque terme est interrogé sur chaque source active à chaque run.
        </p>

        {settings.terms.length === 0 ? (
          <p className="settings-empty">Aucun terme. Ajoutez-en un ci-dessous.</p>
        ) : (
          <ul className="settings-terms">
            {settings.terms.map((term, index) => (
              // Clé stable indépendante de la valeur : deux termes de libellé
              // identique (doublon résiduel) ne produisent pas de clés dupliquées.
              <li key={`${index}-${term}`} className="settings-term">
                <span>{term}</span>
                <button
                  type="button"
                  aria-label={`Supprimer le terme « ${term} »`}
                  onClick={() => removeTerm(index)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <form
          className="settings-term-add"
          onSubmit={(e) => {
            e.preventDefault();
            addTerm();
          }}
        >
          <label>
            <span className="visually-hidden">Nouveau terme</span>
            <input
              type="text"
              value={newTerm}
              placeholder="ex. data engineer"
              onChange={(e) => setNewTerm(e.target.value)}
            />
          </label>
          <button type="submit" disabled={!newTerm.trim()}>
            Ajouter
          </button>
        </form>
      </fieldset>

      {/* --- Types de contrat ----------------------------------------- */}
      <fieldset className="settings-group">
        <legend>Types de contrat</legend>
        {CONTRACT_TYPES.map((ct) => (
          <label key={ct.value} className="settings-check">
            <input
              type="checkbox"
              checked={settings.contractTypes.includes(ct.value)}
              onChange={() => toggleContractType(ct.value)}
            />
            <span>{ct.label}</span>
          </label>
        ))}
      </fieldset>

      {/* --- Sources actives ------------------------------------------ */}
      <fieldset className="settings-group">
        <legend>Sources</legend>
        {sourceCatalog.map((src) => (
          <label key={src.name} className="settings-check">
            <input
              type="checkbox"
              checked={settings.enabledSources.includes(src.name)}
              onChange={() => toggleSource(src.name)}
            />
            <span>{src.label}</span>
          </label>
        ))}
      </fieldset>

      {/* --- Avertissements de configuration -------------------------- */}
      {configWarnings.length > 0 && (
        <ul
          role="alert"
          className="settings-feedback settings-feedback-warning"
        >
          {configWarnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {/* --- Sauvegarde ----------------------------------------------- */}
      <div className="settings-actions">
        <button
          type="button"
          onClick={save}
          disabled={saveState === "saving" || !canSave}
        >
          {saveState === "saving" ? "Enregistrement…" : "Enregistrer"}
        </button>
        {/*
          Conteneur d'annonce PERSISTANT : il reste monté en permanence et seul
          son contenu change. Un lecteur d'écran annonce ainsi de façon fiable
          le passage à « enregistré » / « échec » (aria-live sur un nœud stable),
          sans risque de manquer un message remplacé trop vite.
        */}
        <span
          role="status"
          aria-live="polite"
          className={
            saveState === "saved"
              ? "settings-feedback settings-feedback-ok"
              : saveState === "error"
                ? "settings-feedback settings-feedback-error"
                : "settings-feedback"
          }
        >
          {saveState === "saved" && "Paramètres enregistrés."}
          {saveState === "error" && "Échec de l'enregistrement."}
        </span>
      </div>
    </section>
  );
}
