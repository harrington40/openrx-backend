"""Catalog of the SPA's navigable routes, derived from ``interface/new/src/App.tsx``.

Each entry is annotated with its feature ``domain`` (mirroring the API test
domains) and the small bits of metadata the UI tests need. Route params that
require real data (``:id``/``:pid``/``:token``) are marked ``requires_data`` and
skipped by the smoke sweep; patient-portal routes are marked ``portal``.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class UiRoute:
    path: str
    name: str
    domain: str
    staff_auth: bool = True     # requires a staff session
    requires_data: bool = False  # needs a real :id / :pid / :token
    portal: bool = False        # patient portal (separate auth model)


ROUTES: tuple[UiRoute, ...] = (
    # auth / public
    UiRoute("/login", "Login", "auth", staff_auth=False),
    UiRoute("/register", "Staff Registration", "auth", staff_auth=False),
    UiRoute("/callback", "OAuth Callback", "auth", staff_auth=False),
    # dashboard & patients
    UiRoute("/dashboard", "Dashboard", "patients"),
    UiRoute("/patients", "Patient Search", "patients"),
    UiRoute("/patients/:id", "Patient Chart", "patients", requires_data=True),
    UiRoute("/patients/:id/encounters", "Patient Encounters", "patients", requires_data=True),
    UiRoute("/patients/:id/encounters/:encounterId", "Encounter", "patients", requires_data=True),
    UiRoute("/patients/:pid/screening", "Screening", "encounters", requires_data=True),
    UiRoute("/patients/:pid/discharge-summary", "Discharge Summary", "encounters", requires_data=True),
    UiRoute("/patients/:pid/rounds", "Patient Rounds", "encounters", requires_data=True),
    # appointments
    UiRoute("/appointments", "Appointments", "appointments"),
    UiRoute("/appointments/flow", "Patient Flow Board", "appointments"),
    UiRoute("/appointments/recall", "Recall Board", "appointments"),
    UiRoute("/appointments/screening", "Drug Screening", "appointments"),
    # clinical / inpatient / emergency
    UiRoute("/inpatient", "Inpatient", "inpatient"),
    UiRoute("/emergency", "Emergency Board", "emergency"),
    UiRoute("/cds", "Clinical Decision Support", "cds"),
    # billing / reports
    UiRoute("/billing", "Billing", "billing"),
    UiRoute("/billing/medical", "Medical Billing", "billing"),
    UiRoute("/reports", "Reports", "reports"),
    UiRoute("/reports/surveillance", "Surveillance", "reports"),
    # providers & role dashboards
    UiRoute("/providers", "Providers", "providers"),
    UiRoute("/providers/:id", "Provider Profile", "providers", requires_data=True),
    UiRoute("/provider-dashboard", "Provider Dashboard", "provider"),
    UiRoute("/nurse-dashboard", "Nurse Dashboard", "nurse"),
    UiRoute("/rn-dashboard", "RN Dashboard", "nurse"),
    UiRoute("/midwife-dashboard", "Midwife Dashboard", "midwife"),
    UiRoute("/lab-tech-dashboard", "Lab Tech Dashboard", "labtech"),
    UiRoute("/lab-dashboard", "Lab Dashboard", "labs"),
    UiRoute("/registrar-dashboard", "Registrar Dashboard", "registrar"),
    # admin / labs / pharmacy
    UiRoute("/admin", "Admin", "admin"),
    UiRoute("/labs", "Labs", "labs"),
    UiRoute("/lab-results", "Lab Results", "labs"),
    UiRoute("/lab-results/:pid", "Lab Results (patient)", "labs", requires_data=True),
    UiRoute("/pharmacy", "Pharmacy", "pharmacy"),
    UiRoute("/referrals", "Referrals", "referrals"),
    # messaging / direct
    UiRoute("/messages", "Messages", "messaging"),
    UiRoute("/messages/patient-chat", "Patient Chat", "messaging"),
    UiRoute("/messages/patient-chat/:pid", "Patient Chat (patient)", "messaging", requires_data=True),
    UiRoute("/direct-messaging", "Direct Messaging", "direct"),
    # clinical extras
    UiRoute("/eye-exam", "Eye Exam", "eye"),
    UiRoute("/dicom", "DICOM / CT / X-Ray Viewer", "dicom"),
    UiRoute("/disclosures", "Disclosures", "disclosures"),
    UiRoute("/group-therapy", "Group Therapy", "therapy"),
    UiRoute("/templates", "Templates", "templates"),
    UiRoute("/camos", "CAMOS", "camos"),
    UiRoute("/inventory", "Inventory", "inventory"),
    UiRoute("/bookings", "Bookings", "booking"),
    UiRoute("/book-appointment", "Book Appointment", "booking", staff_auth=False),
    # telehealth — public WebRTC room; a denied camera is surfaced in-page
    UiRoute("/video/vc-smoke", "Video Consultation", "telehealth", staff_auth=False),
    UiRoute("/license", "License", "license", staff_auth=False),
    # fda / documents / data
    UiRoute("/fda", "FDA Lookup", "fda"),
    UiRoute("/drug-info", "Drug Info", "fda"),
    UiRoute("/documents", "Secure Documents", "documents"),
    UiRoute("/db-admin", "DB Admin", "admin"),
    # help
    UiRoute("/wiki", "Wiki", "help"),
    UiRoute("/help", "Help", "help"),
    UiRoute("/how-to", "How To", "help"),
    UiRoute("/community", "Community", "help"),
    # patient portal (separate auth model)
    UiRoute("/portal/login", "Patient Login", "portal", staff_auth=False, portal=True),
    UiRoute("/portal/register", "Patient Register", "portal", staff_auth=False, portal=True),
    UiRoute("/portal/change-password", "Patient Change Password", "portal", staff_auth=False, portal=True),
    UiRoute("/portal/dashboard", "Patient Dashboard", "portal", portal=True, requires_data=True),
    UiRoute("/portal/records", "Patient Records", "portal", portal=True, requires_data=True),
    UiRoute("/portal/message", "Patient Message", "portal", portal=True, requires_data=True),
    UiRoute("/portal/payment", "Patient Payment", "portal", portal=True, requires_data=True),
    UiRoute("/vendor/portal/:token", "Vendor Portal", "vendor", staff_auth=False, requires_data=True),
)


def navigable_routes(domains: tuple[str, ...] = ()) -> list[UiRoute]:
    """Routes eligible for the smoke sweep (excludes data- and portal-specific)."""
    wanted = (lambda d: True) if not domains else (lambda d: d in domains)
    return [
        r for r in ROUTES if not r.requires_data and not r.portal and wanted(r.domain)
    ]


def domains() -> list[str]:
    return sorted({r.domain for r in ROUTES})
