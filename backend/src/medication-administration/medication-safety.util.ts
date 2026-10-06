/**
 * Smart medication-administration safety — pure, database-free.
 *
 * Bedside administration is checked against the five rights (right patient,
 * drug, dose, route and time) before anything is recorded, following the WHO
 * "Medication Without Harm" guidance and the ISMP list of high-alert medicines:
 *
 *  - an allergy conflict is a *hard stop* — it can only proceed with a
 *    documented clinical reason, which the service stores on the record;
 *  - a high-alert medicine (ISMP) always requires an independent witness;
 *  - look-alike/sound-alike (LASA) pairs raise a warning so the two are never
 *    confused at the bedside;
 *  - a dose given outside its scheduled window is reported as early or late,
 *    and a duplicate of a therapy already running is flagged;
 *  - the dose and route must actually be present.
 *
 * Missing data is never treated as safe: an order without a quantified dose or
 * route still warns rather than passing silently. The util *advises*; the nurse
 * decides — every hard stop can be overridden, but the override is recorded,
 * the same "advise, then audit" shape the triage algorithm uses.
 */

export type AdministrationDecision = 'proceed' | 'warn' | 'block';

export type SafetySeverity = 'info' | 'warning' | 'critical';

export interface AdministrationCheck {
    /** The order belongs to the patient being scanned. */
    rightPatient: boolean;
    rightDrug: boolean;
    rightDose: boolean;
    rightRoute: boolean;
    rightTime: boolean;
}

export interface SafetyIssue {
    /** Stable machine code, e.g. `allergy_conflict`. */
    code: string;
    severity: SafetySeverity;
    message: string;
    /** A hard stop cannot proceed without a recorded override reason. */
    hardStop: boolean;
}

export interface AdministrationVerdict {
    decision: AdministrationDecision;
    checks: AdministrationCheck;
    issues: SafetyIssue[];
    /** A second nurse must co-sign the administration. */
    requiresWitness: boolean;
    /** True when a hard stop is present and an override is needed. */
    requiresOverride: boolean;
    /** 0–100 risk score; higher is riskier. Advisory only. */
    score: number;
}

/** A recorded allergy, as read from the chart. */
export interface AllergyInput {
    allergen: string;
    reaction?: string | null;
}

export interface AdministrationInput {
    /** Patient the nurse is standing at. */
    patientId: number;
    /** Patient the order was written for. */
    orderPatientId: number;
    drug: string;
    dose?: string | number | null;
    /** Unit the order expects, e.g. `mg`. */
    unit?: string | null;
    route?: string | null;
    scheduledAt?: Date | string | null;
    administeredAt?: Date | string | null;
    allergies?: AllergyInput[];
    /** Other medicines currently active for the same patient. */
    activeDrugs?: string[];
    /** Override the ISMP detection when the order is already flagged. */
    isHighAlert?: boolean;
    /** Allowed early/late window before a dose is "off schedule". */
    windowMinutes?: number;
}

/** Default ± window (minutes) around a scheduled dose. */
export const DEFAULT_WINDOW_MINUTES = 60;


/**
 * ISMP high-alert medicines. Match is by normalised token so brand suffixes and
 * dosage forms ("Heparin Sodium 5000 units/mL") still resolve.
 */
export const HIGH_ALERT_DRUGS: string[] = [
    'insulin',
    'heparin',
    'warfarin',
    'enoxaparin',
    'apixaban',
    'rivaroxaban',
    'morphine',
    'hydromorphone',
    'fentanyl',
    'oxycodone',
    'methadone',
    'hydrocodone',
    'potassium chloride',
    'hypertonic saline',
    'methotrexate',
    'succinylcholine',
    'rocuronium',
    'vecuronium',
    'digoxin',
    'magnesium sulfate',
    'vasopressin',
    'norepinephrine',
    'epinephrine',
    'dopamine',
    'dobutamine',
    'amiodarone',
    'propofol',
    'midazolam',
    'phenytoin',
    'theophylline',
];

/** Look-alike / sound-alike pairs commonly confused at the bedside. */
export const LASA_PAIRS: [string, string][] = [
    ['hydralazine', 'hydroxyzine'],
    ['glipizide', 'glyburide'],
    ['ceftriaxone', 'cefazolin'],
    ['clonidine', 'clonazepam'],
    ['metformin', 'metronidazole'],
    ['prednisone', 'prednisolone'],
    ['oxycodone', 'oxycontin'],
    ['dopamine', 'dobutamine'],
    ['lisinopril', 'fosinopril'],
    ['zantac', 'zoloft'],
    ['celebrex', 'celexa'],
    ['lamictal', 'lamisil'],
    ['tramadol', 'trazodone'],
];

/** Normalise a drug/allergen name for comparison. */
export function normaliseDrug(name: unknown): string {
    return String(name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Compact form (no spaces), useful for substring containment. */
function compact(name: unknown): string {
    return normaliseDrug(name).replace(/\s+/g, '');
}

/** True when the drug belongs to the ISMP high-alert list. */
export function isHighAlertDrug(drug: string): boolean {
    const hay = ` ${normaliseDrug(drug)} `;
    const compactHay = compact(drug);
    return HIGH_ALERT_DRUGS.some((entry) => {
        const needle = normaliseDrug(entry);
        if (!needle) return false;
        return (
            hay.includes(` ${needle} `) ||
            compactHay.includes(needle.replace(/\s+/g, ''))
        );
    });
}

/** Any LASA partners of `drug` that are also in `activeDrugs`. */
export function findLasaConflicts(
    drug: string,
    activeDrugs: string[] = [],
): string[] {
    const target = normaliseDrug(drug);
    if (!target) return [];
    const others = activeDrugs.map((d) => normaliseDrug(d)).filter(Boolean);
    const hits: string[] = [];
    for (const [a, b] of LASA_PAIRS) {
        const pair = [normaliseDrug(a), normaliseDrug(b)];
        if (!pair.includes(target)) continue;
        const partner = pair.find((p) => p !== target) || '';
        if (partner && others.includes(partner)) hits.push(partner);
    }
    return hits;
}

/**
 * Does an allergy match the drug? A match when either name contains the other
 * (both at least four characters) or they share a significant token. Four is the
 * floor so short fragments such as "ate" cannot trigger a false hard stop.
 */
export function allergyMatches(drug: string, allergen: string): boolean {
    const d = normaliseDrug(drug);
    const a = normaliseDrug(allergen);
    if (!d || !a) return false;

    const dc = compact(d);
    const ac = compact(a);
    if (ac.length >= 4 && dc.includes(ac)) return true;
    if (dc.length >= 4 && ac.includes(dc)) return true;

    const tokens = a.split(' ').filter((t) => t.length >= 4);
    return tokens.some((t) => dc.includes(t));
}

/** All allergens that conflict with the drug. */
export function matchingAllergies(
    drug: string,
    allergies: AllergyInput[] = [],
): AllergyInput[] {
    return allergies.filter((al) => allergyMatches(drug, al?.allergen || ''));
}

/** Does the dose string carry a quantity (a digit)? */
export function doseHasQuantity(dose: unknown): boolean {
    return /\d/.test(String(dose ?? ''));
}

/**
 * Map a written frequency onto an interval in hours. Returns null when the
 * order is unscheduled or on-demand ("PRN", "as needed") or unrecognised.
 */
export function parseFrequencyToHours(frequency: unknown): number | null {
    const f = normaliseDrug(frequency);
    if (!f) return null;
    if (/(prn|as needed|when required|sos)/.test(f)) return null;

    const every = f.match(/q\s*(\d+)\s*(h|hr|hrs|hour|hours)?/);
    if (every) {
        const n = Number(every[1]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    const perDay = f.match(
        /(\d+)\s*(?:x|times)?\s*(?:a\s*)?(?:per|a|\/)?\s*day/,
    );
    if (perDay) {
        const n = Number(perDay[1]);
        if (Number.isFinite(n) && n > 0) return 24 / n;
    }
    if (
        /(once daily|every day|daily|qd|q24h|once a day|at bedtime)/.test(f)
    )
        return 24;
    if (/(twice daily|twice a day|bid|b i d)/.test(f)) return 12;
    if (/(three times|tid|t i d)/.test(f)) return 8;
    if (/(four times|qid|q i d)/.test(f)) return 6;
    if (/(weekly|once a week)/.test(f)) return 168;
    return null;
}

export interface ScheduleStatus {
    state: 'upcoming' | 'due' | 'overdue' | 'unscheduled';
    /** Minutes until the dose is due (negative when past due). */
    minutesUntil: number | null;
}

/**
 * Where a scheduled dose sits relative to now. "due" means within the window
 * (before or after); "overdue" means the window has closed.
 */
export function scheduleStatus(
    scheduledAt: Date | string | null | undefined,
    now: Date = new Date(),
    windowMinutes: number = DEFAULT_WINDOW_MINUTES,
): ScheduleStatus {
    if (!scheduledAt) return { state: 'unscheduled', minutesUntil: null };
    const target = new Date(scheduledAt).getTime();
    if (!Number.isFinite(target))
        return { state: 'unscheduled', minutesUntil: null };

    const window = Math.max(1, Number(windowMinutes) || DEFAULT_WINDOW_MINUTES);
    const minutesUntil = Math.round((target - now.getTime()) / 60000);
    if (minutesUntil > window) return { state: 'upcoming', minutesUntil };
    if (minutesUntil >= -window) return { state: 'due', minutesUntil };
    return { state: 'overdue', minutesUntil };
}

/** Compute the next due time from a base time and an interval in hours. */
export function nextDueAt(
    from: Date | string,
    intervalHours: number | null | undefined,
): Date | null {
    const base = from instanceof Date ? from : new Date(from);
    if (!Number.isFinite(base.getTime())) return null;
    const hours = Number(intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) return null;
    return new Date(base.getTime() + hours * 3600 * 1000);
}


/**
 * The smart check. Returns a verdict the controller turns into either a
 * recorded administration or a refusal that needs an override reason.
 */
export function evaluateAdministration(
    input: AdministrationInput,
): AdministrationVerdict {
    const window = Math.max(
        1,
        Number(input.windowMinutes) || DEFAULT_WINDOW_MINUTES,
    );
    const issues: SafetyIssue[] = [];
    let score = 0;

    const drug = normaliseDrug(input.drug);

    // Right patient — a mismatched chart is the most dangerous error and blocks.
    const rightPatient =
        Number(input.patientId) > 0 &&
        Number(input.patientId) === Number(input.orderPatientId);
    if (!rightPatient) {
        score += 100;
        issues.push({
            code: 'wrong_patient',
            severity: 'critical',
            message: `Order belongs to patient #${input.orderPatientId}, not the scanned patient #${input.patientId}.`,
            hardStop: true,
        });
    }

    // Right drug.
    const rightDrug = drug.length > 0;
    if (!rightDrug) {
        score += 40;
        issues.push({
            code: 'missing_drug',
            severity: 'critical',
            message: 'No medicine is named on this order.',
            hardStop: true,
        });
    }

    // Allergy cross-check — a documented allergy is a hard stop.
    const allergyHits = matchingAllergies(input.drug, input.allergies);
    for (const al of allergyHits) {
        score += 60;
        issues.push({
            code: 'allergy_conflict',
            severity: 'critical',
            message: `Allergy alert: patient is allergic to "${al.allergen}"${
                al.reaction ? ` (${al.reaction})` : ''
            } — "${input.drug}" must not be given without review.`,
            hardStop: true,
        });
    }

    // Right dose.
    const rightDose = doseHasQuantity(input.dose);
    if (!rightDose) {
        score += 10;
        issues.push({
            code: 'dose_not_quantified',
            severity: 'warning',
            message:
                'The dose is missing or has no quantity — confirm the number and unit before giving.',
            hardStop: false,
        });
    }

    // Right route.
    const rightRoute = !!String(input.route ?? '').trim();
    if (!rightRoute) {
        score += 10;
        issues.push({
            code: 'route_missing',
            severity: 'warning',
            message: 'No route is recorded for this order.',
            hardStop: false,
        });
    }

    // High-alert medicine — needs an independent witness.
    const highAlert = input.isHighAlert ?? isHighAlertDrug(input.drug);
    if (highAlert) {
        score += 20;
        issues.push({
            code: 'high_alert',
            severity: 'warning',
            message: `"${input.drug}" is a high-alert medicine — an independent double-check is required.`,
            hardStop: false,
        });
    }

    // LASA partner already active — warn of confusion risk.
    const lasa = findLasaConflicts(input.drug, input.activeDrugs);
    for (const partner of lasa) {
        score += 15;
        issues.push({
            code: 'lasa_conflict',
            severity: 'warning',
            message: `Look-alike/sound-alike risk: "${partner}" is also active for this patient.`,
            hardStop: false,
        });
    }

    // Duplicate therapy — the same drug already running.
    const others = (input.activeDrugs || []).map((d) => normaliseDrug(d));
    if (drug && others.includes(drug)) {
        score += 20;
        issues.push({
            code: 'duplicate_therapy',
            severity: 'warning',
            message: `"${input.drug}" already appears as an active medicine — confirm this is not a duplicate.`,
            hardStop: false,
        });
    }

    // Right time.
    let rightTime = true;
    const scheduled = input.scheduledAt ? new Date(input.scheduledAt) : null;
    const administered = input.administeredAt
        ? new Date(input.administeredAt)
        : new Date();
    if (scheduled && Number.isFinite(scheduled.getTime())) {
        const delta = Math.round(
            (administered.getTime() - scheduled.getTime()) / 60000,
        );
        if (Math.abs(delta) > window) {
            rightTime = false;
            score += 10;
            const late = delta > 0;
            issues.push({
                code: late ? 'dose_late' : 'dose_early',
                severity: 'warning',
                message: `Dose is ${Math.abs(delta)} min ${
                    late ? 'after' : 'before'
                } its scheduled time (window ±${window} min).`,
                hardStop: false,
            });
        }
    }

    const requiresOverride = issues.some((i) => i.hardStop);
    const decision: AdministrationDecision = requiresOverride
        ? 'block'
        : issues.length
          ? 'warn'
          : 'proceed';

    return {
        decision,
        checks: { rightPatient, rightDrug, rightDose, rightRoute, rightTime },
        issues,
        requiresWitness: highAlert || lasa.length > 0,
        requiresOverride,
        score: Math.min(100, score),
    };
}

