/**
 * Page Cron.
 *
 * Pilote la planification automatique des runs via la table sqlite `settings` :
 *   - `cronEnabled` : interrupteur global de la planification.
 *   - `cronTimes[]` : horaires quotidiens "HH:MM" (heure locale).
 *
 * Le scheduler serveur (`src/server/scheduler.ts`) lit ces champs : il déclenche
 * un run à chaque horaire, rattrape un créneau manqué au démarrage (PC éteint),
 * et envoie une notification bureau en fin de run. L'autostart au démarrage du
 * PC s'installe à part via `npm run autostart:install`.
 *
 * Chargement via GET /api/settings, sauvegarde via PUT /api/settings.
 */
import { useEffect, useRef, useState } from "react";
import { Plus, X, Clock, CalendarClock, Bell, Check, Save, TriangleAlert } from "lucide-react";
import type { Settings } from "../../src/shared/types";
import { apiClient } from "../lib/api-client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SaveState = "idle" | "saving" | "saved" | "error";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Vrai si `value` est une heure "HH:MM" valide (00:00 → 23:59). */
function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

/** Trie croissant et déduplique une liste d'horaires "HH:MM" valides. */
function normalizeTimes(times: string[]): string[] {
  const seen = new Set<string>();
  for (const t of times) {
    if (isValidTime(t)) seen.add(t);
  }
  return [...seen].sort();
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

export default function Cron() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dirty, setDirty] = useState(false);
  /** Brouillon de l'horaire en cours de saisie dans le champ d'ajout. */
  const [newTime, setNewTime] = useState("");
  /** Pour rendre le focus au champ d'ajout après suppression d'un horaire. */
  const addInputRef = useRef<HTMLInputElement>(null);

  /* Chargement initial de la configuration effective. */
  useEffect(() => {
    let cancelled = false;
    apiClient
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings({ ...s, cronTimes: normalizeTimes(s.cronTimes) });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Échec du chargement des paramètres");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function patch(next: Settings): void {
    setSettings(next);
    setSaveState("idle");
    setDirty(true);
  }

  function toggleEnabled(): void {
    if (!settings) return;
    patch({ ...settings, cronEnabled: !settings.cronEnabled });
  }

  function addTime(): void {
    if (!settings) return;
    if (!isValidTime(newTime)) return;
    if (settings.cronTimes.includes(newTime)) {
      setNewTime("");
      return;
    }
    patch({ ...settings, cronTimes: normalizeTimes([...settings.cronTimes, newTime]) });
    setNewTime("");
  }

  function removeTime(index: number): void {
    if (!settings) return;
    patch({ ...settings, cronTimes: settings.cronTimes.filter((_, i) => i !== index) });
    addInputRef.current?.focus();
  }

  /**
   * Garde-fou : cron activé sans aucun horaire valide ne planifierait jamais
   * rien. On prévient et on bloque l'enregistrement (cohérent avec Paramètres).
   */
  const noTimesWhileEnabled = settings?.cronEnabled === true && settings.cronTimes.length === 0;
  const canSave = settings !== null && !noTimesWhileEnabled;

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

  if (loadError) {
    return (
      <section aria-label="Cron">
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
      <section aria-label="Cron" aria-busy className="flex flex-col gap-5">
        <span className="sr-only">Chargement…</span>
        <div aria-hidden="true" className="flex flex-col gap-5">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-panel)]/40"
              style={{ animationDelay: `${i * 90}ms` }}
            />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Cron" className="flex flex-col gap-6 pb-24">
      {/* --- Activation ----------------------------------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          icon={<CalendarClock />}
          title="Planification"
          hint="Lance automatiquement une recherche aux horaires choisis, tant que la planification est active."
        />
        <button
          type="button"
          onClick={toggleEnabled}
          role="switch"
          aria-checked={settings.cronEnabled}
          aria-label="Activer la planification automatique"
          className={cn(
            "flex w-full items-center gap-3 rounded-[var(--radius-md)] border p-3.5 text-left transition-all duration-200",
            settings.cronEnabled
              ? "border-[var(--color-signal)]/35 bg-[var(--color-signal)]/[0.05]"
              : "border-[var(--color-line)] bg-black/15 hover:border-[var(--color-line-strong)]",
          )}
        >
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "text-[0.9rem] font-medium",
                settings.cronEnabled ? "text-[var(--color-ink)]" : "text-[var(--color-ink-soft)]",
              )}
            >
              Recherches automatiques
            </div>
            <div className="font-[family-name:var(--font-mono)] text-[0.72rem] text-[var(--color-ink-faint)]">
              {settings.cronEnabled ? "actives" : "en pause"}
            </div>
          </div>
          <span
            aria-hidden
            className={cn(
              "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-[250ms]",
              settings.cronEnabled
                ? "border-[var(--color-signal)]/50 bg-[var(--color-signal)]/25"
                : "border-[var(--color-line-strong)] bg-black/40",
            )}
          >
            <span
              className={cn(
                "absolute left-0.5 size-4 rounded-full transition-all duration-[250ms]",
                settings.cronEnabled
                  ? "translate-x-4 bg-[var(--color-signal)] shadow-[0_0_12px_var(--color-signal-glow)]"
                  : "translate-x-0 bg-[var(--color-ink-mute)]",
              )}
            />
          </span>
        </button>
      </Card>

      {/* --- Horaires ------------------------------------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          id="cron-times-heading"
          icon={<Clock />}
          title="Horaires"
          hint="Un run est déclenché à chacun de ces horaires, chaque jour (heure locale)."
        />

        {settings.cronTimes.length === 0 ? (
          <p className="mb-4 text-sm italic text-[var(--color-ink-mute)]">
            Aucun horaire. Ajoutez-en un ci-dessous.
          </p>
        ) : (
          <ul className="mb-4 flex flex-wrap gap-2" aria-labelledby="cron-times-heading">
            {settings.cronTimes.map((time, index) => (
              <li
                key={`${index}-${time}`}
                className="group inline-flex items-center gap-2 rounded-full border border-[var(--color-line-strong)] bg-black/25 py-1.5 pl-3.5 pr-1.5 text-sm text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-signal)]/40"
              >
                <span className="font-[family-name:var(--font-mono)] text-[0.8rem] tabular-nums">
                  {time}
                </span>
                <button
                  type="button"
                  aria-label={`Supprimer l'horaire ${time}`}
                  onClick={() => removeTime(index)}
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
            addTime();
          }}
        >
          <Input
            ref={addInputRef}
            type="time"
            aria-label="Nouvel horaire de recherche"
            value={newTime}
            onChange={(e) => setNewTime(e.target.value)}
            className="w-36 font-[family-name:var(--font-mono)]"
          />
          <Button type="submit" variant="signal" disabled={!isValidTime(newTime)}>
            <Plus aria-hidden="true" className="size-4" />
            Ajouter
          </Button>
        </form>
      </Card>

      {/* --- Notifications & autostart (informatif) ------------------- */}
      <Card className="animate-rise p-6">
        <SectionTitle
          icon={<Bell />}
          title="Notifications & démarrage"
          hint="Comportement automatique autour des runs planifiés."
        />
        <ul className="flex flex-col gap-2.5 text-[0.85rem] text-[var(--color-ink-soft)]">
          <li className="flex items-start gap-2.5">
            <Bell aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-ink-faint)]" />
            <span>
              Une notification bureau annonce la fin de chaque run planifié, avec le nombre de
              nouvelles offres trouvées.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <CalendarClock
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--color-ink-faint)]"
            />
            <span>
              Si le PC était éteint à l'heure d'un créneau, le run manqué est rattrapé une fois au
              démarrage pour rester à jour.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-ink-faint)]" />
            <span>
              Pour lancer l'application au démarrage du PC, exécuter une fois{" "}
              <span className="font-[family-name:var(--font-mono)] text-[0.8rem]">
                npm run autostart:install
              </span>
              .
            </span>
          </li>
        </ul>
      </Card>

      {/* --- Avertissement -------------------------------------------- */}
      {noTimesWhileEnabled && (
        <div
          id="cron-warnings"
          role="alert"
          className="flex items-center gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-amber)]/30 bg-[var(--color-amber)]/[0.07] px-4 py-3.5 text-[0.85rem] text-[var(--color-amber)]"
        >
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          Planification active sans aucun horaire : aucun run ne sera déclenché.
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
                Planification enregistrée.
              </>
            )}
            {saveState === "error" && (
              <>
                <TriangleAlert aria-hidden="true" className="size-4" />
                Échec de l'enregistrement.
              </>
            )}
            {saveState === "idle" &&
              (dirty ? "Modifications non enregistrées." : "Planification à jour.")}
            {saveState === "saving" && "Enregistrement…"}
          </span>

          <Button
            variant="signal"
            size="lg"
            onClick={save}
            disabled={saveState === "saving" || !canSave}
            aria-describedby={noTimesWhileEnabled ? "cron-warnings" : undefined}
          >
            <Save aria-hidden="true" className="size-4" />
            {saveState === "saving" ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </div>
    </section>
  );
}
