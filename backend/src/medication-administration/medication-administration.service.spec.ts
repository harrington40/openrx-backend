import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MedicationAdministrationService } from './medication-administration.service';

/**
 * The interesting behaviour lives in the transitions: admitting a patient must
 * seed the MAR and notify the nurse, and a bedside administration must never
 * slip past a hard stop without a recorded override.
 */
describe('MedicationAdministrationService', () => {
    function build(responder: (sql: string) => unknown) {
        const queries: string[] = [];
        const dataSource = {
            query<T = unknown>(sql: string): Promise<T> {
                queries.push(sql);
                return Promise.resolve(responder(sql) as T);
            },
        };
        return { dataSource, queries };
    }

    async function service(dataSource: unknown) {
        const module = await Test.createTestingModule({
            providers: [
                MedicationAdministrationService,
                { provide: getDataSourceToken(), useValue: dataSource },
            ],
        }).compile();
        return module.get(MedicationAdministrationService);
    }

    const PATIENT = [
        { id: 1, pid: 17, fname: 'Test', lname: 'Patient', status: 'active' },
    ];

    describe('hospitalize', () => {
        it('seeds the MAR from active prescriptions and notifies the nurse', async () => {
            let orderId = 100;
            const { dataSource, queries } = build((sql) => {
                if (sql.includes('FROM patient_data')) return PATIENT;
                if (sql.includes('AS load')) return [{ id: 12, load: 0 }];
                if (sql.includes('AS `load`')) return [{ id: 12, load: 0 }];
                if (sql.includes('FROM patient_care_assignment')) return [];
                if (sql.includes('INSERT INTO patient_care_assignment'))
                    return { affectedRows: 1 };
                if (sql.includes('FROM prescriptions'))
                    return [
                        {
                            id: 5,
                            drug: 'Insulin glargine',
                            dosage: '10 units',
                            route: 'BID',
                            dose_interval: null,
                            prn: null,
                        },
                        {
                            id: 6,
                            drug: 'Paracetamol',
                            dosage: '500 mg',
                            route: 'q6h',
                            dose_interval: null,
                            prn: null,
                        },
                    ];
                if (sql.includes('INSERT INTO medication_administration_orders'))
                    return { insertId: orderId++ };
                if (sql.includes('INSERT INTO medication_administration_alerts'))
                    return { insertId: 1 };
                return { affectedRows: 1, insertId: 0 };
            });

            const result = await (
                await service(dataSource)
            ).hospitalize(17, { room: '101A' }, { id: 99 });

            expect(result).toMatchObject({
                pid: 17,
                room: '101A',
                nurseId: 12,
                orders: 2,
                highAlert: 1,
            });
            // One admission notice + one critical high-alert notice.
            expect(
                queries.filter((q) =>
                    q.includes('INSERT INTO medication_administration_alerts'),
                ),
            ).toHaveLength(2);
            expect(
                queries.some((q) =>
                    q.includes('INSERT INTO patient_care_assignment'),
                ),
            ).toBe(true);
        });

        it('refuses to hospitalize without a bed', async () => {
            const { dataSource } = build((sql) => {
                if (sql.includes('FROM patient_data')) return PATIENT;
                if (sql.includes('FROM patient_care_assignment')) return [];
                return { affectedRows: 1 };
            });

            await expect(
                (await service(dataSource)).hospitalize(17, { room: '' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects an unknown patient', async () => {
            const { dataSource } = build(() => []);
            await expect(
                (await service(dataSource)).hospitalize(999, { room: '1' }),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('recordAdministration', () => {
        const ORDER = [
            {
                id: 5,
                pid: 17,
                prescription_id: 5,
                drug: 'Penicillin VK',
                dose: '500',
                dose_unit: 'mg',
                route: 'PO',
                frequency: 'q6h',
                interval_hours: 6,
                next_due_at: '2026-01-01T08:00:00Z',
                is_prn: 0,
                high_alert: 0,
                status: 'active',
            },
        ];

        function responder(sql: string) {
            if (sql.includes('FROM patient_data')) return PATIENT;
            if (sql.includes('FROM prescriptions')) return [];
            if (sql.includes('FROM medication_administration_orders')) {
                // The active-orders lookup filters on status; the order fetch does not.
                if (sql.includes("status = 'active'")) return [];
                return ORDER;
            }
            if (sql.includes('FROM lists'))
                return [{ allergen: 'Penicillin', reaction: 'Rash' }];
            if (sql.includes('INSERT INTO medication_administration_records'))
                return { insertId: 77 };
            if (sql.includes('INSERT INTO medication_administration_alerts'))
                return { insertId: 1 };
            return { affectedRows: 1, insertId: 0 };
        }

        it('blocks a hard stop until an override reason is supplied', async () => {
            const { dataSource } = build(responder);

            await expect(
                (await service(dataSource)).recordAdministration(
                    5,
                    { patientId: 17 },
                    { id: 12 },
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('records the administration and an override notice when overridden', async () => {
            const { dataSource, queries } = build(responder);

            const result = await (
                await service(dataSource)
            ).recordAdministration(
                5,
                { patientId: 17, overrideReason: 'Allergy history reviewed — tolerated previously.' },
                { id: 12 },
            );

            expect(result.recordId).toBe(77);
            expect(result.verdict.decision).toBe('block');
            expect(result.verdict.requiresOverride).toBe(true);
            expect(
                queries.some(
                    (q) =>
                        q.includes('INSERT INTO medication_administration_records'),
                ),
            ).toBe(true);
            expect(
                queries.filter((q) =>
                    q.includes('INSERT INTO medication_administration_alerts'),
                ),
            ).toHaveLength(1); // the override notice
        });

        it('advances the next due time for a clean, scheduled order', async () => {
            const { dataSource, queries } = build((sql) => {
                if (sql.includes('FROM patient_data')) return PATIENT;
                if (sql.includes('FROM prescriptions')) return [];
                if (sql.includes('FROM medication_administration_orders')) {
                    if (sql.includes("status = 'active'")) return [];
                    return [{ ...ORDER[0], drug: 'Paracetamol' }];
                }
                if (sql.includes('FROM lists')) return [];
                if (
                    sql.includes('INSERT INTO medication_administration_records')
                )
                    return { insertId: 88 };
                return { affectedRows: 1, insertId: 0 };
            });

            const result = await (
                await service(dataSource)
            ).recordAdministration(
                5,
                { patientId: 17, administeredAt: '2026-01-01T08:05:00Z' },
                { id: 12 },
            );

            expect(result.verdict.decision).toBe('proceed');
            expect(result.nextDueAt).toBeInstanceOf(Date);
            expect(
                queries.some((q) =>
                    q.includes('SET next_due_at = ?'),
                ),
            ).toBe(true);
            // No override notice for a clean administration.
            expect(
                queries.some((q) =>
                    q.includes('INSERT INTO medication_administration_alerts'),
                ),
            ).toBe(false);
        });
    });

    describe('discharge', () => {
        it('stops the running orders and notifies the nurse', async () => {
            const { dataSource, queries } = build((sql) => {
                if (sql.includes('FROM patient_care_assignment'))
                    return [{ pid: 17, assigned_nurse_id: 12 }];
                if (sql.includes('UPDATE medication_administration_orders'))
                    return { affectedRows: 3 };
                return { affectedRows: 1, insertId: 1 };
            });

            const result = await (
                await service(dataSource)
            ).discharge(17, { id: 99 });

            expect(result).toMatchObject({ pid: 17, room: null, stoppedOrders: 3 });
            expect(
                queries.some((q) =>
                    q.includes('INSERT INTO medication_administration_alerts'),
                ),
            ).toBe(true);
        });
    });
});
