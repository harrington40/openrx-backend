import {
    Injectable,
    Logger,
    BadRequestException,
    OnModuleInit,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { License, LicenseTier } from './license.entity';
import {
    licenseGeneratorPassphraseHash,
    licenseSecrets,
} from '../config/secrets';

/**
 * Local license generation and validation.
 *
 * Supports secret rotation via SECRET_VERSIONS.
 * Current version is always first in the array.
 * Keys are validated against all active secret versions.
 */
@Injectable()
export class LicenseService implements OnModuleInit {
    private readonly logger = new Logger(LicenseService.name);

    // Rotation is configuration, not code: LICENSE_SECRETS holds
    // `<version>:<secret>` entries, newest first, and older entries stay so that
    // keys issued under them still validate. Nothing is hardcoded here - a
    // literal would be published along with the repository, which is the same as
    // handing out the ability to mint licences.
    private readonly SECRET_VERSIONS = licenseSecrets();

    // SHA-256 of the generator passphrase. Only the hash is configured; it used
    // to be a literal sitting under a comment that named the passphrase, which
    // made the passphrase public.
    private readonly GENERATOR_PASSPHRASE_HASH =
        licenseGeneratorPassphraseHash();

    /**
     * Verify the generator passphrase server-side.
     * No secrets exposed in client-side code.
     */
    verifyGeneratorPassphrase(passphrase: string): boolean {
        const hash = crypto
            .createHash('sha256')
            .update(passphrase)
            .digest('hex');
        return hash === this.GENERATOR_PASSPHRASE_HASH;
    }

    constructor(
        @InjectRepository(License)
        private readonly licenseRepo: Repository<License>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.ensureSchema();
    }

    /**
     * Create the `licenses` table if it does not yet exist.
     *
     * The table backs the TypeORM `License` entity, but `synchronize` is off and
     * no migration shipped it, so a fresh deployment had no `licenses` table and
     * `/license/status` failed with a 5xx. Self-heal it on boot instead of relying
     * on the row already being present in the production database.
     */
    private async ensureSchema(): Promise<void> {
        await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id           INT(11) NOT NULL AUTO_INCREMENT,
        licenseKey   VARCHAR(30) NOT NULL,
        tier         VARCHAR(20) DEFAULT 'basic',
        activatedAt  DATETIME DEFAULT NULL,
        expiresAt    DATETIME NOT NULL,
        status       VARCHAR(20) DEFAULT 'active',
        customerName VARCHAR(255) DEFAULT '',
        maxUsers     INT(11) DEFAULT 5,
        createdAt    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY licenseKey (licenseKey)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
        this.logger.log('License schema ready');
    }

    private get currentSecret(): string {
        return this.SECRET_VERSIONS[0].secret;
    }

    // ── Key Generation (server-side) ─────────────────────────

    /**
     * Generate a license key for a given tier and duration.
     * Uses the current (latest) secret version.
     */
    generateKey(tier: LicenseTier, durationMonths: number): string {
        const tierCode = tier[0].toUpperCase();
        const ts = Date.now().toString(16).slice(-8);
        const payload = `${tierCode}-${ts}-${durationMonths}`;
        const checksum = crypto
            .createHmac('sha256', this.currentSecret)
            .update(payload)
            .digest('hex')
            .slice(0, 4);
        return `OPENRX-${tierCode}${ts.slice(0, 4)}-${ts.slice(4)}${durationMonths.toString(16)}-${checksum}`.toUpperCase();
    }

    /**
     * Validate and decode a license key.
     * Tries all secret versions (supports rotation).
     */
    decodeKey(key: string): {
        tier: LicenseTier;
        generatedAt: number;
        durationMonths: number;
    } | null {
        for (const sv of this.SECRET_VERSIONS) {
            const result = this.decodeKeyWithSecret(key, sv.secret);
            if (result) return result;
        }
        return null;
    }

    private decodeKeyWithSecret(
        key: string,
        secret: string,
    ): {
        tier: LicenseTier;
        generatedAt: number;
        durationMonths: number;
    } | null {
        try {
            const clean = key.replace(/-/g, '').toUpperCase();
            if (!clean.startsWith('OPENRX')) return null;

            const tierCode = clean[6];
            const ts1 = clean.slice(7, 11);
            const ts2AndDur = clean.slice(11);
            const checksum = ts2AndDur.slice(-4);
            const ts2 = ts2AndDur.slice(0, 4);
            const durHex = ts2AndDur.slice(4, -4);
            const durationMonths = parseInt(durHex, 16);

            const tierMap: Record<string, LicenseTier> = {
                B: 'basic',
                P: 'professional',
                E: 'enterprise',
            };
            const tier = tierMap[tierCode];
            if (
                !tier ||
                isNaN(durationMonths) ||
                durationMonths < 1 ||
                durationMonths > 36
            )
                return null;

            const ts = ts1 + ts2;
            const payload = `${tierCode}-${ts}-${durationMonths}`;
            const expected = crypto
                .createHmac('sha256', secret)
                .update(payload)
                .digest('hex')
                .slice(0, 4);

            if (checksum !== expected) return null;

            return {
                tier,
                generatedAt: parseInt(ts, 16),
                durationMonths,
            };
        } catch {
            return null;
        }
    }

    // ── Activation ─────────────────────────────────────────────

    async activateKey(key: string, customerName?: string): Promise<License> {
        const decoded = this.decodeKey(key);
        if (!decoded) {
            throw new BadRequestException('Invalid license key');
        }

        const existing = await this.licenseRepo.findOne({
            where: { licenseKey: key },
        });
        if (existing) {
            if (existing.status === 'active') {
                throw new BadRequestException('License key already activated');
            }
            existing.status = 'active';
            existing.activatedAt = new Date();
            const expiry = new Date(decoded.generatedAt);
            expiry.setMonth(expiry.getMonth() + decoded.durationMonths);
            existing.expiresAt = expiry;
            existing.customerName = customerName || existing.customerName;
            existing.tier = decoded.tier;
            return this.licenseRepo.save(existing);
        }

        const generatedDate = new Date(decoded.generatedAt);
        const expiresAt = new Date(generatedDate);
        expiresAt.setMonth(expiresAt.getMonth() + decoded.durationMonths);

        const maxUsersMap: Record<LicenseTier, number> = {
            basic: 5,
            professional: 25,
            enterprise: 100,
        };

        const license = this.licenseRepo.create({
            licenseKey: key,
            tier: decoded.tier,
            activatedAt: new Date(),
            expiresAt,
            status: 'active',
            customerName: customerName || '',
            maxUsers: maxUsersMap[decoded.tier],
        });

        const saved = await this.licenseRepo.save(license);
        this.logger.log(
            `License activated: ${key} → expires ${expiresAt.toISOString()}`,
        );
        return saved;
    }

    // ── Validation ────────────────────────────────────────────

    async getActiveLicense(): Promise<License | null> {
        const now = new Date();
        await this.licenseRepo.update(
            { status: 'active', expiresAt: LessThanOrEqual(now) },
            { status: 'expired' },
        );
        return this.licenseRepo.findOne({
            where: { status: 'active' },
            order: { expiresAt: 'DESC' },
        });
    }

    async isValid(): Promise<boolean> {
        const license = await this.getActiveLicense();
        return license !== null;
    }

    async getStatus(): Promise<{
        valid: boolean;
        tier?: LicenseTier;
        expiresAt?: Date;
        daysRemaining?: number;
        customerName?: string;
        maxUsers?: number;
    }> {
        const license = await this.getActiveLicense();
        if (!license) return { valid: false };

        const now = new Date();
        const daysRemaining = Math.ceil(
            (license.expiresAt.getTime() - now.getTime()) /
                (1000 * 60 * 60 * 24),
        );

        return {
            valid: true,
            tier: license.tier,
            expiresAt: license.expiresAt,
            daysRemaining: Math.max(0, daysRemaining),
            customerName: license.customerName,
            maxUsers: license.maxUsers,
        };
    }

    // ── Revocation ────────────────────────────────────────────

    async revoke(licenseKey: string): Promise<void> {
        const license = await this.licenseRepo.findOne({
            where: { licenseKey },
        });
        if (!license) throw new BadRequestException('License not found');
        license.status = 'revoked';
        await this.licenseRepo.save(license);
        this.logger.log(`License revoked: ${licenseKey}`);
    }

    // ── Batch Generation ─────────────────────────────────────

    generateBatch(
        tier: LicenseTier,
        durationMonths: number,
        count: number,
    ): string[] {
        const keys: string[] = [];
        for (let i = 0; i < count; i++) {
            keys.push(this.generateKey(tier, durationMonths));
        }
        return keys;
    }
}
