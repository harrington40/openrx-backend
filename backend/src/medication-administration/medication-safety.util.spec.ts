import {
    DEFAULT_WINDOW_MINUTES,
    allergyMatches,
    evaluateAdministration,
    findLasaConflicts,
    isHighAlertDrug,
    matchingAllergies,
    nextDueAt,
    normaliseDrug,
    parseFrequencyToHours,
    scheduleStatus,
} from './medication-safety.util';

/**
 * Tests for the bedside medication safety algorithm.
 *
 * The safety floor matters most: a documented allergy or a mismatched chart is
 * a hard stop that must never be silently waved through, while the softer risks
 * (high-alert, LASA, dose/timing) warn without blocking the nurse.
 */
const cleanOrder = {
    patientId: 17,
    orderPatientId: 17,
    drug: 'Paracetamol',
    dose: '500 mg',
    route: 'PO',
    scheduledAt: new Date('2026-01-01T08:00:00Z'),
    administeredAt: new Date('2026-01-01T08:10:00Z'),
    allergies: [] as { allergen: string }[],
    activeDrugs: [] as string[],
};

describe('normalisation and classification', () => {
    it('normalises names for comparison', () => {
        expect(normaliseDrug('  Heparin Sodium ')).toBe('heparin sodium');
        expect(normaliseDrug('NuLytely 4%')).toBe('nulytely 4');
    });

    it('detects ISMP high-alert medicines', () => {
        expect(isHighAlertDrug('Insulin glargine')).toBe(true);
        expect(isHighAlertDrug('Heparin Sodium 5000 units/mL')).toBe(true);
        expect(isHighAlertDrug('Morphine sulfate')).toBe(true);
        expect(isHighAlertDrug('Paracetamol')).toBe(false);
    });

    it('finds look-alike/sound-alike partners already active', () => {
        expect(findLasaConflicts('hydralazine', ['hydroxyzine'])).toEqual([
            'hydroxyzine',
        ]);
        expect(findLasaConflicts('hydralazine', ['amlodipine'])).toEqual([]);
    });
});

describe('allergy matching', () => {
    it('matches a listed allergen named inside the drug', () => {
        expect(allergyMatches('Amoxicillin', 'Penicillin')).toBe(false);
        expect(allergyMatches('Penicillin VK', 'Penicillin')).toBe(true);
        expect(allergyMatches('Heparin', 'Heparin Sodium')).toBe(true);
    });

    it('does not fire on short fragments', () => {
        expect(allergyMatches('Paracetamol', 'ate')).toBe(false);
    });

    it('returns only the conflicting allergies', () => {
        expect(
            matchingAllergies('Penicillin VK', [
                { allergen: 'Penicillin', reaction: 'Rash' },
                { allergen: 'Peanuts' },
            ]),
        ).toEqual([{ allergen: 'Penicillin', reaction: 'Rash' }]);
    });
});

describe('frequency parsing', () => {
    it('maps common frequencies to an interval in hours', () => {
        expect(parseFrequencyToHours('q12h')).toBe(12);
        expect(parseFrequencyToHours('BID')).toBe(12);
        expect(parseFrequencyToHours('TID')).toBe(8);
        expect(parseFrequencyToHours('QID')).toBe(6);
        expect(parseFrequencyToHours('once daily')).toBe(24);
        expect(parseFrequencyToHours('weekly')).toBe(168);
    });

    it('returns null for PRN and unrecognised text', () => {
        expect(parseFrequencyToHours('PRN')).toBeNull();
        expect(parseFrequencyToHours('as needed')).toBeNull();
        expect(parseFrequencyToHours('')).toBeNull();
    });
});

describe('schedule status', () => {
    const now = new Date('2026-01-01T08:00:00Z');

    it('classifies a dose inside the window as due', () => {
        const s = scheduleStatus('2026-01-01T08:30:00Z', now);
        expect(s.state).toBe('due');
        expect(s.minutesUntil).toBe(30);
    });

    it('classifies a dose past the window as overdue', () => {
        const s = scheduleStatus('2026-01-01T06:00:00Z', now);
        expect(s.state).toBe('overdue');
        expect(s.minutesUntil).toBe(-120);
    });

    it('classifies a dose well ahead as upcoming and blanks to unscheduled', () => {
        expect(scheduleStatus('2026-01-01T12:00:00Z', now).state).toBe(
            'upcoming',
        );
        expect(scheduleStatus(null, now).state).toBe('unscheduled');
    });

    it('computes the next due time from an interval', () => {
        expect(
            nextDueAt('2026-01-01T08:00:00Z', 12)?.toISOString(),
        ).toBe('2026-01-01T20:00:00.000Z');
        expect(nextDueAt('2026-01-01T08:00:00Z', null)).toBeNull();
    });
});

describe('evaluateAdministration', () => {
    it('lets a clean, on-time order proceed', () => {
        const v = evaluateAdministration(cleanOrder);
        expect(v.decision).toBe('proceed');
        expect(v.issues).toEqual([]);
        expect(v.requiresOverride).toBe(false);
        expect(v.requiresWitness).toBe(false);
        expect(v.checks.rightTime).toBe(true);
        expect(DEFAULT_WINDOW_MINUTES).toBe(60);
    });

    it('hard-stops on a documented allergy', () => {
        const v = evaluateAdministration({
            ...cleanOrder,
            drug: 'Penicillin VK',
            allergies: [{ allergen: 'Penicillin', reaction: 'Anaphylaxis' }],
        });
        expect(v.decision).toBe('block');
        expect(v.requiresOverride).toBe(true);
        expect(v.issues).toContainEqual(
            expect.objectContaining({
                code: 'allergy_conflict',
                hardStop: true,
                severity: 'critical',
            }),
        );
    });

    it('hard-stops when the order belongs to a different patient', () => {
        const v = evaluateAdministration({
            ...cleanOrder,
            patientId: 42,
            orderPatientId: 17,
        });
        expect(v.decision).toBe('block');
        expect(v.checks.rightPatient).toBe(false);
        expect(v.requiresOverride).toBe(true);
    });

    it('warns and requires a witness for a high-alert medicine', () => {
        const v = evaluateAdministration({
            ...cleanOrder,
            drug: 'Insulin glargine',
        });
        expect(v.decision).toBe('warn');
        expect(v.requiresWitness).toBe(true);
        expect(v.requiresOverride).toBe(false);
        expect(v.issues).toContainEqual(
            expect.objectContaining({ code: 'high_alert' }),
        );
    });

    it('warns but does not block on a missing dose or route', () => {
        const v = evaluateAdministration({
            ...cleanOrder,
            dose: null,
            route: null,
        });
        expect(v.decision).toBe('warn');
        expect(v.checks.rightDose).toBe(false);
        expect(v.checks.rightRoute).toBe(false);
        expect(v.requiresOverride).toBe(false);
    });

    it('warns on duplicate therapy and a LASA partner', () => {
        const dup = evaluateAdministration({
            ...cleanOrder,
            activeDrugs: ['Paracetamol', 'Ibuprofen'],
        });
        expect(dup.issues).toContainEqual(
            expect.objectContaining({ code: 'duplicate_therapy' }),
        );

        const lasa = evaluateAdministration({
            ...cleanOrder,
            drug: 'Hydralazine',
            activeDrugs: ['Hydroxyzine'],
        });
        expect(lasa.issues).toContainEqual(
            expect.objectContaining({ code: 'lasa_conflict' }),
        );
        expect(lasa.requiresWitness).toBe(true);
    });

    it('flags a dose given outside the window as early or late', () => {
        const late = evaluateAdministration({
            ...cleanOrder,
            administeredAt: new Date('2026-01-01T10:30:00Z'),
        });
        expect(late.checks.rightTime).toBe(false);
        expect(late.issues).toContainEqual(
            expect.objectContaining({ code: 'dose_late' }),
        );

        const early = evaluateAdministration({
            ...cleanOrder,
            administeredAt: new Date('2026-01-01T05:00:00Z'),
        });
        expect(early.issues).toContainEqual(
            expect.objectContaining({ code: 'dose_early' }),
        );
    });

    it('reports a blocked decision even when softer warnings are also present', () => {
        const v = evaluateAdministration({
            ...cleanOrder,
            drug: 'Heparin', // high-alert warning
            dose: null, // dose warning
            allergies: [{ allergen: 'Heparin' }], // hard stop
        });
        expect(v.decision).toBe('block');
        expect(v.requiresOverride).toBe(true);
        expect(v.requiresWitness).toBe(true);
        expect(v.issues.length).toBeGreaterThanOrEqual(3);
    });
});

