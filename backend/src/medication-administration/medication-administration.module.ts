import { Module } from '@nestjs/common';
import { MedicationAdministrationController } from './medication-administration.controller';
import { MedicationAdministrationService } from './medication-administration.service';

@Module({
    controllers: [MedicationAdministrationController],
    providers: [MedicationAdministrationService],
    exports: [MedicationAdministrationService],
})
export class MedicationAdministrationModule {}
