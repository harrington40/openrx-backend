import {
    Controller,
    Get,
    Post,
    Param,
    Body,
    Req,
    UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MedicationAdministrationService } from './medication-administration.service';
import type {
    AdministrationDto,
    HospitalizeDto,
    MarActor,
} from './medication-administration.service';

/** Authenticated request used by the medication-administration endpoints. */
interface MarRequest {
    user?: {
        sub?: number;
        username?: string;
        displayName?: string;
        role?: string;
    };
}

/** Roles that may look at the MAR / ward medication board. */
const READ_ROLES = ['admin', 'physician', 'nurse', 'registered_nurse'];

/** Roles that may record a bedside administration. */
const ADMINISTER_ROLES = ['admin', 'nurse', 'registered_nurse'];

function actor(req: MarRequest): MarActor {
    return {
        id: Number(req.user?.sub) || undefined,
        username: req.user?.username,
        displayName: req.user?.displayName,
    };
}

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class MedicationAdministrationController {
    constructor(private readonly mar: MedicationAdministrationService) {}

    /**
     * The medication-administration pane for the nurse dashboard: hospitalized
     * patients' due/overdue medicines, high-alert flags and unread notices.
     */
    @Get('medication-administration/dashboard')
    @Roles(...READ_ROLES)
    dashboard(@Req() req: MarRequest) {
        return this.mar.getDashboard(
            Number(req.user?.sub) || 0,
            req.user?.role === 'admin',
        );
    }

    /** The MAR for one patient. */
    @Get('patients/:pid/medication-orders')
    @Roles(...READ_ROLES)
    patientOrders(@Param('pid') pid: string) {
        return this.mar.getPatientOrders(+pid);
    }

    /**
     * Admit a patient to a bed: builds the MAR from their active prescriptions
     * and notifies the assigned nurse about the medication review.
     */
    @Post('patients/:pid/hospitalize')
    @Roles(...READ_ROLES)
    hospitalize(
        @Param('pid') pid: string,
        @Body() dto: HospitalizeDto,
        @Req() req: MarRequest,
    ) {
        return this.mar.hospitalize(+pid, dto || {}, actor(req));
    }

    /** Discharge a patient: stops the running MAR orders and clears the bed. */
    @Post('patients/:pid/discharge')
    @Roles(...READ_ROLES)
    discharge(@Param('pid') pid: string, @Req() req: MarRequest) {
        return this.mar.discharge(+pid, actor(req));
    }

    /**
     * Record a bedside administration. The smart safety check runs first; a hard
     * stop is refused unless `overrideReason` is supplied.
     */
    @Post('medication-administration/orders/:id/administer')
    @Roles(...ADMINISTER_ROLES)
    administer(
        @Param('id') id: string,
        @Body() dto: AdministrationDto,
        @Req() req: MarRequest,
    ) {
        return this.mar.recordAdministration(+id, dto || { patientId: 0 }, actor(req));
    }

    /** Medication-administration notifications for the signed-in user. */
    @Get('medication-administration/alerts')
    @Roles(...READ_ROLES)
    alerts(@Req() req: MarRequest) {
        return this.mar.listAlerts(
            Number(req.user?.sub) || 0,
            req.user?.role === 'admin',
        );
    }

    /** Mark one notice as read. */
    @Post('medication-administration/alerts/:id/ack')
    @Roles(...ADMINISTER_ROLES)
    ack(@Param('id') id: string) {
        return this.mar.ackAlert(+id);
    }

    /** Mark every notice for this user as read. */
    @Post('medication-administration/alerts/read-all')
    @Roles(...ADMINISTER_ROLES)
    ackAll(@Req() req: MarRequest) {
        return this.mar.ackAllAlerts(
            Number(req.user?.sub) || 0,
            req.user?.role === 'admin',
        );
    }
}
