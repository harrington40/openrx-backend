import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SmartController } from './smart.controller';
import { jwtSecret } from '../config/secrets';

@Module({
    imports: [
        JwtModule.register({
            secret: jwtSecret(),
        }),
    ],
    controllers: [SmartController],
})
export class SmartModule {}
