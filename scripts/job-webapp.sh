#!/usr/bin/env bash
#
# job-webapp — bascule (toggle) le serveur web job-agregator.
#
#   - serveur arrêté  → le démarre  (et affiche l'URL)
#   - serveur en cours → l'arrête
#
# Le serveur tourne comme service systemd --user (`npm run autostart:install`),
# donc on bascule ce service : c'est la même instance que celle lancée au boot,
# pas de process concurrent ni de conflit de port. `stop` n'est pas un échec →
# le `Restart=on-failure` du service ne le relance pas. Le service reste
# `enabled` : il repartira quand même au prochain boot.
#
# Installé en raccourci `job-webapp` dans ~/.bashrc.
set -euo pipefail

SERVICE="job-agregator.service"
URL="http://127.0.0.1:5627"

# Garde-fou : si le service n'est pas installé, on guide vers l'install plutôt
# que d'échouer cryptiquement.
if ! systemctl --user list-unit-files "$SERVICE" >/dev/null 2>&1 \
   || ! systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
  echo "✗ Service $SERVICE introuvable." >&2
  echo "  Installe-le d'abord :  npm run autostart:install" >&2
  exit 1
fi

if systemctl --user is-active --quiet "$SERVICE"; then
  systemctl --user stop "$SERVICE"
  echo "⏹  job-agregator arrêté."
else
  systemctl --user start "$SERVICE"
  echo "▶  job-agregator démarré → $URL"
fi
