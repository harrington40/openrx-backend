# OpenRx UI tests (Playwright, Python)

Browser tests for the React SPA. They mirror the API test layout
(`backend/tests/api-tests/`) and are organized the same way: a **route catalog**
drives a smoke sweep (one UI case per navigable route), and per-feature modules
add depth for the important screens.

## Layout

| Path | Purpose |
|------|---------|
| `config.py` | All settings, environment-driven (`Settings`, `load_settings`) |
| `auth.py` | Mints a session / role-overridden session as a Playwright storage state |
| `routes.py` | Catalog of SPA routes derived from `interface/new/src/App.tsx` |
| `roles.py` | Catalog of staff roles → dashboard, landing route, expected heading |
| `pages/` | Page objects (`BasePage`, `LoginPage`, `RoleDashboardPage`) |
| `conftest.py` | Fixtures + `pytest_generate_tests` (one case per route / per role) |
| `test_smoke_routes.py` | Route-render sweep — every navigable route |
| `test_auth_ui.py` | Login form, redirects, error handling |
| `test_dicom_ui.py` | DICOM / CT viewer chrome, tools, upload area |
| `test_role_dashboards_ui.py` | Role dashboards + access-control (registrar, physician, nurse, admin, midwife, lab) |

## Setup

```bash
cd openemr/tests/ui-tests
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m playwright install chromium      # downloads the browser once
```

## Running

```bash
./run.sh                       # whole suite
./run.sh -k smoke              # only the route sweep
./run.sh -m roles              # only the role dashboards (all six roles)
./run.sh -k role_sidebar       # access-control isolation cases only
UI_DOMAINS=patients,dicom ./run.sh
# deliberate read-only production run (opt-in required)
UI_BASE_URL=https://openrx.transtechologies.com UI_TOKEN=<token> UI_ALLOW_PRODUCTION=true ./run.sh
```

Playwright flags pass through (`./run.sh --headed`, `--slowmo=500`, `--tracing=on`).

## Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `UI_BASE_URL` | `http://localhost:5173` | SPA origin (app is served at the root — no prefix) |
| `UI_API_URL` | `http://localhost:3202/api` | API base, used to mint a session (the throwaway test backend) |
| `UI_USER` / `UI_PASSWORD` | `admin` / `admin123` | Credentials used to obtain a session |
| `UI_TOKEN` | *(unset)* | Pre-minted bearer token; skips login entirely |
| `UI_TIMEOUT_MS` | `15000` | Per-action timeout (ms) |
| `UI_DOMAINS` | *(all)* | Comma list to focus a run, e.g. `patients,dicom` |
| `UI_NAV_WAIT` | `domcontentloaded` | Playwright wait state after navigation |
| `UI_ALLOW_PAGE_ERRORS` | `false` | `true` to not fail on uncaught page errors |
| `UI_STORAGE_STATE` | *(unset)* | Reuse a Playwright storage-state JSON file |
| `UI_ALLOW_PRODUCTION` | `false` | Set `true` to allow targeting the live/main server (refused otherwise) |

> **Never point these at the main server by accident.** `load_settings()` fails
> closed: if `UI_BASE_URL` or `UI_API_URL` host the live deployment
> (`openrx.transtechologies.com` / `94.250.201.58`), the suite raises
> `ProductionAccessError` before any test runs. A deliberate read-only production
> run must set `UI_ALLOW_PRODUCTION=true`. The default `UI_API_URL` is the
> throwaway test backend on `:3202`, not the `:3002` dev backend whose
> `backend/.env` may be wired to a real database. See `test_config_guard.py`.

**Authentication:** the SPA stores its session in `localStorage['openemr_user']`.
`auth.py` obtains a session via `POST /api/auth/login` (or `UI_TOKEN`) and seeds
that entry through a Playwright *storage state*, so authenticated pages render
without driving the login form in every test. `test_auth_ui.py` still exercises
the real form.

## Role-based dashboard tests

`test_role_dashboards_ui.py` runs one case set per staff role — **Registrar,
Physician, Nurse Aide, Administrator, Midwife and Laboratory** — driven by the
`roles.py` catalog (mirroring how `routes.py` drives the smoke sweep):

| Role | localStorage `role` | Lands on | Dashboard (asserted heading) |
|------|---------------------|----------|------------------------------|
| Registrar | `front_desk` | `/registrar-dashboard` | Registrar Dashboard |
| Physician | `physician` | `/provider-dashboard` | Quick Actions |
| Nurse Aide | `nurse` (`main_menu_role: nurse`) | `/nurse-dashboard` | Nurse Aide Dashboard |
| Administrator | `admin` | `/dashboard` | Administration (`/admin`) |
| Midwife | `midwife` | `/midwife-dashboard` | Midwife Dashboard |
| Laboratory | `lab_tech` | `/lab-tech-dashboard` | Lab Technician Dashboard (+ Laboratory Management) |

Each role gets four to five cases: the dashboard renders its stable heading with
no error screen; visiting `/` lands the role on its own dashboard; the
role-filtered sidebar links to the role's own dashboard; foreign roles'
dashboards stay hidden; and any secondary role pages (Lab Management, Clinic
Overview) render.

**How the role is simulated:** the SPA reads the signed-in user — *including the
role* — from `localStorage['openemr_user']` and uses it purely for **client-side
gating** (the `/` redirect, the sidebar filters, role-only controls). API
authorisation still uses the JWT. `auth.role_storage_state()` therefore keeps the
session token but overrides the stored role, so every role's UI can be exercised
from a single account — no backend user per role required. The cases skip when no
session can be minted.

## Relationship to the API tests

Every API domain that has a UI surface has a route here, and the smoke sweep
gives one UI case per route:

| API domain (`api-tests/`) | UI route(s) / module |
|---------------------------|----------------------|
| `auth` | `/login`, `/register`, `/callback` → `test_auth_ui.py` |
| `patients` | `/dashboard`, `/patients`, `/patients/:id` |
| `imaging` | `/dicom` → `test_dicom_ui.py` |
| `documents` | `/documents` |
| `appointments` | `/appointments`, `/flow`, `/recall`, `/screening` |
| `billing` | `/billing`, `/billing/medical` |
| `labs` | `/labs`, `/lab-results`, `/lab-dashboard` |
| `messaging` / `patient-chat` | `/messages`, `/messages/patient-chat` |
| `admin` | `/admin`, `/db-admin` |
| portal | `/portal/*` (separate auth model) |

Beyond the per-route sweep, the role dashboards get dedicated coverage:

| Role (backend) | UI dashboard | Module |
|----------------|--------------|--------|
| `front_desk` (registrar) | `/registrar-dashboard` | `test_role_dashboards_ui.py` |
| `physician` | `/provider-dashboard` | `test_role_dashboards_ui.py` |
| `nurse` (nurse aide) | `/nurse-dashboard` | `test_role_dashboards_ui.py` |
| `admin` | `/admin`, `/dashboard` | `test_role_dashboards_ui.py` |
| `midwife` | `/midwife-dashboard` | `test_role_dashboards_ui.py` |
| `lab_tech` | `/lab-tech-dashboard`, `/lab-dashboard` | `test_role_dashboards_ui.py` |

## Extending

- **New route** → add it to `routes.py`; the smoke sweep picks it up automatically.
- **New role** → add it to `roles.py`; the role sweep picks it up automatically.
- **New feature module** → add `test_<domain>_ui.py` with specific assertions and
  a page object under `pages/`.
