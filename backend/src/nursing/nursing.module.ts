import { Module } from '@nestjs/common';
import { NursingController } from './nursing.controller';
import { NursingService } from './nursing.service';
import { SmartRoutingService } from './smart-routing.service';
import { MedicationAdministrationModule } from '../medication-administration/medication-administration.module';

@Module({
    // The RN workspace embeds the medication-administration board, so it reads
    // that service directly rather than re-implementing the MAR queries.
    imports: [MedicationAdministrationModule],
    controllers: [NursingController],
    providers: [NursingService, SmartRoutingService],
    exports: [SmartRoutingService],
})
export class NursingModule {}
