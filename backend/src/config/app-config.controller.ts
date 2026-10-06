import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_VERSION } from './version';

@Controller('config')
export class AppConfigController {
    constructor(private readonly config: ConfigService) {}

    @Get()
    getConfig() {
        return {
            language: this.config.get<string>('LANGUAGE') || 'en',
            appName: 'OpenRx',
            // Baked in at release time (tools/release.py); APP_VERSION overrides.
            version: process.env.APP_VERSION || APP_VERSION,
        };
    }
}
