import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { jwtSecret } from '../config/secrets';
import { JwtStrategy } from './jwt.strategy';
import { AuthController } from './auth.controller';
import { RolesGuard } from './roles.guard';
import { AbacModule } from './abac/abac.module';

@Module({
    imports: [
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({
            secret: jwtSecret(),
            signOptions: { expiresIn: '8h' },
        }),
        AbacModule,
    ],
    controllers: [AuthController],
    providers: [JwtStrategy, RolesGuard],
    exports: [PassportModule, JwtModule, RolesGuard, AbacModule],
})
export class AuthModule {}
