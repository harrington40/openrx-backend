#!/usr/bin/env python3
"""Build a single, self-contained HTML reliability report for OpenRx.

Aggregates the automated suites in this repository — backend unit (Jest) and the
API contract/domain suite (pytest) — into one page that answers three questions:

    * what was tested        (the *kind* of each suite and its size),
    * how much passed        (results + execution ratio),
    * how much is covered    (API routes/domains, code coverage),

and distils those into an explicit, auditable **confidence level** per suite and
an overall **reliability index**.

Everything is best-effort and offline: a missing result file degrades gracefully
(the suite is shown as "not run in this snapshot") instead of failing the build.

Usage
-----
    python3 tools/build_reliability_report.py                 # write the HTML
    python3 tools/build_reliability_report.py --out report.html
    python3 tools/build_reliability_report.py --collect       # also re-count pytest

Inputs it looks for (all optional):
    backend/tests/api-tests/pytest-results.xml         API contract JUnit
    tests/reliability-artifacts/jest-results.json      Jest --json output
    tests/reliability-artifacts/jest-coverage-summary.json   Jest coverage
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
ARTIFACTS = TESTS / "reliability-artifacts"
#: Append-only record of each run's overall metrics; drives the trend chart.
HISTORY_DEFAULT = TESTS / "reliability-history.jsonl"

#: Line colours for the reliability trend chart (overall + one per suite).
TREND_COLORS = {
    "overall": "#0d6efd",
    "backend-unit": "#6f42c1",
    "frontend-unit": "#00c9a7",
    "api-contract": "#fd7e14",
    "api-e2e": "#dc3545",
    "ui": "#198754",
}

#: Test kinds, their weight in the reliability index, and how flaky/environment
#: dependent they are. Unit tests run in-process and are deterministic, so they
#: carry the most weight; browser/UI tests depend on a live stack, so less.
KIND_WEIGHT = {
    "unit": 1.00,
    "component": 0.90,
    "contract": 0.80,
    "e2e": 0.70,
    "ui": 0.60,
}

#: The suites this report knows about. ``collect`` describes how to (re)count a
#: pytest suite offline; JUnit/JSON paths are read when present.
SPECS = [
    {
        "id": "backend-unit",
        "name": "Backend unit tests",
        "kind": "unit",
        "framework": "Jest + ts-jest",
        "lang": "TypeScript",
        "path": "backend/src",
        "desc": "Service/controller logic with mocked I/O",
        "jest_json": ARTIFACTS / "jest-results.json",
        "coverage_json": ARTIFACTS / "jest-coverage-summary.json",
    },
    {
        "id": "api-contract",
        "name": "API contract & domain tests",
        "kind": "contract",
        "framework": "pytest + requests",
        "lang": "Python",
        "path": "backend/tests/api-tests",
        "desc": "Route inventory, guards, per-domain behaviour",
        "junit": ROOT / "backend/tests/api-tests/pytest-results.xml",
        "collect": {
            "cwd": ROOT / "backend/tests/api-tests",
            "venv": ROOT / "backend/tests/api-tests/.venv/bin/python",
        },
    },
]


@dataclass
class Result:
    """Outcome of one suite's most recent recorded run."""

    available: bool = False
    total: int = 0
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    errors: int = 0
    time_s: float = 0.0
    timestamp: str = ""
    source: str = ""
    failures: list[str] = field(default_factory=list)


@dataclass
class Suite:
    spec: dict
    collected: int | None = None
    result: Result = field(default_factory=Result)
    coverage: dict | None = None  # {'lines':.., 'branches':.., ...} 0..100

    @property
    def id(self) -> str:
        return self.spec["id"]

    @property
    def kind(self) -> str:
        return self.spec["kind"]

    @property
    def weight(self) -> float:
        return KIND_WEIGHT.get(self.kind, 0.7)

    @property
    def size(self) -> int:
        """Best available count of test cases (current catalog preferred)."""
        if self.collected:
            return self.collected
        if self.result.total:
            return self.result.total
        return 0


# --------------------------------------------------------------------------- #
# Input readers
# --------------------------------------------------------------------------- #

def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _parse_junit(path: Path) -> Result:
    res = Result(source=path.name)
    root = ET.parse(path).getroot()
    suites = root.findall("testsuite") or [root]
    for su in suites:
        res.total += int(su.get("tests", 0))
        res.failed += int(su.get("failures", 0))
        res.skipped += int(su.get("skipped", 0))
        res.errors += int(su.get("errors", 0))
        res.time_s += float(su.get("time", 0) or 0)
        res.timestamp = res.timestamp or (su.get("timestamp", "") or "")
    for case in root.iter("testcase"):
        bad = case.find("failure") is not None or case.find("error") is not None
        if bad:
            res.failures.append(f"{case.get('classname','')}::{case.get('name','')}")
    res.passed = max(0, res.total - res.failed - res.skipped - res.errors)
    res.available = True
    return res


def _python_candidates(cfg: dict) -> list[str]:
    """Interpreters to try for ``--collect-only``, best first.

    Prefers the suite's own venv, then any CI venv (``OPENRX_VENV`` / active
    ``VIRTUAL_ENV``), then the interpreter running this script.
    """
    paths = [str(cfg["venv"])]
    ci_venv = os.environ.get("OPENRX_VENV")
    if ci_venv:
        paths.append(str(Path(ci_venv) / "bin" / "python"))
    active = os.environ.get("VIRTUAL_ENV")
    if active:
        paths.append(str(Path(active) / "bin" / "python"))
    paths.append(sys.executable)
    seen, out = set(), []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _collect_pytest(cfg: dict) -> int | None:
    """Count a pytest suite offline via ``--collect-only`` (best effort)."""
    for python in _python_candidates(cfg):
        if "python" in python and not Path(python).exists():
            continue
        cmd = [python, "-m", "pytest", "--collect-only", "-q"]
        cmd += list(cfg.get("target", []))
        for ig in cfg.get("ignore", []):
            cmd.append(f"--ignore={ig}")
        try:
            proc = subprocess.run(
                cmd, cwd=cfg["cwd"], capture_output=True, text=True, timeout=180
            )
        except (OSError, subprocess.SubprocessError):
            continue
        m = re.search(r"(\d+)\s+tests? collected", proc.stdout) or re.search(
            r"(\d+)\s+tests? collected", proc.stderr
        )
        if m:
            return int(m.group(1))
    return None


def _jest_result(data: dict) -> Result:
    res = Result(source="jest-results.json")
    res.total = int(data.get("numTotalTests", 0))
    res.passed = int(data.get("numPassedTests", 0))
    res.failed = int(data.get("numFailedTests", 0))
    start = data.get("startTime")
    if start:
        res.timestamp = _dt.datetime.fromtimestamp(
            start / 1000, tz=_dt.timezone.utc
        ).isoformat()
    for tr in data.get("testResults", []):
        for a in tr.get("assertionResults", []):
            if a.get("status") == "failed":
                res.failures.append(f"{a.get('ancestorTitles', [''])[-1]} :: {a.get('title','')}")
    res.available = res.total > 0
    return res


def _vitest_result(data: dict) -> Result:
    res = Result(source="vitest-results.json")
    res.total = int(data.get("numTotalTests", 0))
    res.passed = int(data.get("numPassedTests", 0))
    res.failed = int(data.get("numFailedTests", 0))
    res.skipped = int(data.get("numPendingTests", 0)) + int(data.get("numTodoTests", 0))
    for tr in data.get("testResults", []):
        for a in tr.get("assertionResults", []):
            if a.get("status") == "failed":
                res.failures.append(f"{tr.get('name','').split('/')[-1]} :: {a.get('title','')}")
    res.available = res.total > 0
    return res


def _coverage_from_summary(path: Path) -> dict | None:
    """Read a Jest/Vitest ``coverage-summary.json`` -> percentages."""
    data = _read_json(path)
    if not data:
        return None
    total = data.get("total") or {}
    out = {}
    for key, label in (
        ("lines", "lines"),
        ("statements", "statements"),
        ("functions", "functions"),
        ("branches", "branches"),
    ):
        pct = (total.get(key) or {}).get("pct")
        if isinstance(pct, (int, float)):
            out[label] = round(float(pct), 1)
    return out or None


def _structural_coverage() -> dict:
    """Route/role/domain coverage derived from the test catalogs (always on)."""
    out: dict = {}
    try:
        sys.path.insert(0, str(ROOT / "backend/tests/api-tests"))
        from api_routes import API_ROUTES  # type: ignore

        domains = {
            r.controller.split("/")[1]
            for r in API_ROUTES
            if r.controller.startswith("src/") and "/" in r.controller
        }
        out["api_routes_total"] = len(API_ROUTES)
        out["api_domains_total"] = len(domains)
    except Exception:
        pass
    try:
        sys.path.insert(0, str(TESTS / "ui-tests"))
        from roles import ROLES  # type: ignore
        from routes import ROUTES, navigable_routes  # type: ignore

        out["ui_routes_total"] = len(ROUTES)
        out["ui_routes_navigable"] = len(navigable_routes())
        out["ui_roles_total"] = len(ROLES)
    except Exception:
        pass
    return out


def gather(do_collect: bool) -> tuple[list[Suite], dict]:
    suites: list[Suite] = []
    for spec in SPECS:
        suite = Suite(spec=spec)

        collect_cfg = spec.get("collect")
        if collect_cfg:
            if do_collect:
                suite.collected = _collect_pytest(collect_cfg)
            else:
                # Cheap fallback: reuse a cached count if one was written.
                cached = _read_json(ARTIFACTS / f"{spec['id']}-collected.json")
                if cached:
                    suite.collected = cached.get("collected")

        if "jest_json" in spec:
            data = _read_json(spec["jest_json"])
            if data:
                suite.result = _jest_result(data)
        elif "vitest_json" in spec:
            data = _read_json(spec["vitest_json"])
            if data:
                suite.result = _vitest_result(data)
        elif "junit" in spec and Path(spec["junit"]).exists():
            suite.result = _parse_junit(Path(spec["junit"]))

        cov = _read_json(spec["coverage_json"]) if "coverage_json" in spec else None
        if cov:
            suite.coverage = _coverage_from_summary(spec["coverage_json"])

        suites.append(suite)

    return suites, _structural_coverage()


# --------------------------------------------------------------------------- #
# Scoring — an explicit, auditable confidence model
# --------------------------------------------------------------------------- #

def _pct(n: float, d: float) -> float:
    return round(100.0 * n / d, 1) if d else 0.0


def confidence_label(score: float) -> str:
    if score >= 90:
        return "High"
    if score >= 75:
        return "Moderate"
    return "Low"


def score_suite(suite: Suite) -> dict | None:
    """Return per-suite metrics + a 0-100 confidence score, or None if no run.

    Formula (documented on the page):
        with code coverage    score = 100*(0.60*pass + 0.20*execution + 0.20*cov)
        without               score = 100*(0.75*pass + 0.25*execution)
    where pass = passed/(total-skipped), execution = (total-skipped)/total.
    """
    r = suite.result
    if not r.available or r.total == 0:
        return None
    executed = max(0, r.total - r.skipped)
    passed = r.passed
    pass_rate = (passed / executed) if executed else 0.0
    execution = (executed / r.total) if r.total else 0.0

    cov_pct = None
    if suite.coverage:
        vals = list(suite.coverage.values())
        if vals:
            cov_pct = sum(vals) / len(vals)

    if cov_pct is not None:
        score = 100.0 * (0.60 * pass_rate + 0.20 * execution + 0.20 * cov_pct / 100.0)
    else:
        score = 100.0 * (0.75 * pass_rate + 0.25 * execution)

    label = confidence_label(score)
    # A suite with any failing (or erroring) case can never claim "High" —
    # green tests are the whole point.
    if (r.failed or r.errors) and label == "High":
        label = "Moderate"

    return {
        "executed": executed,
        "pass_rate": round(pass_rate * 100, 1),
        "execution": round(execution * 100, 1),
        "coverage": round(cov_pct, 1) if cov_pct is not None else None,
        "score": round(score, 1),
        "label": label,
    }


def overall(suites: list[Suite], struct: dict) -> dict:
    """Blend the weighted test score with the coverage signals."""
    import math

    num = den = 0.0
    for s in suites:
        m = score_suite(s)
        if not m:
            continue
        w = s.weight * math.sqrt(max(s.size, 1))
        num += m["score"] * w
        den += w
    test_score = round(num / den, 1) if den else 0.0

    # Coverage signals (0-100 each), whichever are available.
    signals: list[tuple[str, float]] = []
    for s in suites:
        if s.coverage:
            lines = s.coverage.get("lines")
            if lines is not None:
                signals.append((f"{s.spec['name']} — lines", lines))
    if struct.get("api_routes_total"):
        signals.append(("API routes with a test case", 100.0))
    if struct.get("ui_routes_total") and struct.get("ui_routes_navigable"):
        signals.append((
            "UI routes with a render smoke case",
            _pct(struct["ui_routes_navigable"], struct["ui_routes_total"]),
        ))
    if struct.get("ui_roles_total"):
        signals.append(("Staff roles with dashboard cases", 100.0))

    cov_score = round(sum(v for _, v in signals) / len(signals), 1) if signals else 0.0
    reliability = round(0.75 * test_score + 0.25 * cov_score, 1)

    return {
        "test_score": test_score,
        "coverage_score": cov_score,
        "reliability": reliability,
        "label": confidence_label(reliability),
        "signals": signals,
    }


# --------------------------------------------------------------------------- #
# HTML rendering (single self-contained file — no external assets)
# --------------------------------------------------------------------------- #

CSS = """
:root{--bg:#0f172a;--surface:#ffffff;--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;
--high:#198754;--mod:#fd7e14;--low:#dc3545;--accent:#0d6efd;--accent2:#00c9a7;}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
color:var(--ink);background:linear-gradient(160deg,#eef4ff 0%,#f7fffb 55%,#eaf7f1 100%);line-height:1.5}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
header.hero{background:linear-gradient(135deg,#0d6efd 0%,#6610f2 50%,#00c9a7 100%);color:#fff;
border-radius:20px;padding:26px 28px;box-shadow:0 18px 40px rgba(13,110,253,.25)}
header.hero h1{margin:0 0 4px;font-size:1.7rem}
header.hero p{margin:0;opacity:.9;font-size:.9rem}
.grid{display:grid;gap:16px}
.cards{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:20px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px 18px;
box-shadow:0 8px 22px rgba(15,23,42,.06)}
.card .n{font-size:1.7rem;font-weight:700}
.card .l{color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
section{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px 24px;
margin-top:20px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
section h2{margin:0 0 4px;font-size:1.15rem}
section .sub{color:var(--muted);font-size:.85rem;margin:0 0 16px}
table{width:100%;border-collapse:collapse;font-size:.86rem}
th,td{text-align:left;padding:10px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.7rem;font-weight:600}
.tag.unit{background:#e7f1ff;color:#0d6efd}.tag.component{background:#eafaf3;color:#0f9d6b}
.tag.contract{background:#f2ecff;color:#6f42c1}.tag.e2e{background:#fff2e2;color:#c2600a}
.tag.ui{background:#e6f7fb;color:#0d7a99}
.badge{display:inline-block;padding:3px 11px;border-radius:999px;font-size:.74rem;font-weight:700;color:#fff}
.badge.High{background:var(--high)}.badge.Moderate{background:var(--mod)}.badge.Low{background:var(--low)}
.badge.unknown{background:#9ca3af}
.bar{height:9px;border-radius:6px;background:#eef1f5;overflow:hidden;min-width:90px}
.bar>span{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,#0d6efd,#00c9a7)}
.coverage-row{display:grid;grid-template-columns:1fr 60px;gap:14px;align-items:center;margin:9px 0}
.coverage-row .lbl{font-size:.86rem}
.pct{font-weight:700;font-size:.86rem;text-align:right}
.gauge{display:flex;gap:26px;align-items:center;flex-wrap:wrap}
.gauge .cap{max-width:420px}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:.78rem;margin-top:6px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
code{background:#f3f4f6;padding:1px 6px;border-radius:5px;font-size:.82rem}
ul.fail{margin:6px 0 0 18px;padding:0}
ul.fail li{margin:3px 0;font-size:.85rem}
.note{background:#fbfbfa;border:1px dashed var(--line);border-radius:12px;padding:12px 14px;margin-top:14px;
font-size:.82rem;color:#475569}
footer{color:var(--muted);font-size:.8rem;margin-top:26px;text-align:center}
.muted{color:var(--muted)}
"""


def _badge(label: str) -> str:
    cls = label if label in ("High", "Moderate", "Low") else "unknown"
    return f'<span class="badge {cls}">{label}</span>'


def _bar(pct: float | None) -> str:
    if pct is None:
        return '<span class="muted">n/a</span>'
    width = max(0.0, min(100.0, float(pct)))
    return f'<div class="bar"><span style="width:{width:.1f}%"></span></div>'


def _fmt_ts(ts: str) -> str:
    if not ts:
        return "—"
    return ts.replace("T", " ")[:19]


def _gauge_svg(pct: float, label: str) -> str:
    import math

    r = 52.0
    circ = 2 * math.pi * r
    dash = circ * max(0.0, min(100.0, pct)) / 100.0
    color = {"High": "#198754", "Moderate": "#fd7e14", "Low": "#dc3545"}.get(label, "#9ca3af")
    return (
        '<svg width="150" height="150" viewBox="0 0 150 150" role="img">'
        f'<circle cx="75" cy="75" r="{r:.0f}" fill="none" stroke="#eef1f5" stroke-width="15"/>'
        f'<circle cx="75" cy="75" r="{r:.0f}" fill="none" stroke="{color}" stroke-width="15" '
        f'stroke-linecap="round" stroke-dasharray="{dash:.1f} {circ - dash:.1f}" '
        f'transform="rotate(-90 75 75)"/>'
        f'<text x="75" y="73" text-anchor="middle" font-size="30" font-weight="700" '
        f'fill="{color}">{pct:.0f}</text>'
        '<text x="75" y="93" text-anchor="middle" font-size="11" fill="#6b7280">/ 100</text>'
        "</svg>"
    )


def _suite_table(suites: list[Suite]) -> str:
    rows = []
    for s in suites:
        m = score_suite(s)
        r = s.result
        badge = _badge(m["label"]) if m else '<span class="badge unknown">Not run</span>'
        recorded_cell = f'{r.total:,}' if r.available else '<span class="muted">—</span>'
        collected_cell = f'{s.collected:,}' if s.collected else '<span class="muted">—</span>'
        rate = f'{m["pass_rate"]:.1f}%' if m else '<span class="muted">—</span>'
        rows.append(
            "<tr>"
            f'<td><strong>{html.escape(s.spec["name"])}</strong><br>'
            f'<span class="muted">{html.escape(s.spec["desc"])}</span></td>'
            f'<td><span class="tag {s.kind}">{s.kind}</span></td>'
            f'<td>{html.escape(s.spec["framework"])}<br>'
            f'<span class="muted">{html.escape(s.spec["lang"])}</span></td>'
            f'<td style="text-align:right">{collected_cell}</td>'
            f'<td style="text-align:right">{recorded_cell}</td>'
            f'<td style="text-align:right">{r.passed:,}</td>'
            f'<td style="text-align:right">{r.failed:,}</td>'
            f'<td style="text-align:right">{r.skipped:,}</td>'
            f'<td style="text-align:right">{rate}</td>'
            f'<td>{badge}</td>'
            "</tr>"
        )
    return (
        "<table><thead><tr>"
        "<th>Suite</th><th>Kind</th><th>Framework</th>"
        "<th style='text-align:right'>Catalogued</th>"
        "<th style='text-align:right'>Last run</th>"
        "<th style='text-align:right'>Passed</th>"
        "<th style='text-align:right'>Failed</th>"
        "<th style='text-align:right'>Skipped</th>"
        "<th style='text-align:right'>Pass rate</th><th>Confidence</th>"
        "</tr></thead><tbody>" + "".join(rows) + "</tbody></table>"
    )


def _structural_rows(struct: dict, agg: dict) -> str:
    rows = []
    if struct.get("api_routes_total"):
        rows.append(
            '<p class="sub">Inventory: '
            f'<strong>{struct["api_routes_total"]}</strong> API routes across '
            f'<strong>{struct.get("api_domains_total", "?")}</strong> domains; '
            f'<strong>{struct.get("ui_routes_total", "?")}</strong> UI routes '
            f'(<strong>{struct.get("ui_routes_navigable", "?")}</strong> render-smoke); '
            f'<strong>{struct.get("ui_roles_total", "?")}</strong> staff roles.</p>'
        )
    for label, pct in agg["signals"]:
        rows.append(
            f'<div class="coverage-row"><div class="lbl">{label}</div>'
            f'<div class="pct">{pct:.0f}%</div></div>{_bar(pct)}'
        )
    return "".join(rows)


def _coverage_rows(suites: list[Suite]) -> str:
    rows = []
    for s in suites:
        if not s.coverage:
            continue
        for key in ("lines", "statements", "functions", "branches"):
            if key in s.coverage:
                pct = s.coverage[key]
                rows.append(
                    f'<div class="coverage-row"><div class="lbl">{s.spec["name"]} — {key}</div>'
                    f'<div class="pct">{pct:.1f}%</div></div>{_bar(pct)}'
                )
    if not rows:
        rows.append(
            '<p class="muted">No code-coverage report found in '
            '<code>tests/reliability-artifacts/</code>. Backend: run '
            '<code>npx jest --coverage --coverageReporters=json-summary</code> and copy the '
            'summary to that folder. Frontend coverage needs <code>@vitest/coverage-v8</code>.</p>'
        )
    return "".join(rows)


def _failures_html(suites: list[Suite]) -> str:
    all_fail = [(s.spec["name"], f) for s in suites for f in s.result.failures]
    if not all_fail:
        return '<p class="muted">No failing tests in the recorded runs.</p>'
    return "<ul class='fail'>" + "".join(
        f"<li><strong>{html.escape(name)}</strong> — <code>{html.escape(f)}</code></li>"
        for name, f in all_fail
    ) + "</ul>"


def metrics(suites: list[Suite], struct: dict, generated: str) -> dict:
    """Machine-readable metrics (for CI trend tracking / a build badge)."""
    agg = overall(suites, struct)
    recorded = sum(s.result.total for s in suites if s.result.available)
    catalogued = sum(s.size for s in suites)
    passed = sum(s.result.passed for s in suites)
    failed = sum(s.result.failed for s in suites)
    skipped = sum(s.result.skipped for s in suites)

    suite_list = []
    for s in suites:
        m = score_suite(s)
        suite_list.append({
            "id": s.id,
            "name": s.spec["name"],
            "kind": s.kind,
            "framework": s.spec["framework"],
            "catalogued": s.size,
            "recorded": s.result.total,
            "passed": s.result.passed,
            "failed": s.result.failed,
            "skipped": s.result.skipped,
            "pass_rate": m["pass_rate"] if m else None,
            "execution": m["execution"] if m else None,
            "coverage": m["coverage"] if m else None,
            "score": m["score"] if m else None,
            "confidence": m["label"] if m else "Not run",
            "timestamp": s.result.timestamp or None,
        })

    color = {"High": "brightgreen", "Moderate": "orange", "Low": "red"}.get(
        agg["label"], "lightgrey"
    )
    return {
        "generated": generated,
        "overall": {
            "reliability": agg["reliability"],
            "confidence": agg["label"],
            "test_score": agg["test_score"],
            "coverage_score": agg["coverage_score"],
            "catalogued": catalogued,
            "recorded": recorded,
            "passed": passed,
            "failed": failed,
            "skipped": skipped,
        },
        "coverage_signals": [{"label": lbl, "pct": pct} for lbl, pct in agg["signals"]],
        "suites": suite_list,
        "failures": [
            f"{s.spec['name']} :: {f}" for s in suites for f in s.result.failures
        ],
        "badge": {
            "schemaVersion": 1,
            "label": "reliability",
            "message": f'{agg["reliability"]:.0f}/100 {agg["label"]}',
            "color": color,
        },
    }


def load_history(path: Path) -> list[dict]:
    """Read the JSONL metrics history (empty when the file is absent)."""
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def append_history(path: Path, m: dict) -> list[dict]:
    """Append this run's headline metrics; replaces a same-timestamp entry."""
    records = load_history(path)
    rec = {
        "generated": m["generated"],
        "reliability": m["overall"]["reliability"],
        "confidence": m["overall"]["confidence"],
        "test_score": m["overall"]["test_score"],
        "coverage_score": m["overall"]["coverage_score"],
        "passed": m["overall"]["passed"],
        "failed": m["overall"]["failed"],
        "skipped": m["overall"]["skipped"],
        "catalogued": m["overall"]["catalogued"],
        # Per-suite confidence score, so the trend can plot each layer.
        "suites": {
            s["id"]: s["score"] for s in m["suites"] if s.get("score") is not None
        },
    }
    if records and records[-1].get("generated") == rec["generated"]:
        records[-1] = rec
    else:
        records.append(rec)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8"
    )
    return records


def _trend_svg(history: list[dict], series: list[dict],
               width: int = 920, height: int = 240) -> str:
    """Inline SVG multi-line chart: one line per series (overall + suites).

    ``series`` is a list of ``{"label", "color", "width", "values"}`` where
    ``values`` aligns with ``history`` and ``None`` means "no data that run".
    """
    if not history:
        return (
            '<p class="muted">No history yet. Each run appends to '
            "<code>tests/reliability-history.jsonl</code>, which this chart plots.</p>"
        )

    pad_l, pad_r, pad_t, pad_b = 46, 20, 20, 38
    w = width - pad_l - pad_r
    h = height - pad_t - pad_b
    n = len(history)

    def x_at(i: int) -> float:
        return pad_l + (w * (i / (n - 1)) if n > 1 else w / 2)

    def y_at(v: float) -> float:
        return pad_t + h * (1 - max(0.0, min(100.0, v)) / 100.0)

    parts = [f'<svg viewBox="0 0 {width} {height}" width="100%" height="{height}" '
             'role="img" preserveAspectRatio="xMidYMid meet">']
    # Threshold gridlines (High >= 90, Moderate >= 75).
    for level, color in ((90, "#198754"), (75, "#fd7e14")):
        y = y_at(level)
        parts.append(
            f'<line x1="{pad_l}" y1="{y:.1f}" x2="{pad_l + w}" y2="{y:.1f}" '
            f'stroke="{color}" stroke-width="1" stroke-dasharray="4 4" opacity="0.5"/>'
            f'<text x="{pad_l - 6}" y="{y + 4:.1f}" text-anchor="end" font-size="10" '
            f'fill="{color}">{level}</text>'
        )
    for level in (0, 100):
        y = y_at(level)
        parts.append(
            f'<line x1="{pad_l}" y1="{y:.1f}" x2="{pad_l + w}" y2="{y:.1f}" '
            'stroke="#e5e7eb" stroke-width="1"/>'
        )

    for s in series:
        color = s["color"]
        # Split the series into contiguous runs of defined values.
        segments: list[list[tuple[int, float]]] = []
        run: list[tuple[int, float]] = []
        for i, val in enumerate(s["values"]):
            if val is None:
                if run:
                    segments.append(run)
                    run = []
            else:
                run.append((i, float(val)))
        if run:
            segments.append(run)

        for seg in segments:
            if len(seg) > 1:
                pts = " ".join(f"{x_at(i):.1f},{y_at(v):.1f}" for i, v in seg)
                parts.append(
                    f'<polyline points="{pts}" fill="none" stroke="{color}" '
                    f'stroke-width="{s.get("width", 2)}" stroke-linejoin="round" '
                    'stroke-linecap="round"/>'
                )
            for i, v in seg:
                parts.append(
                    f'<circle cx="{x_at(i):.1f}" cy="{y_at(v):.1f}" r="3" '
                    f'fill="#fff" stroke="{color}" stroke-width="2"/>'
                )

    # x labels: first and last date (date part only).
    first_date = str(history[0].get("generated", "")).split(" ")[0]
    last_date = str(history[-1].get("generated", "")).split(" ")[0]
    parts.append(
        f'<text x="{pad_l}" y="{height - 12}" font-size="10" fill="#6b7280">{first_date}</text>'
    )
    if n > 1:
        parts.append(
            f'<text x="{pad_l + w}" y="{height - 12}" text-anchor="end" font-size="10" '
            f'fill="#6b7280">{last_date}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


def _overall_section(agg: dict, catalogued: int, n_suites: int) -> str:
    return (
        "<section><h2>Overall reliability</h2>"
        '<p class="sub">A transparent blend of the weighted test score (75%) and '
        "coverage signals (25%).</p>"
        '<div class="gauge">'
        f'{_gauge_svg(agg["reliability"], agg["label"])}'
        '<div class="cap">'
        f'<p style="margin:0 0 6px">{_badge(agg["label"])} '
        f'<strong style="font-size:1.05rem">Reliability index '
        f'{agg["reliability"]:.1f} / 100</strong></p>'
        '<p class="muted" style="margin:0 0 8px">'
        f'Weighted test score <strong>{agg["test_score"]:.1f}</strong> &middot; '
        f'coverage score <strong>{agg["coverage_score"]:.1f}</strong> &middot; '
        f"{catalogued:,} catalogued cases across {n_suites} suites.</p>"
        '<div class="legend">'
        '<span><span class="dot" style="background:#198754"></span>High &ge; 90</span>'
        '<span><span class="dot" style="background:#fd7e14"></span>Moderate 75&ndash;89</span>'
        '<span><span class="dot" style="background:#dc3545"></span>Low &lt; 75</span>'
        "</div></div></div></section>"
    )


def _model_section() -> str:
    return (
        "<section><h2>How the confidence level is computed</h2>"
        '<p class="sub">The model is intentionally simple and fully auditable.</p>'
        '<div class="note">'
        '<p style="margin:0 0 8px"><strong>Per-suite score (0&ndash;100):</strong></p>'
        '<p style="margin:0 0 6px"><code>pass_rate = passed / (total &minus; skipped)</code></p>'
        '<p style="margin:0 0 6px"><code>execution = (total &minus; skipped) / total</code></p>'
        '<p style="margin:0 0 6px"><code>score = 100&middot;(0.60&middot;pass_rate + '
        '0.20&middot;execution + 0.20&middot;coverage)</code></p>'
        '<p style="margin:0 0 10px"><code>score = 100&middot;(0.75&middot;pass_rate + '
        '0.25&middot;execution)</code> when no coverage</p>'
        '<p style="margin:0 0 8px"><strong>Overall reliability (0&ndash;100):</strong></p>'
        '<p style="margin:0 0 6px"><code>test_score = &Sigma;(score&middot;weight&middot;'
        '&radic;size) / &Sigma;(weight&middot;&radic;size)</code></p>'
        '<p style="margin:0"><code>reliability = 0.75&middot;test_score + '
        '0.25&middot;coverage_score</code></p>'
        '<p style="margin:10px 0 0" class="muted">Kind weights reflect how deterministic each '
        "layer is: unit 1.00 &middot; component 0.90 &middot; contract 0.80 &middot; e2e 0.70 "
        "&middot; ui 0.60. Heavier suites (&radic;size) and more deterministic layers move the "
        "index more. Skipped tests count as <em>not executed</em>, so a suite that mostly skips "
        "cannot claim high confidence. A suite with any failing case is capped at "
        "<strong>Moderate</strong>.</p></div></section>"
    )


def _trend_section(history: list[dict]) -> str:
    n = len(history)
    caption = (
        f"{n} recorded run{'s' if n != 1 else ''}"
        if n
        else "no runs recorded yet"
    )

    names = {s["id"]: s["name"] for s in SPECS}
    series = [{
        "label": "overall reliability",
        "color": TREND_COLORS["overall"],
        "width": 2.8,
        "values": [h.get("reliability") for h in history],
    }]
    for sid in [s["id"] for s in SPECS]:
        vals = [(h.get("suites") or {}).get(sid) for h in history]
        if any(v is not None for v in vals):
            series.append({
                "label": names.get(sid, sid),
                "color": TREND_COLORS.get(sid, "#9ca3af"),
                "width": 1.6,
                "values": vals,
            })

    legend = []
    for s in series:
        latest = next((v for v in reversed(s["values"]) if v is not None), None)
        txt = s["label"] + (f" — {latest:.1f}" if latest is not None else "")
        legend.append(
            f'<span><span class="dot" style="background:{s["color"]}"></span>'
            f"{html.escape(txt)}</span>"
        )
    legend_html = '<div class="legend">' + "".join(legend) + "</div>"

    return (
        "<section><h2>Reliability trend</h2>"
        '<p class="sub">Overall reliability and per-suite confidence across runs '
        f"(<code>tests/reliability-history.jsonl</code>) &middot; {caption}.</p>"
        f"{_trend_svg(history, series)}"
        f"{legend_html}</section>"
    )


def render_html(suites: list[Suite], struct: dict, generated: str,
                history: list[dict] | None = None) -> str:
    agg = overall(suites, struct)
    recorded = sum(s.result.total for s in suites if s.result.available)
    catalogued = sum(s.size for s in suites)
    passed = sum(s.result.passed for s in suites)
    failed = sum(s.result.failed for s in suites)
    skipped = sum(s.result.skipped for s in suites)
    pass_rate = _pct(passed, recorded - skipped)

    cards = [
        ("Catalogued cases", f"{catalogued:,}"),
        ("Last recorded run", f"{recorded:,}"),
        ("Passed", f"{passed:,}"),
        ("Failed", f"{failed:,}"),
        ("Skipped", f"{skipped:,}"),
        ("Overall pass rate", f"{pass_rate:.1f}%"),
    ]
    card_html = "".join(
        f'<div class="card"><div class="n">{v}</div><div class="l">{k}</div></div>'
        for k, v in cards
    )

    hero = (
        '<header class="hero">'
        "<h1>OpenRx &mdash; Test Reliability Report</h1>"
        "<p>Aggregated evidence from the automated suites: backend unit and "
        "API contract/domain.</p>"
        f'<p style="opacity:.75;font-size:.8rem;margin-top:6px">Generated {generated}</p>'
        "</header>"
    )
    results_section = (
        "<section><h2>Test results by kind</h2>"
        '<p class="sub">Confidence per suite = 60% pass-rate + 20% execution ratio + '
        "20% code coverage (75/25 pass-rate + execution when no coverage is available).</p>"
        f"{_suite_table(suites)}</section>"
    )
    coverage_section = (
        "<section><h2>Coverage</h2>"
        '<p class="sub">Structural coverage is always computed from the test catalogs; '
        "code coverage appears when a report is present.</p>"
        '<h3 style="font-size:.95rem;margin:14px 0 4px">Structural / inventory coverage</h3>'
        f"{_structural_rows(struct, agg)}"
        '<h3 style="font-size:.95rem;margin:18px 0 4px">Code coverage</h3>'
        f"{_coverage_rows(suites)}</section>"
    )
    failures_section = (
        "<section><h2>Failures that need attention</h2>"
        '<p class="sub">Every failing case from the recorded runs.</p>'
        f"{_failures_html(suites)}</section>"
    )
    footer = (
        "<footer>Regenerate with "
        "<code>python3 tests/build_reliability_report.py --collect</code>.<br>"
        "Inputs: JUnit XMLs in the suites, plus <code>tests/reliability-artifacts/</code> "
        "(Jest/Vitest JSON &amp; coverage).</footer>"
    )

    return (
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        "<title>OpenRx &mdash; Test Reliability Report</title>\n"
        f"<style>{CSS}</style>\n</head>\n<body>\n<div class=\"wrap\">\n"
        f"{hero}\n"
        f'<div class="grid cards">{card_html}</div>\n'
        f"{_overall_section(agg, catalogued, len(suites))}\n"
        f"{_trend_section(history or [])}\n"
        f"{results_section}\n"
        f"{coverage_section}\n"
        f"{_model_section()}\n"
        f"{failures_section}\n"
        f"{footer}\n"
        "</div>\n</body>\n</html>\n"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the OpenRx test reliability report.")
    parser.add_argument("--out", default=str(TESTS / "reliability-report.html"))
    parser.add_argument("--collect", action="store_true",
                        help="re-count the pytest suites via --collect-only")
    parser.add_argument("--print", dest="do_print", action="store_true",
                        help="also print a short summary to stdout")
    parser.add_argument("--json", dest="json_out", default="",
                        help="also write machine-readable metrics to this path "
                             "(trend tracking / build badge)")
    parser.add_argument("--history", default=str(HISTORY_DEFAULT),
                        help="append-only JSONL metrics history (drives the trend chart)")
    parser.add_argument("--no-history", dest="no_history", action="store_true",
                        help="read the history for the chart but do not append to it")
    args = parser.parse_args(argv)

    suites, struct = gather(do_collect=args.collect)
    generated = _dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    data = metrics(suites, struct, generated)

    history_path = Path(args.history)
    history = load_history(history_path)
    if not args.no_history:
        history = append_history(history_path, data)

    html = render_html(suites, struct, generated, history)
    Path(args.out).write_text(html, encoding="utf-8")
    print(f"[report] wrote {args.out}")

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"[report] wrote {args.json_out}")

    if args.do_print:
        agg = overall(suites, struct)
        for s in suites:
            m = score_suite(s)
            tag = f'{m["label"]} ({m["score"]:.1f})' if m else "not run"
            print(f"  - {s.spec['name']:<34} {s.size:>6} cases   {tag}")
        print(f"  reliability index = {agg['reliability']:.1f} ({agg['label']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())




