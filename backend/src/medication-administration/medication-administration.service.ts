import {
    Injectable,
    Logger,
    NotFoundException,
    BadRequestException,
    OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    evaluateAdministration,
    isHighAlertDrug,
    parseFrequencyToHours,
    nextDueAt,
    scheduleStatus,
} from './medication-safety.util';
import type {
    AdministrationVerdict,
    AllergyInput,
} from './medication-safety.util';

/** `medication_administration_orders` row, joined to the patient. */
export interface MarOrderRow {
    id: number;
    pid: number;
    prescription_id: number | null;
    drug: string;
    dose: string | null;
    dose_unit: string | null;
    route: string | null;
    frequency: string | null;
    interval_hours: number | string | null;
    next_due_at: string | null;
    is_prn: number;
    high_alert: number;
    status: string;
    ordered_by: number | null;
    fname?: string;
    lname?: string;
    room?: string | null;
}

/** `prescriptions` row used to seed the MAR on admission. */
interface PrescriptionSeedRow {
    id: number;
    drug: string | null;
    dosage: string | null;
    route: string | null;
    dose_interval: number | string | null;
    prn: string | null;
}

/** `patient_data` row (minimal). */
interface PatientRow {
    id: number;
    pid: number;
    fname: string;
    lname: string;
    status: string | null;
}

/** `patient_care_assignment` row (minimal). */
interface CareAssignmentRow {
    pid: number;
    room: string | null;
    assigned_nurse_id: number | null;
    charge_nurse_id: number | null;
}

/** Active nurse row with the current assignment load. */
interface NurseLoadRow {
    id: number;
    fname: string;
    lname: string;
    load: number | string;
}

/** `medication_administration_alerts` row. */
export interface AlertRow {
    id: number;
    pid: number;
    order_id: number | null;
    assigned_to: number | null;
    severity: string;
    kind: string;
    title: string;
    detail: string | null;
    status: string;
    created_at: string;
}

/** Affected-rows result of an INSERT / UPDATE / DELETE. */
interface AffectedRowsResult {
    affectedRows: number;
    insertId: number;
}

/** Body accepted by `hospitalize()`. */
export interface HospitalizeDto {
    room?: string | null;
    nurseId?: number | string | null;
}

/** Body accepted by `recordAdministration()`. */
export interface AdministrationDto {
    patientId: number | string;
    dose?: string | number | null;
    route?: string | null;
    scheduledAt?: string | null;
    administeredAt?: string | null;
    overrideReason?: string | null;
    witnessBy?: number | string | null;
    site?: string | null;
    notes?: string | null;
}

/** The actor performing a change, supplied by the controller. */
export interface MarActor {
    id?: number;
    username?: string;
    displayName?: string;
}

@Injectable()
export class MedicationAdministrationService implements OnModuleInit {
    private readonly logger = new Logger(MedicationAdministrationService.name);

    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async onModuleInit(): Promise<void> {
        await this.ensureSchema();
    }

    /** Create the MAR tables if they do not yet exist. */
    async ensureSchema(): Promise<void> {
        await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS medication_administration_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pid INT NOT NULL,
        prescription_id INT NULL,
        drug VARCHAR(255) NOT NULL,
        dose VARCHAR(120) NULL,
        dose_unit VARCHAR(40) NULL,
        route VARCHAR(80) NULL,
        frequency VARCHAR(80) NULL,
        interval_hours DECIMAL(6,2) NULL,
        next_due_at DATETIME NULL,
        is_prn TINYINT(1) NOT NULL DEFAULT 0,
        high_alert TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        ordered_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NULL,
        UNIQUE KEY uniq_mar_order_rx (pid, prescription_id),
        INDEX idx_mar_order_pid (pid),
        INDEX idx_mar_order_due (status, next_due_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

        await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS medication_administration_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_id INT NOT NULL,
        pid INT NOT NULL,
        status VARCHAR(20) NOT NULL,
        scheduled_at DATETIME NULL,
        administered_at DATETIME NULL,
        dose_given VARCHAR(120) NULL,
        administered_by INT NULL,
        witness_by INT NULL,
        site VARCHAR(60) NULL,
        notes TEXT NULL,
        override_reason VARCHAR(255) NULL,
        safety_json MEDIUMTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mar_record_pid (pid),
        INDEX idx_mar_record_order (order_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

        await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS medication_administration_alerts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        pid INT NOT NULL,
        order_id INT NULL,
        assigned_to INT NULL,
        severity VARCHAR(16) NOT NULL DEFAULT 'info',
        kind VARCHAR(40) NOT NULL,
        title VARCHAR(160) NOT NULL,
        detail TEXT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'New',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        read_at DATETIME NULL,
        INDEX idx_mar_alert_status (status),
        INDEX idx_mar_alert_assigned (assigned_to),
        INDEX idx_mar_alert_pid (pid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

        this.logger.log('Medication-administration schema ready');
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** The patient's room assignment, or null when not admitted. */
    private async getAssignment(
        pid: number,
    ): Promise<CareAssignmentRow | null> {
        const rows = await this.dataSource.query<CareAssignmentRow[]>(
            `SELECT pid, room, assigned_nurse_id, charge_nurse_id
       FROM patient_care_assignment WHERE pid = ?`,
            [pid],
        );
        return rows[0] || null;
    }

    /** Least-loaded active nurse, used when none is nominated on admission. */
    private async pickNurse(): Promise<number | null> {
        const rows = await this.dataSource.query<NurseLoadRow[]>(
            `SELECT u.id, u.fname, u.lname,
              (SELECT COUNT(*) FROM patient_care_assignment ca
                WHERE ca.assigned_nurse_id = u.id) AS \`load\`
       FROM users u
       WHERE u.active = 1 AND u.authorized = 1
         AND u.main_menu_role IN ('nurse', 'registered_nurse')
       ORDER BY \`load\` ASC, u.id ASC
       LIMIT 1`,
        );
        return rows[0] ? Number(rows[0].id) : null;
    }

    /** Split "500 mg" into a dose and a unit where possible. */
    private splitDose(dosage: string | null | undefined): {
        dose: string | null;
        unit: string | null;
    } {
        const text = String(dosage ?? '').trim();
        if (!text) return { dose: null, unit: null };
        const match = text.match(/^([\d./]+)\s*([a-zA-Z%µ]+)?/);
        if (!match) return { dose: text, unit: null };
        return {
            dose: match[1] || text,
            unit: match[2] ? match[2].slice(0, 40) : null,
        };
    }

    /** Insert a MAR notification/alert row. */
    private async raiseAlert(input: {
        pid: number;
        orderId?: number | null;
        assignedTo?: number | null;
        severity: 'info' | 'warning' | 'critical';
        kind: string;
        title: string;
        detail?: string | null;
    }): Promise<number> {
        const result = await this.dataSource.query<AffectedRowsResult>(
            `INSERT INTO medication_administration_alerts
         (pid, order_id, assigned_to, severity, kind, title, detail, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'New')`,
            [
                input.pid,
                input.orderId ?? null,
                input.assignedTo ?? null,
                input.severity,
                input.kind,
                input.title.slice(0, 160),
                input.detail ?? null,
            ],
        );
        return result.insertId;
    }

    // ── Hospitalization: seed the MAR and notify the nurse ────────────────────

    /**
     * Mark a patient admitted to a bed, build the MAR from their active
     * prescriptions and raise the medication notifications the assigned nurse
     * must see. Idempotent: re-admitting reconciles rather than duplicates.
     */
    async hospitalize(pid: number, dto: HospitalizeDto, actor: MarActor = {}) {
        const [patient] = await this.dataSource.query<PatientRow[]>(
            `SELECT id, pid, fname, lname, status FROM patient_data WHERE pid = ? LIMIT 1`,
            [pid],
        );
        if (!patient) {
            throw new NotFoundException(`Patient #${pid} not found`);
        }

        const existing = await this.getAssignment(pid);
        const room = String(dto?.room ?? existing?.room ?? '').trim();
        if (!room) {
            throw new BadRequestException(
                'A room or bed is required to hospitalize a patient.',
            );
        }

        const nominated = Number(dto?.nurseId) || null;
        const nurseId =
            nominated ||
            existing?.assigned_nurse_id ||
            (await this.pickNurse());

        await this.dataSource.query(
            `INSERT INTO patient_care_assignment
         (pid, room, assigned_nurse_id, updated_at, updated_by)
       VALUES (?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE
         room = VALUES(room),
         assigned_nurse_id = COALESCE(VALUES(assigned_nurse_id), assigned_nurse_id),
         updated_at = NOW(),
         updated_by = VALUES(updated_by)`,
            [pid, room, nurseId, actor.id ?? null],
        );

        const orders = await this.reconcileOrdersFromPrescriptions(
            pid,
            actor.id,
        );
        const alerts = await this.notifyHospitalization(
            pid,
            patient,
            room,
            nurseId,
            orders,
        );

        this.logger.log(
            `Patient #${pid} hospitalized in room ${room} → RN #${nurseId}; ` +
                `${orders.length} MAR order(s), ${alerts} alert(s)`,
        );

        return {
            pid,
            room,
            nurseId,
            orders: orders.length,
            highAlert: orders.filter((o) => o.highAlert).length,
            alerts,
        };
    }


    /**
     * Build/refresh one MAR order per active prescription. Returns the orders so
     * the caller can notify on the high-alert ones.
     */
    private async reconcileOrdersFromPrescriptions(
        pid: number,
        orderedBy?: number,
    ): Promise<
        { id: number; drug: string; highAlert: boolean; isPrn: boolean }[]
    > {
        const rxs = await this.dataSource.query<PrescriptionSeedRow[]>(
            `SELECT id, drug, dosage, route, \`interval\` AS dose_interval, prn
       FROM prescriptions
       WHERE patient_id = ? AND active = 1 AND drug IS NOT NULL AND drug <> ''
       ORDER BY id ASC`,
            [pid],
        );

        const orders: {
            id: number;
            drug: string;
            highAlert: boolean;
            isPrn: boolean;
        }[] = [];

        for (const rx of rxs) {
            const drug = String(rx.drug || '').trim();
            if (!drug) continue;
            const { dose, unit } = this.splitDose(rx.dosage);
            const frequency = String(rx.route || '').trim();
            const prnText = `${rx.prn || ''} ${frequency}`.toLowerCase();
            const parsed = parseFrequencyToHours(frequency);
            const isPrn = /prn|as needed|when required/.test(prnText);
            // Unscheduled non-PRN orders still need a first-dose review on
            // admission, so they default to a 24h cadence rather than vanishing.
            const intervalHours = isPrn ? null : (parsed ?? 24);
            const highAlert = isHighAlertDrug(drug) ? 1 : 0;

            const result = await this.dataSource.query<AffectedRowsResult>(
                `INSERT INTO medication_administration_orders
           (pid, prescription_id, drug, dose, dose_unit, route, frequency,
            interval_hours, next_due_at, is_prn, high_alert, status, ordered_by,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, 'active', ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           drug = VALUES(drug), dose = VALUES(dose), dose_unit = VALUES(dose_unit),
           route = VALUES(route), frequency = VALUES(frequency),
           interval_hours = VALUES(interval_hours),
           next_due_at = COALESCE(next_due_at, VALUES(next_due_at)),
           is_prn = VALUES(is_prn), high_alert = VALUES(high_alert),
           status = IF(status = 'stopped', 'active', status),
           updated_at = NOW()`,
                [
                    pid,
                    rx.id,
                    drug.slice(0, 255),
                    dose,
                    unit,
                    frequency.slice(0, 80) || null,
                    frequency.slice(0, 80) || null,
                    intervalHours,
                    isPrn ? 1 : 0,
                    highAlert,
                    orderedBy ?? null,
                ],
            );

            orders.push({
                id: result.insertId,
                drug,
                highAlert: highAlert === 1,
                isPrn,
            });
        }

        return orders;
    }

    /** Raise the admission notification(s) the nurse must act on. */
    private async notifyHospitalization(
        pid: number,
        patient: PatientRow,
        room: string,
        nurseId: number | null,
        orders: { id: number; drug: string; highAlert: boolean }[],
    ): Promise<number> {
        const name =
            `${patient.fname || ''} ${patient.lname || ''}`.trim() ||
            `Patient #${pid}`;
        let raised = 0;

        await this.raiseAlert({
            pid,
            assignedTo: nurseId,
            severity: 'info',
            kind: 'hospitalized',
            title: `Medication review needed — ${name} admitted to room ${room}`,
            detail:
                `${orders.length} active medication order(s) require administration review.` +
                (orders.length
                    ? ` Orders: ${orders.map((o) => o.drug).join(', ')}.`
                    : ''),
        });
        raised += 1;

        for (const order of orders.filter((o) => o.highAlert)) {
            await this.raiseAlert({
                pid,
                orderId: order.id,
                assignedTo: nurseId,
                severity: 'critical',
                kind: 'high_alert',
                title: `High-alert medicine — ${order.drug} for ${name}`,
                detail: `Independent double-check required before administering ${order.drug} (room ${room}).`,
            });
            raised += 1;
        }

        return raised;
    }


    /** Discharge: stop the running MAR orders and clear the bed. */
    async discharge(pid: number, actor: MarActor = {}) {
        const existing = await this.getAssignment(pid);
        const stopped = await this.dataSource.query<AffectedRowsResult>(
            `UPDATE medication_administration_orders
       SET status = 'stopped', updated_at = NOW()
       WHERE pid = ? AND status = 'active'`,
            [pid],
        );

        await this.dataSource.query(
            `UPDATE patient_care_assignment
       SET room = NULL, updated_at = NOW(), updated_by = ?
       WHERE pid = ?`,
            [actor.id ?? null, pid],
        );

        await this.raiseAlert({
            pid,
            assignedTo: existing?.assigned_nurse_id ?? null,
            severity: 'info',
            kind: 'discharged',
            title: `Patient #${pid} discharged — ${stopped.affectedRows} medication order(s) stopped`,
            detail: 'Active administration orders were discontinued at discharge.',
        });

        return { pid, room: null, stoppedOrders: stopped.affectedRows };
    }

    // ── Bedside administration ─────────────────────────────────────────────

    /**
     * Record an administration after the smart safety check. A hard stop
     * (allergy conflict / wrong patient) is refused unless a clinical override
     * reason is supplied, and every override is stored on the record.
     */
    async recordAdministration(
        orderId: number,
        dto: AdministrationDto,
        nurse: MarActor = {},
    ) {
        const [order] = await this.dataSource.query<MarOrderRow[]>(
            `SELECT id, pid, prescription_id, drug, dose, dose_unit, route,
              frequency, interval_hours, next_due_at, is_prn, high_alert, status
       FROM medication_administration_orders WHERE id = ? LIMIT 1`,
            [orderId],
        );
        if (!order) {
            throw new NotFoundException(`Medication order #${orderId} not found`);
        }

        const [patient] = await this.dataSource.query<PatientRow[]>(
            `SELECT id, pid, fname, lname, status FROM patient_data WHERE pid = ? LIMIT 1`,
            [order.pid],
        );

        const allergies = await this.dataSource.query<AllergyInput[]>(
            `SELECT title AS allergen, comments AS reaction
       FROM lists
       WHERE pid = ? AND type = 'allergy'
         AND (activity IS NULL OR activity = 1)`,
            [order.pid],
        );

        // Other medicines currently active for this patient. Queried separately
        // rather than with UNION: the MAR and prescriptions tables can carry
        // different collations, which makes a UNION fail on some servers.
        const rxDrugs = await this.dataSource.query<{ drug: string }[]>(
            `SELECT drug FROM prescriptions
       WHERE patient_id = ? AND active = 1 AND id <> ?`,
            [order.pid, order.prescription_id ?? 0],
        );
        const marDrugs = await this.dataSource.query<{ drug: string }[]>(
            `SELECT drug FROM medication_administration_orders
       WHERE pid = ? AND status = 'active' AND id <> ?`,
            [order.pid, orderId],
        );
        const activeDrugs = [...(rxDrugs || []), ...(marDrugs || [])];

        const verdict: AdministrationVerdict = evaluateAdministration({
            patientId: Number(dto?.patientId) || order.pid,
            orderPatientId: order.pid,
            drug: order.drug,
            dose: dto?.dose ?? order.dose,
            unit: order.dose_unit,
            route: dto?.route ?? order.route,
            scheduledAt: dto?.scheduledAt ?? order.next_due_at,
            administeredAt: dto?.administeredAt ?? new Date(),
            allergies: allergies || [],
            activeDrugs: (activeDrugs || []).map((r) => r.drug),
            isHighAlert: order.high_alert === 1,
        });

        const overrideReason = String(dto?.overrideReason ?? '').trim();
        if (verdict.requiresOverride && !overrideReason) {
            throw new BadRequestException({
                message:
                    'Medication administration blocked by the safety check. A clinical override reason is required.',
                decision: verdict.decision,
                issues: verdict.issues,
            });
        }

        const administeredAt = dto?.administeredAt
            ? new Date(dto.administeredAt)
            : new Date();

        const result = await this.dataSource.query<AffectedRowsResult>(
            `INSERT INTO medication_administration_records
         (order_id, pid, status, scheduled_at, administered_at, dose_given,
          administered_by, witness_by, site, notes, override_reason, safety_json,
          created_at)
       VALUES (?, ?, 'given', ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                orderId,
                order.pid,
                dto?.scheduledAt ?? order.next_due_at ?? null,
                administeredAt,
                String(dto?.dose ?? order.dose ?? '').slice(0, 120) || null,
                nurse.id ?? null,
                Number(dto?.witnessBy) || null,
                dto?.site ? String(dto.site).slice(0, 60) : null,
                dto?.notes ? String(dto.notes) : null,
                overrideReason || null,
                JSON.stringify(verdict),
            ],
        );

        const intervalHours =
            order.is_prn === 1 ? null : Number(order.interval_hours);
        const due = nextDueAt(administeredAt, intervalHours);
        await this.dataSource.query(
            `UPDATE medication_administration_orders
       SET next_due_at = ?, updated_at = NOW() WHERE id = ?`,
            [due, orderId],
        );

        if (overrideReason) {
            const name =
                `${patient?.fname || ''} ${patient?.lname || ''}`.trim();
            await this.raiseAlert({
                pid: order.pid,
                orderId,
                assignedTo: nurse.id ?? null,
                severity: 'critical',
                kind: 'override',
                title: `Safety override — ${order.drug}`,
                detail: `${name || `Patient #${order.pid}`}: ${overrideReason}`,
            });
        }

        return {
            recordId: result.insertId,
            orderId,
            pid: order.pid,
            verdict,
            nextDueAt: due,
        };
    }


    // ── Read models ──────────────────────────────────────────────────────────

    /** All MAR orders for a patient, newest due first. */
    async getPatientOrders(pid: number): Promise<MarOrderRow[]> {
        return this.dataSource.query<MarOrderRow[]>(
            `SELECT o.id, o.pid, o.prescription_id, o.drug, o.dose, o.dose_unit,
              o.route, o.frequency, o.interval_hours, o.next_due_at, o.is_prn,
              o.high_alert, o.status, o.ordered_by,
              pd.fname, pd.lname, ca.room
       FROM medication_administration_orders o
       JOIN patient_data pd ON pd.pid = o.pid
       LEFT JOIN patient_care_assignment ca ON ca.pid = o.pid
       WHERE o.pid = ?
       ORDER BY FIELD(o.status, 'active', 'held', 'stopped', 'completed'),
                o.next_due_at IS NULL, o.next_due_at, o.id`,
            [pid],
        );
    }

    /**
     * The medication-administration pane for the nurse dashboard: every
     * hospitalized patient's scheduled medicines classified into due / overdue,
     * with the high-alert count and this nurse's unread notifications.
     */
    async getDashboard(nurseId: number, isAdmin = false) {
        const orders = await this.dataSource.query<MarOrderRow[]>(
            `SELECT o.id, o.pid, o.prescription_id, o.drug, o.dose, o.dose_unit,
              o.route, o.frequency, o.interval_hours, o.next_due_at, o.is_prn,
              o.high_alert, o.status,
              pd.fname, pd.lname, ca.room,
              (ca.assigned_nurse_id = ? OR ca.charge_nurse_id = ?) AS is_assigned
       FROM medication_administration_orders o
       JOIN patient_data pd ON pd.pid = o.pid
       JOIN patient_care_assignment ca ON ca.pid = o.pid
       WHERE o.status = 'active'
         AND ca.room IS NOT NULL AND ca.room <> ''
         AND pd.status = 'active'
       ORDER BY o.next_due_at IS NULL, o.next_due_at, pd.lname, pd.fname`,
            [nurseId, nurseId],
        );

        const now = new Date();
        const decorate = (o: MarOrderRow) => {
            const status = o.is_prn
                ? { state: 'unscheduled' as const, minutesUntil: null }
                : scheduleStatus(o.next_due_at, now);
            return {
                order_id: o.id,
                pid: o.pid,
                patient_name: `${o.fname || ''} ${o.lname || ''}`.trim(),
                room: o.room ?? null,
                drug: o.drug,
                dose: [o.dose, o.dose_unit].filter(Boolean).join(' ') || null,
                route: o.route,
                frequency: o.frequency,
                scheduled_at: o.next_due_at,
                status: status.state,
                minutes_until: status.minutesUntil,
                high_alert: o.high_alert === 1,
                is_prn: o.is_prn === 1,
                is_assigned: Number((o as { is_assigned?: number }).is_assigned) || 0,
            };
        };

        const all = orders.map(decorate);
        const dueNow = all.filter((o) => o.status === 'due');
        const overdue = all.filter((o) => o.status === 'overdue');
        const highAlert = all.filter((o) => o.high_alert);

        const patientIds = Array.from(new Set(orders.map((o) => o.pid)));
        const alerts = await this.listAlerts(nurseId, isAdmin, 25);

        return {
            summary: {
                hospitalized: patientIds.length,
                scheduled: all.filter((o) => !o.is_prn).length,
                dueNow: dueNow.length,
                overdue: overdue.length,
                highAlert: highAlert.length,
                unreadAlerts: alerts.unread,
            },
            due: [...overdue, ...dueNow].slice(0, 50),
            highAlert,
            alerts: alerts.alerts,
            generatedAt: now.toISOString(),
        };
    }

    // ── Alerts / notifications ────────────────────────────────────────────────

    /** Unread medication-administration notices for a user. */
    async listAlerts(nurseId: number, isAdmin = false, limit = 25) {
        const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
        const rows = await this.dataSource.query<AlertRow[]>(
            `SELECT id, pid, order_id, assigned_to, severity, kind, title,
              detail, status, created_at
       FROM medication_administration_alerts
       WHERE (? = 1 OR assigned_to IS NULL OR assigned_to = 0 OR assigned_to = ?)
       ORDER BY FIELD(severity, 'critical', 'warning', 'info'),
                created_at DESC, id DESC
       LIMIT ${take}`,
            [isAdmin ? 1 : 0, nurseId],
        );
        return {
            unread: rows.filter(
                (r) => String(r.status).toLowerCase() === 'new',
            ).length,
            alerts: rows,
        };
    }

    /** Mark one medication-administration notice as read. */
    async ackAlert(id: number) {
        await this.dataSource.query(
            `UPDATE medication_administration_alerts
       SET status = 'Read', read_at = NOW() WHERE id = ?`,
            [id],
        );
        return { id, status: 'Read' };
    }

    /** Mark every notice for this user as read. */
    async ackAllAlerts(nurseId: number, isAdmin = false) {
        await this.dataSource.query(
            `UPDATE medication_administration_alerts
       SET status = 'Read', read_at = NOW()
       WHERE status = 'New'
         AND (? = 1 OR assigned_to IS NULL OR assigned_to = 0 OR assigned_to = ?)`,
            [isAdmin ? 1 : 0, nurseId],
        );
        return { updated: true };
    }
}

