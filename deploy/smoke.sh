#!/usr/bin/env bash
#
# What a local container run can actually prove about Cloud Run.
#
# Builds both images and exercises every branch of the exit-code contract plus
# the service's container contract, on a Docker network with **no route off the
# machine**. That last part is not decoration: the Forager re-fetches every
# pinned page, so a smoke run on a normal bridge network would go and read the
# open internet. On `--internal` those fetches fail, the stage degrades exactly
# as it is designed to, and the model is still reachable — because the model is
# a container on the same network serving the suite's own `ScriptedLlm`.
#
# Zero calls to any provider. Zero GCP. Nothing leaves the machine.
#
# What this does NOT prove is in `deploy/CLOUD_RUN.md` §6 — IAM, real PORT
# injection, cold starts, Scheduler, and the platform's own retry orchestration
# are not reachable from here and are not claimed.
#
#   ./deploy/smoke.sh
#
# Requires: a container runtime, and `npm run build` for the compiled harness
# the stub model serves.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

NET=virgil-smoke
STUB=virgil-stub-model
# Deliberately away from 8791 (the local service), 8080 and 8085 (the Firestore
# and Pub/Sub emulators the sibling lanes run), and 11434 (a real Ollama).
STUB_PORT=18791
WORK=$(mktemp -d)

pass=0
fail=0

cleanup() {
  docker rm -f "$STUB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# $1 expected exit code, $2 label, rest: docker run args
expect_exit() {
  local want=$1 label=$2
  shift 2
  local got=0
  "$@" >"$WORK/out.txt" 2>&1 || got=$?
  if [ "$got" = "$want" ]; then
    printf '  \033[32mPASS\033[0m %-52s exit %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m %-52s exit %s, wanted %s\n' "$label" "$got" "$want"
    sed 's/^/        /' "$WORK/out.txt" | tail -20
    fail=$((fail + 1))
  fi
}

check() {
  local label=$1 want=$2 got=$3
  if [ "$got" = "$want" ]; then
    printf '  \033[32mPASS\033[0m %-52s %s\n' "$label" "$got"
    pass=$((pass + 1))
  else
    printf '  \033[31mFAIL\033[0m %-52s got %s, wanted %s\n' "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

say "building"
docker build -q -f deploy/Dockerfile --target job -t virgil-job:local .
docker build -q -f deploy/Dockerfile --target service -t virgil-service:local .

say "an internal network — no route off this machine"
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create --internal "$NET" >/dev/null
BUILDER=$(grep -m1 '^ARG BUILDER_IMAGE=' deploy/Dockerfile | cut -d= -f2-)
docker run -d --name "$STUB" --network "$NET" \
  -v "$ROOT":/w -w /w "$BUILDER" \
  node deploy/stub-model.mjs "$STUB_PORT" 0.0.0.0 >/dev/null
sleep 2

MODEL=(-e SB_LLM=local -e "SB_OLLAMA_HOST=http://$STUB:$STUB_PORT" \
  -e SB_ALLOW_REMOTE_MODEL_ENDPOINTS=1 -e SB_EMBEDDER=tfidf)

say "the job: every branch of the exit-code contract"

# --- 0, a night that built a session -----------------------------------------
mkdir -p "$WORK/board"
chmod 777 "$WORK/board"
docker run --rm --network "$NET" -v "$WORK/board":/board \
  -e SB_DB=/board/store.json "${MODEL[@]}" \
  virgil-job:local runner/dist/cli.js seed >/dev/null

expect_exit 0 "a night that builds a session" \
  docker run --rm --network "$NET" -v "$WORK/board":/board \
  -e SB_DB=/board/store.json "${MODEL[@]}" virgil-job:local
check "  and it says so" session "$(grep -o 'batch-outcome [a-z-]*' "$WORK/out.txt" | tail -1 | cut -d' ' -f2)"

# --- 0, a night with nothing to teach ----------------------------------------
# An empty board is the honest empty night: the delivery-safety contract and withheld-content contract say this is a run
# that happened, and a Job that reported failure here would be retried into
# spending the fleet's calls on the same true answer.
expect_exit 0 "a legitimately empty night" \
  docker run --rm --network "$NET" -e SB_STORE=memory "${MODEL[@]}" virgil-job:local
check "  and it names the reason" "no-session:nothing-to-teach" \
  "$(grep -o 'batch-outcome [a-z-]*:*[a-z-]*' "$WORK/out.txt" | tail -1 | cut -d' ' -f2)"

# --- 1, infrastructure ---------------------------------------------------------
# A board that will not parse. `JsonStore` refuses to treat an unreadable store
# as an empty one — losing every pin a learner saved is the failure that file
# exists to prevent — so the run cannot be completed, and that is the one case
# a Job retry can actually fix.
mkdir -p "$WORK/broken"
chmod 777 "$WORK/broken"
printf 'this is not json' >"$WORK/broken/store.json"
expect_exit 1 "a store that cannot be read" \
  docker run --rm --network "$NET" -v "$WORK/broken":/board \
  -e SB_DB=/board/store.json "${MODEL[@]}" virgil-job:local

# --- 2, configuration ----------------------------------------------------------
expect_exit 2 "a store spec the build does not recognise" \
  docker run --rm --network "$NET" -e SB_STORE=firestor:typo "${MODEL[@]}" virgil-job:local
# No FIRESTORE_EMULATOR_HOST and no VIRGIL_ALLOW_PRODUCTION, which is what a
# container gets by default — so this is refused at startup by the authorisation
# gate, before the question of whether the image even carries the adapter.
expect_exit 2 "firestore, refused at startup with no authorisation to leave the emulator" \
  docker run --rm --network "$NET" -e SB_STORE=firestore:demo "${MODEL[@]}" virgil-job:local
expect_exit 2 "a command the entrypoint does not have" \
  docker run --rm --network "$NET" "${MODEL[@]}" virgil-job:local runner/dist/cli.js nonsense

say "the job container listens on nothing"
# Cloud Run's contract for jobs: "the container shouldn't listen on a port or
# start a web server."
check "no port published by the image" "" \
  "$(docker image inspect virgil-job:local --format '{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}' | tr -d '[:space:]')"

say "the service: the container contract"

SVC=virgil-smoke-svc
# The service-protection contract’s shared secret. Not a credential — it exists for the length of this
# script and reaches no project — but it is a real one in the only sense that
# matters here: the service was handed it and this script has to present it.
SECRET=smoke-secret-long-enough-to-be-one

# A container that binds every interface with no secret is an unauthenticated
# destructive API the platform would report as healthy. It refuses to start, and
# that refusal is a config failure rather than an infrastructure one.
expect_exit 2 "an exposed service with no shared secret refuses to start" \
  docker run --rm --network "$NET" \
  -e PORT=8080 -e K_SERVICE=virgil-service -e SB_STORE=memory "${MODEL[@]}" \
  virgil-service:local

docker rm -f "$SVC" >/dev/null 2>&1 || true
# PORT is what the platform injects; K_SERVICE is what tells the process it is
# on the platform. Both are set here exactly as Cloud Run sets them.
docker run -d --name "$SVC" --network "$NET" \
  -e PORT=8080 -e K_SERVICE=virgil-service -e SB_STORE=memory \
  -e "SB_SHARED_SECRET=$SECRET" "${MODEL[@]}" \
  virgil-service:local >/dev/null
sleep 2

# From a *different* container on the network — the whole point. A service
# bound to 127.0.0.1 answers itself and nothing else, which is precisely the
# defect this proves is gone.
CURL_IMAGE=$BUILDER
KNOCK="{ 'x-virgil-secret': '$SECRET' }"

# The door, from across the network, before anything is asked to go through it.
shut=$(docker run --rm --network "$NET" "$CURL_IMAGE" \
  node -e "fetch('http://$SVC:8080/health').then(r=>console.log(r.status))" 2>&1 | tail -1)
check "refuses a request with no shared secret" 401 "$shut"

health=$(docker run --rm --network "$NET" "$CURL_IMAGE" \
  node -e "fetch('http://$SVC:8080/health', { headers: $KNOCK }).then(r=>r.text()).then(t=>console.log(t))" 2>&1 | tail -1)
check "answers /health from another container" \
  '{"ok":true,"pins":0,"compatibility":{"protocol":"virgil-browser-service","serviceSchema":1,"minClientSchema":1,"maxClientSchema":1,"modelConfigSchema":1}}' "$health"

pin=$(docker run --rm --network "$NET" "$CURL_IMAGE" node -e "
fetch('http://$SVC:8080/pins', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-virgil-secret': '$SECRET' },
  body: JSON.stringify({ type: 'interest', envelope: {
    url: 'https://example.invalid/a', pageTitle: 'A page', headingPath: ['H'],
    selection: 'the ack deadline', parts: [] } }),
}).then(r => r.status).then(s => console.log(s))" 2>&1 | tail -1)
check "accepts a capture over the network" 201 "$pin"

warm=$(docker logs "$SVC" 2>&1 | grep -c 'fast tier' || true)
check "bought no model call at boot" 0 "$warm"
check "bound every interface" 1 "$(docker logs "$SVC" 2>&1 | grep -c 'http://0.0.0.0:8080' || true)"

# `docker stop` sends SIGTERM and then SIGKILL after a grace period — the same
# shape Cloud Run uses, and the only local way to exercise the drain.
docker stop -t 20 "$SVC" >/dev/null
check "drained on SIGTERM rather than being killed" 1 \
  "$(docker logs "$SVC" 2>&1 | grep -c 'shutdown drained' || true)"
check "exited 0 after the drain" 0 "$(docker inspect "$SVC" --format '{{.State.ExitCode}}')"
docker rm -f "$SVC" >/dev/null

say "the images carry no secret"
for image in virgil-job:local virgil-service:local; do
  found=$(docker run --rm --network none --entrypoint /nodejs/bin/node "$image" -e "
    const { readdirSync, readFileSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const bad = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile() || statSync(p).size > 2_000_000) continue;
      const t = readFileSync(p, 'utf8');
      // Two shapes of leaked key: a Google key value anywhere, and an
      // env-file-style assignment to a literal. Code is exempt on purpose —
      // \`=== undefined\` comparisons and the ADK dependency tree's README
      // examples (\`const GEMINI_API_KEY = process.env...\`) are how this scan
      // went red with zero secrets in the image.
      // Both key shapes: classic AIza keys, and AI Studio's newer AQ.-prefixed
      // ones (measured 2026-08-25 at ~53 chars) — a scan that knows only the
      // old shape waves the new one through.
      if (/AIza[0-9A-Za-z_-]{35}/.test(t)
        || /\bAQ\.[A-Za-z0-9_-]{20,}/.test(t)
        || /GEMINI_API_KEY\s*=(?!=)\s*(?!process\.env)[\"']?[A-Za-z0-9_-]{16,}/.test(t)) bad.push(p);
    } };
    walk('/app');
    console.log(bad.length);
  " 2>&1 | tail -1)
  check "no key material in $image" 0 "$found"
done

say "result"
printf '  %s passed, %s failed\n\n' "$pass" "$fail"
[ "$fail" = 0 ]
