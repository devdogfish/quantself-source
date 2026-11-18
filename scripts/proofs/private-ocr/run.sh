#!/usr/bin/env bash
# Stage dependencies with --prepare [--opencloud], then run [--opencloud] without a network.
# Set PRIVATE_OCR_ONE_DOCUMENT=1 for the Owner capture-to-cleanup proof.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
revision=${PRIVATE_OCR_REF:-HEAD}
lock_digest=$(git show "$revision:bun.lock" | shasum -a 256 | cut -d ' ' -f 1)
image=${PRIVATE_OCR_IMAGE:-quantself-private-ocr-fixture:${lock_digest:0:12}}
db_image='postgres@sha256:b0ba6f2b6290ae40c9aacf6cc72849a2954778fef88774e122131d4b3c3b5e5b'
vault_image=$(git show "$revision:scripts/infra/keep-storage/opencloud-image.txt")

if [[ ${1:-} == --prepare ]]; then
  scratch=$(mktemp -d)
  trap 'python3 -c "import shutil, sys; shutil.rmtree(sys.argv[1])" "$scratch"' EXIT
  git archive "$revision" package.json bun.lock apps/api/package.json apps/log-bot/package.json apps/web/package.json \
    packages/auth/package.json packages/budgeting/package.json packages/cli/package.json packages/db/package.json |
    tar -xf - -C "$scratch"
  cat > "$scratch/Dockerfile" <<'DOCKERFILE'
FROM oven/bun:1.3.14
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng && apt-get clean
COPY . .
RUN bun install --frozen-lockfile
RUN cd packages/db && bun x --bun --no-install prisma --version
DOCKERFILE
  docker build --pull=false --tag "$image" "$scratch"
  docker pull "$db_image"
  if [[ ${2:-} == --opencloud ]]; then docker pull "$vault_image"; fi
  exit
fi

docker image inspect "$image" "$db_image" --format '{{.Id}} {{.Architecture}}'
database="quantself-private-ocr-$$"
vault="$database-vault"
ocr_env=(-e QUANTSELF_ORIGINALS_PROVIDER=legacy)
storage=legacy
docker run --detach --rm --pull=never --name "$database" --network none \
  -e POSTGRES_USER=fixture -e POSTGRES_DB=private_ocr_fixture -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$db_image" -c listen_addresses=127.0.0.1 >/dev/null
cleanup() {
  if [[ $storage == opencloud ]]; then
    docker stop --timeout 2 "$vault" >/dev/null 2>&1 || true
    docker volume rm "$vault-config" "$vault-data" >/dev/null 2>&1 || true
    if [[ -n ${vault_certs:-} ]]; then
      python3 -c 'import shutil, sys; shutil.rmtree(sys.argv[1])' "$vault_certs"
    fi
  fi
  docker stop --timeout 2 "$database" >/dev/null 2>&1 || true
}
trap cleanup EXIT
for ((attempt = 0; attempt < 45; attempt++)); do
  if docker exec "$database" pg_isready -h 127.0.0.1 -U fixture -d private_ocr_fixture >/dev/null; then break; fi
  sleep 1
done
docker exec "$database" pg_isready -h 127.0.0.1 -U fixture -d private_ocr_fixture
test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$database")" = none
docker exec "$database" postgres --version

if [[ ${1:-} == --opencloud ]]; then
  storage=opencloud
  docker image inspect "$vault_image" --format '{{.Id}} {{.Architecture}}'
  export IDM_ADMIN_PASSWORD
  IDM_ADMIN_PASSWORD=$(openssl rand -hex 24)
  vault_certs=$(mktemp -d)
  mkdir "$vault_certs/tls"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 \
    -addext subjectAltName=IP:127.0.0.1 \
    -keyout "$vault_certs/tls/server.key" -out "$vault_certs/tls/server.crt" >/dev/null 2>&1
  # The host parent stays private. OpenCloud's container UID can read the mounted files.
  chmod 755 "$vault_certs/tls"
  chmod 644 "$vault_certs/tls/server.key" "$vault_certs/tls/server.crt"
  vault_opts=(--rm --pull=never --network "container:$database"
    -v "$vault-config:/etc/opencloud" -v "$vault-data:/var/lib/opencloud"
    -v "$vault_certs/tls:/fixture:ro"
    -e IDM_ADMIN_PASSWORD -e IDM_CREATE_DEMO_USERS=false -e OC_INSECURE=true
    -e OC_URL=https://127.0.0.1:19200 -e PROXY_HTTP_ADDR=127.0.0.1:19200
    -e PROXY_TRANSPORT_TLS_CERT=/fixture/server.crt -e PROXY_TRANSPORT_TLS_KEY=/fixture/server.key
    -e PROXY_ENABLE_BASIC_AUTH=true -e STORAGE_USERS_DRIVER=posix -e OC_LOG_LEVEL=error)
  docker run "${vault_opts[@]}" "$vault_image" init --insecure yes --quiet
  docker run --detach --name "$vault" "${vault_opts[@]}" "$vault_image" >/dev/null
  ocr_env=(-e QUANTSELF_ORIGINALS_PROVIDER=opencloud -e IDM_ADMIN_PASSWORD -e NODE_EXTRA_CA_CERTS=/fixture/server.crt
    -v "$vault_certs/tls/server.crt:/fixture/server.crt:ro")
fi

git archive "$revision" apps/api/src apps/web/lib automation/n8n/jobs-feed/sources packages scripts |
  docker run --rm --interactive --pull=never --network "container:$database" --entrypoint /bin/sh \
    -e "FIXTURE_LOCK_DIGEST=$lock_digest" \
    -e "QUANTSELF_PRIVATE_OCR_ONE_DOCUMENT=${PRIVATE_OCR_ONE_DOCUMENT:-0}" \
    -e DATABASE_URL=postgresql://fixture@127.0.0.1:5432/private_ocr_fixture \
    -e BETTER_AUTH_URL=http://127.0.0.1:3000 -e QUANTSELF_PUBLIC_ORIGIN=http://127.0.0.1:3000 \
    "${ocr_env[@]}" \
    -e BETTER_AUTH_SECRET=synthetic-private-ocr-fixture-secret-only -e QUANTSELF_PRIVATE_OCR_DOCKER=1 \
    "$image" -ec '
      cd /app
      test "$(wc -l < /proc/net/route)" -eq 1
      bun -e "import { networkInterfaces } from \"node:os\"; if (Object.keys(networkInterfaces()).join() !== \"lo\") process.exit(1)"
      echo "$FIXTURE_LOCK_DIGEST  bun.lock" | sha256sum -c
      bun --version
      pdfinfo -v
      tesseract --version | head -n 1
      tesseract --list-langs | grep -x eng
      tar -xf -
      bun --no-env-file run --cwd packages/db migrate:deploy-only >/tmp/migrate.log 2>&1 || { cat /tmp/migrate.log; exit 1; }
      bun --no-env-file run --cwd packages/db generate
      bun --no-env-file run test ./apps/api/src/private-document-ocr-docker.test.ts
    '
