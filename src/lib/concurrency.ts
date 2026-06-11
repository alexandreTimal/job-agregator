/**
 * Concurrence bornée maison (zéro dépendance) pour l'orchestrateur.
 *
 * `pLimit(n)` : au plus `n` tâches en vol simultanément, résultats dans l'ordre
 * d'appel. `withTimeout` : borne la durée d'une tâche (une source qui hang ne
 * doit jamais bloquer tout le run).
 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`délai dépassé après ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** Borne le nombre de tâches concurrentes. Renvoie un wrapper `run(fn)`. */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];

  const next = (): void => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const run = queue.shift()!;
    run();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      };
      queue.push(run);
      next();
    });
}

/** Rejette avec `TimeoutError` si `promise` n'a pas résolu en `ms` ms. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
