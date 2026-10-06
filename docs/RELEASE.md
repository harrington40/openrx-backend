# Release process

How OpenRx is versioned and how a customer release is cut.

## Versioning

- **Single source of truth:** the root **`VERSION`** file (semver, e.g. `1.4.0`).
- **Git tags:** each release is tagged **`vX.Y.Z`** (annotated).
- **The number ships in the build:** `tools/release.py set <version>` writes it to
  `VERSION`, both `package.json` files, and
  `backend/src/config/version.ts` — which is compiled into `backend/dist`, so the
  **`/config`** endpoint reports it (`APP_VERSION` overrides at runtime).

```bash
python3 tools/release.py current                 # print the current version
python3 tools/release.py bump patch|minor|major  # bump VERSION (+stamp everywhere)
python3 tools/release.py set 1.4.0               # set an explicit version
python3 tools/release.py check 1.4.0             # validate semver + tag is free
python3 tools/release.py notes --version 1.4.0   # markdown notes from git history
```

## The three Jenkins jobs

| Job | Trigger | What it does |
|-----|---------|--------------|
| **OpenRx-CI** | every 35 min | backend unit + API tests → reliability report |
| **OpenRx-Nightly** | nightly | the above **plus** Vitest + Playwright UI sweep |
| **OpenRx-Release** | **manual** | versioned customer release (below) |
| **OpenRx-Smoke** | nightly | read-only production health check (no release/deploy) |

All three run from the same repo; the two CI jobs use `Jenkinsfile`, the release
uses `Jenkinsfile.release` (see `jenkins/jobs.groovy`).

## Cutting a release (runbook)

1. Make sure `main` is green (OpenRx-CI / OpenRx-Nightly passing).
2. Decide the next version (semver): patch = fixes, minor = features, major = breaking.
3. Jenkins → **OpenRx-Release** → **Build with Parameters**:
   - `RELEASE_VERSION` = e.g. `1.4.0`
   - `DRY_RUN = true` for the first pass (does everything except push/deploy)
   - `BUILD_FRONTEND`, `RUN_TESTS` as needed
4. Review the build (test gate, artifacts, `RELEASE_NOTES-<version>.md`).
5. Re-run with `DRY_RUN = false` (and `DEPLOY = true` to ship). That will:
   - stamp the version, build the backend (+ SPA), package
     `openrx-backend-<version>.tar.gz` / `openrx-frontend-<version>.tar.gz`,
   - commit `chore(release): v<version>`, tag `v<version>`, push both,
   - (optional) deploy the backend to the customer server.

### Pipeline stages

`Checkout` → `Validate version` → `Test gate` (gated: Jest + Vitest) → `Stamp
version + build backend` (with a **version-consistency gate**) → `Build SPA`
(gated) → `Assemble unified package` → `Verify package contents` → `Scan for
secrets` → `Package release artifacts` → `Commit version + tag + push` (gated) →
`GitHub release` (gated) → `Deploy (customer)` (gated, ships the already-built
artifacts — never rebuilds) → `Post-deploy smoke` (gated). Artifacts are archived
from `release/**`.

The **`GitHub release`** stage creates a GitHub Release for the pushed tag
`v<version>`, using `release/RELEASE_NOTES-<version>.md` as its body and
uploading `openrx-<version>.tar.gz` + `BUILD_INFO.json` as release assets
(`tools/release.py github-release`, idempotent). It is skipped in `DRY_RUN`, when
`PUSH_TAG=false`, or when `GITHUB_RELEASE=false`.

The **`Post-deploy smoke`** stage (gated by `DEPLOY && !DRY_RUN`) proves the
running deployment actually works before the release is called done:
`GET /api/config` returns the released version, the SPA root serves
`index.html` with a reachable `/assets/…` bundle, a login returns a token, and
key read-only routes (`/api/patients`, `/api/appointments`, `/api/providers`)
answer `200`. If it fails the release fails; set `SMOKE_ROLLBACK=true` to roll
the backend back one release automatically.

```bash
# the same check by hand, against any origin
python3 tools/release.py smoke --base-url https://openrx.transtechologies.com \
    --expected-version 1.0.0 --user <user> --password <pass>
```

### Release artifacts

```
release/openrx-<version>.tar.gz            # canonical customer package
release/openrx-backend-<version>.tar.gz    # backend dist/ (server deploy.sh --backend)
release/openrx-frontend-<version>.tar.gz   # SPA dist/ (server deploy.sh --frontend)
release/RELEASE_NOTES-<version>.md
release/BUILD_INFO.json
```

The canonical package mirrors the production layout (the backend is API-only;
the SPA is served at the site root by the web server):

```
openrx-<version>/
    backend/
        dist/                 # compiled backend (main.js, ...)
        package.json          # runtime metadata (node_modules is NOT packaged)
        package-lock.json
    public/
        dist/
            index.html
            assets/
    VERSION
    BUILD_INFO.json
    RELEASE_NOTES-<version>.md
```

`BUILD_INFO.json` records `version`, `gitCommit`, `gitShortCommit`, `buildTime`
(UTC ISO-8601), `backendVersion`, `frontendVersion` — never any secret.

Gates that fail the release: a version mismatch across `VERSION`,
`backend/package.json`, `interface/new/package.json`, `backend/src/config/version.ts`;
a missing component or an `index.html` asset that isn't present; or a
secret/config file (`.env`, `*.pem`, `*.key`, `id_rsa*`, `*.sql`, `.git`) in the
package.

## Credentials the release job needs

- **`openrx-github`** — a Jenkins *Username with password* credential holding a
  GitHub token with **repo write** access, so the job can push the version commit
  and the `v<version>` tag, and create the GitHub Release. (Create under Manage
  Jenkins → Credentials; the id matches `GIT_CREDENTIALS` in `Jenkinsfile.release`.)
- **`openrx-smoke`** — a Jenkins *Username with password* credential with a
  production login used by the post-deploy smoke test (only when
  `SMOKE_LOGIN=true`).
- For `DEPLOY`: the same `DEPLOY_SSH_KEY` / `DEPLOY_SERVER` / `DEPLOY_REMOTE_DIR`
  the CI pipeline uses.

## Rollback

The customer server keeps the last `DEPLOY_KEEP` releases; `deploy.sh` on the
server swaps back:

```bash
ssh <server> 'cd <remote_dir> && ./deploy.sh --rollback --backend 1'
```

Re-tagging a version is refused by `release.py check`; cut a new patch release
instead (semver: never reuse a number).
