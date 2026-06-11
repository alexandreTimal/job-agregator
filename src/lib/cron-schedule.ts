/**
 * Helpers PURS de planification cron : des horaires quotidiens "HH:MM" (heure
 * locale). Aucune I/O — `now` est injecté pour rester déterministe et testable.
 *
 * Le scheduler serveur (`src/server/scheduler.ts`) et la validation de la route
 * settings (`src/server/routes/settings.ts`) partagent ces fonctions ; le filtre
 * déterministe (`src/filter.ts`) n'en a aucune notion.
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

/** Vrai si `value` est une heure "HH:MM" valide (00:00 → 23:59). */
export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

/** Minutes depuis minuit pour une heure "HH:MM" supposée valide. */
function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Normalise une liste d'horaires : ne garde que les "HH:MM" valides, convertis
 * en minutes depuis minuit, triés croissants et dédupliqués.
 */
export function parseTimes(times: string[]): number[] {
  const mins = new Set<number>();
  for (const t of times) {
    if (isValidTime(t)) mins.add(toMinutes(t));
  }
  return [...mins].sort((a, b) => a - b);
}

/**
 * Délai en millisecondes entre `now` et le prochain horaire planifié.
 *
 * - `null` si aucun horaire valide (rien à planifier).
 * - Sinon, le premier horaire STRICTEMENT après `now` aujourd'hui ; si tous les
 *   horaires du jour sont passés (ou égaux à maintenant), vise le premier
 *   horaire du lendemain. L'égalité stricte évite un re-déclenchement immédiat
 *   juste après un tick (les timers Node ne se déclenchent jamais en avance).
 */
export function nextFireDelay(now: Date, times: string[]): number | null {
  const mins = parseTimes(times);
  if (mins.length === 0) return null;

  const curMs =
    now.getHours() * 3_600_000 +
    now.getMinutes() * 60_000 +
    now.getSeconds() * 1000 +
    now.getMilliseconds();

  for (const m of mins) {
    const fireMs = m * 60_000;
    if (fireMs > curMs) return fireMs - curMs;
  }
  // Tous les créneaux du jour sont passés → premier créneau demain.
  return mins[0]! * 60_000 + DAY_MS - curMs;
}

/**
 * Date du créneau planifié le plus récent à `now` ou avant (le dernier horaire
 * déjà écoulé aujourd'hui ; sinon le dernier horaire d'hier). `null` si aucun
 * horaire valide. Heure locale, comme le reste du module.
 */
export function previousSlot(now: Date, times: string[]): Date | null {
  const mins = parseTimes(times);
  if (mins.length === 0) return null;

  const curMs =
    now.getHours() * 3_600_000 +
    now.getMinutes() * 60_000 +
    now.getSeconds() * 1000 +
    now.getMilliseconds();

  let chosen: number | null = null;
  for (const m of mins) {
    if (m * 60_000 <= curMs) chosen = m;
  }

  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (chosen === null) {
    // Aucun créneau écoulé aujourd'hui → dernier créneau d'hier.
    slot.setDate(slot.getDate() - 1);
    chosen = mins[mins.length - 1]!;
  }
  // `setMinutes` accepte le débordement (>59) et le reporte sur les heures.
  slot.setMinutes(chosen);
  return slot;
}

/**
 * Faut-il rattraper un run manqué au démarrage ? Vrai si le dernier créneau
 * planifié écoulé (`previousSlot`) est postérieur au dernier run connu —
 * c.-à-d. qu'un créneau est passé pendant que l'app était éteinte. `lastRunAt`
 * à `null` (jamais tourné) déclenche le rattrapage dès qu'un créneau du jour
 * est passé. Au plus UN rattrapage, peu importe le nombre de créneaux manqués.
 */
export function shouldCatchUp(lastRunAt: Date | null, now: Date, times: string[]): boolean {
  const slot = previousSlot(now, times);
  if (slot === null) return false;
  if (lastRunAt === null) return true;
  return lastRunAt.getTime() < slot.getTime();
}
