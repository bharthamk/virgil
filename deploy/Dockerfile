# syntax=docker/dockerfile:1
#
# Virgil's two containers, from one builder.
#
#   docker build -f deploy/Dockerfile --target job     -t virgil-job .
#   docker build -f deploy/Dockerfile --target service -t virgil-service .
#
# Two targets rather than two files because they share every layer up to the
# compile, and the thing most worth guaranteeing about them is that the nightly
# and the service are the *same build* of the same source. A drift between them
# is a class of bug that only appears in production.
#
# ## Runtime
#
# Node 24 is the release LTS used by CI and Cloud Run. The builder and distroless
# runtime are pinned by digest so a tag update cannot silently change a release.
#
# ## Pinned by digest, not by tag
#
# The tag remains documented beside each digest so maintainers can review the
# intended base before deliberately refreshing it.
#
# ## Nothing secret is in this file, or in any layer it makes
#
# Credentials are injected at run time from Secret Manager —
# see `deploy/job.yaml` and `deploy/service.yaml`. `.dockerignore` excludes
# `.env` and every board under `.data*/` from the context, so neither can be
# copied in by accident.

# Recorded on 2026-08-21 from the images this was built and smoke-tested
# against. Both are multi-architecture index digests, so they pin the same way
# for the local arm64 build and for the `--platform linux/amd64` build that
# the deployment needs. `node:24-bookworm` resolved to Node v24.19.0.
ARG BUILDER_IMAGE=node@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13@sha256:fbbdda866ea71aef98c4abece17e3d61fbf820cc2ef3961522caa2478716171a

# --------------------------------------------------------------------------
# build — the only stage with a compiler, a package manager or a shell in it
# --------------------------------------------------------------------------
FROM ${BUILDER_IMAGE} AS build
WORKDIR /src

# Manifests first, so a source edit does not re-run the install. Every
# workspace's package.json is needed: npm refuses to install a workspace set
# whose members it cannot see.
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY adapters/package.json adapters/
COPY runner/package.json runner/
COPY extension/package.json extension/
COPY adk/package.json adk/
COPY trigger/package.json trigger/

# `--ignore-scripts`: nothing in this tree has a lifecycle script, and an
# install that cannot run one is an install that cannot be surprised by a
# transitive package that grows one.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.base.json tsconfig.json ./
COPY core core
COPY adapters adapters
COPY runner runner
COPY extension extension
COPY adk adk
COPY trigger trigger

# `tsc -b` builds the project references in order. The selections overlay is
# what `npm run build` copies and `npm test` does not — without it the seed
# falls back to unverbatim selections, which is a different board from the one
# every measurement in this repository was taken on.
RUN npx tsc -b

# Tests do not ship. This is not only size: `__tests__` carries `StubLlm`, the
# fixture boards and the harness that constructs a store over a temp directory,
# and none of that should be one import away inside a production image.
#
# The extension's test output goes, but its full-page assets now stay for the
# service target: every Virgil deployment serves its board at `/app/`. The
# trigger still goes entirely. Both are built above — `tsc -b` follows
# the project references and cannot be told to skip one. The deployed event
# path is the service's request-bound Cloud Run Jobs API call; `trigger/` is an
# independently tested Pub/Sub design and not a runtime dependency.
#
# The Job loads `adk/dist` through `runner/dist/cli.js`, so only ADK test output
# is removed. `deploy-config.test.ts` protects this runtime dependency.
RUN rm -rf core/dist/__tests__ adapters/dist/__tests__ runner/dist/__tests__ \
           adk/dist/__tests__ extension/dist/__tests__ trigger/dist

# Leaves workspace links and runtime dependencies, including the dynamically
# imported Firestore driver, while removing TypeScript and other development
# packages. What survives here is
# `node_modules/@sb/*` plus the vendor trees the entrypoints actually load;
# `runner/src/__tests__/seam-purity.test.ts` names them one by one and `core/`
# is still on the no-vendor side of every one of those decisions.
RUN npm prune --omit=dev

# The browser-facing service never imports the ADK. Build its dependency tree
# separately so the ADK's telemetry exporters—and their current upstream
# baggage advisory—exist only in the non-HTTP Job image.
FROM ${BUILDER_IMAGE} AS service-deps
WORKDIR /service
COPY deploy/service-runtime/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN mkdir -p node_modules/@sb \
 && ln -s ../../core node_modules/@sb/core \
 && ln -s ../../adapters node_modules/@sb/adapters

# --------------------------------------------------------------------------
# runtime — distroless: no shell, no package manager, non-root by default
# --------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
WORKDIR /app

# Only the workspaces a run actually loads, plus the browser-safe board assets
# served by the service at `/app/`. `trigger` is not reached from either
# entrypoint and is not carried here.
#
# `adk` is here because the Job's nightly hosts itself in it. Its `package.json`
# comes with it for the same reason every other one does: it is what makes
# `node_modules/@sb/adk` resolve to `dist/index.js`.
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/core/package.json ./core/package.json
COPY --from=build /src/core/dist ./core/dist
COPY --from=build /src/adapters/package.json ./adapters/package.json
COPY --from=build /src/adapters/dist ./adapters/dist
COPY --from=build /src/adk/package.json ./adk/package.json
COPY --from=build /src/adk/dist ./adk/dist
# npm 11 installs @google/adk below its owning workspace rather than hoisting
# it to the root. Copying only /src/node_modules therefore leaves the ADK
# binding present but its dynamic import absent: the Job starts and exits 2
# before the first stage. Carry the pruned workspace-local tree beside the
# workspace whose dist resolves it.
COPY --from=build /src/adk/node_modules ./adk/node_modules
COPY --from=build /src/runner/package.json ./runner/package.json
COPY --from=build /src/runner/dist ./runner/dist
COPY --from=build /src/extension/web.html ./extension/web.html
COPY --from=build /src/extension/web-runtime.js ./extension/web-runtime.js
COPY --from=build /src/extension/panel.css ./extension/panel.css
COPY --from=build /src/extension/dist ./extension/dist
COPY --from=build /src/extension/assets ./extension/assets
COPY --from=build /src/extension/vendor ./extension/vendor

ENV NODE_ENV=production

# --------------------------------------------------------------------------
# job — the nightly. Runs once, exits, and is never asked for a port.
# --------------------------------------------------------------------------
FROM runtime AS job

# Cloud Run's container contract for jobs: *"Because jobs shouldn't serve
# requests, the container shouldn't listen on a port or start a web server."*
# There is deliberately no EXPOSE here and nothing in this entrypoint binds one.
#
# `nightly` is the default argument rather than an assumption, and that matters:
# the same `cli.js` also answers `seed`, which begins with `deleteEverything()`.
# A Job whose args are overridden to `seed` would wipe the board it was pointed
# at. The default is the safe command; `deploy/CLOUD_RUN.md` §7 carries this as
# a standing risk rather than pretending the shared entrypoint is free.
CMD ["runner/dist/cli.js", "nightly"]

# --------------------------------------------------------------------------
# service — the capture and panel API
# --------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS service
WORKDIR /app

COPY --from=service-deps /service/node_modules ./node_modules
COPY --from=build /src/core/package.json ./core/package.json
COPY --from=build /src/core/dist ./core/dist
COPY --from=build /src/adapters/package.json ./adapters/package.json
COPY --from=build /src/adapters/dist ./adapters/dist
COPY --from=build /src/runner/package.json ./runner/package.json
COPY --from=build /src/runner/dist ./runner/dist
COPY --from=build /src/extension/web.html ./extension/web.html
COPY --from=build /src/extension/web-runtime.js ./extension/web-runtime.js
COPY --from=build /src/extension/panel.css ./extension/panel.css
COPY --from=build /src/extension/dist ./extension/dist
COPY --from=build /src/extension/assets ./extension/assets
COPY --from=build /src/extension/vendor ./extension/vendor

ENV NODE_ENV=production

# Documentation only — Cloud Run injects `PORT` and the process reads it. 8080
# is the platform's default and what `service.yaml` declares.
EXPOSE 8080

CMD ["runner/dist/service.js"]
