import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { jwtSecret } from '../config/secrets';

export interface JwtPayload {
    sub: number;
    username: string;
    displayName: string;
    role: string;
    main_menu_role: string;
    can_edit_providers: boolean;
    can_view_charts: boolean;
    can_edit_charges: boolean;
    iat?: number;
    exp?: number;
}

/**
 * Validates JWT access tokens issued by the NestJS login endpoint.
 * Uses HS256 with a shared secret.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            // No fallback: a literal here would be the signing key for every
            // deployment that never set JWT_SECRET, and it would be public.
            secretOrKey: jwtSecret(),
        });
    }

    validate(payload: JwtPayload): JwtPayload {
        if (!payload || !payload.sub) {
            throw new UnauthorizedException('Invalid token');
        }
        return {
            sub: payload.sub,
            username: payload.username,
            displayName: payload.displayName,
            role: payload.role || 'front_desk',
            main_menu_role: payload.main_menu_role || 'standard',
            can_edit_providers: payload.can_edit_providers || false,
            can_view_charts: payload.can_view_charts || false,
            can_edit_charges: payload.can_edit_charges || false,
        };
    }
}
