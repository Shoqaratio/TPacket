#!/usr/bin/env bash
set -Eeuo pipefail

readonly app_dir=/opt/tpacket-app
readonly stage_dir=/opt/tpacket-app-stage
readonly maintenance_dir=/opt/tpacket-maintenance
readonly env_file=/opt/netlab/.env
readonly flag_file="$maintenance_dir/maintenance.flag"
readonly progress_file="$maintenance_dir/progress.json"
progress=0

write_progress() {
  local percent="$1"
  local message="$2"
  local state="${3:-running}"
  printf '{"percent":%s,"message":"%s","state":"%s"}\n' "$percent" "$message" "$state" > "$progress_file.tmp"
  mv -f "$progress_file.tmp" "$progress_file"
  progress="$percent"
}

if [[ -z "${GITHUB_WORKSPACE:-}" || ! -d "$GITHUB_WORKSPACE" ]]; then
  echo "GITHUB_WORKSPACE is missing or does not exist." >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  echo "Deployment environment file is missing: $env_file" >&2
  exit 1
fi

mkdir -p "$app_dir" "$stage_dir" "$maintenance_dir"
write_progress 2 'Préparation des fichiers'
rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.venv/' \
  --exclude='dist/' \
  --exclude='__pycache__/' \
  --exclude='.pytest_cache/' \
  --exclude='test-results/' \
  --exclude='playwright-report/' \
  --exclude='coverage/' \
  "$GITHUB_WORKSPACE/" "$stage_dir/"
rsync -a --delete "$stage_dir/" "$app_dir/"
write_progress 7 'Activation du mode maintenance'

export TPACKET_MAINTENANCE_DIR="$maintenance_dir"
export TPACKET_ENV_FILE="$env_file"
compose() {
  docker compose \
    --project-name netlab \
    --project-directory "$app_dir" \
    --env-file "$env_file" \
    --file "$app_dir/docker-compose.yml" \
    --file "$app_dir/docker-compose.deploy.yml" \
    "$@"
}

deployment_succeeded=0
finish_deployment() {
  local status=$?
  if (( deployment_succeeded )); then
    write_progress 100 'Mise à jour terminée' complete
    rm -f "$flag_file"
    if ! compose exec -T gateway nginx -s reload; then
      touch "$flag_file"
      write_progress 98 'Erreur lors de la réactivation du site' error
      if ! compose exec -T gateway nginx -s reload; then
        echo "Could not reload the gateway; maintenance mode is enabled on disk." >&2
      fi
      echo "Deployment succeeded, but the maintenance page could not be disabled." >&2
      status=1
    fi
  else
    touch "$flag_file"
    write_progress "$progress" 'Le déploiement a échoué. Intervention nécessaire.' error
    if compose ps --services --status running | grep -qx gateway; then
      compose exec -T gateway nginx -s reload
    fi
    echo "Deployment failed; maintenance mode remains enabled for investigation." >&2
  fi
  exit "$status"
}

touch "$flag_file"
trap finish_deployment EXIT
write_progress 10 'Le site est en maintenance'
if compose ps --services --status running | grep -qx gateway; then
  compose exec -T gateway nginx -s reload
else
  echo "Gateway is not running yet; it will start in maintenance mode." >&2
fi

write_progress 18 'Construction des images et redémarrage des services'
compose up -d --build --force-recreate --remove-orphans api web
write_progress 76 'Services redémarrés, vérification en cours'
compose up -d gateway
compose exec -T gateway nginx -t
compose exec -T gateway nginx -s reload

ready=0
for attempt in {1..36}; do
  write_progress "$((78 + attempt * 19 / 36))" 'Vérification de l’API et du site'
  if compose exec -T api python -c \
    'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=3)' \
    >/dev/null 2>&1 &&
    compose exec -T web sh -c \
      'wget -q -O - http://127.0.0.1/ | grep -q "<title>TPacket</title>"' \
      >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done

if (( ! ready )); then
  echo "API and web did not become healthy within 180 seconds." >&2
  exit 1
fi

write_progress 98 'Vérification finale'
rm "$flag_file"
compose exec -T gateway nginx -s reload
if ! compose exec -T gateway sh -c \
  'wget -q -O - http://127.0.0.1/ | grep -q "<title>TPacket</title>" &&
   wget -q -O - http://127.0.0.1/api/health | grep -q "\"status\":\"ok\""'; then
  echo "Gateway health check failed after leaving maintenance mode." >&2
  exit 1
fi

deployment_succeeded=1
