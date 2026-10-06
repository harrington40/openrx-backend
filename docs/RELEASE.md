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

`Checkout` → `Validate version` → `Test gate` (gated) → `Stamp version + build
backend` → `Build SPA` (gated) → `Package release artifacts` → `Commit version +
tag + push` (gated) → `Deploy (customer)` (gated). Artifacts are archived from
`release/**`.

## Credentials the release job needs

- **`openrx-github`** — a Jenkins *Username with password* credential holding a
  GitHub token with **repo write** access, so the job can push the version commit
  and the `v<version>` tag. (Create under Manage Jenkins → Credentials; the id
  matches `GIT_CREDENTIALS` in `Jenkinsfile.release`.)
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
