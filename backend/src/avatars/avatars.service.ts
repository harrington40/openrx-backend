import {
    Injectable,
    Logger,
    BadRequestException,
    OnModuleInit,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { B2StorageService } from '../storage/b2-storage.service';
import { Avatar } from './avatar.entity';

/** Image file as delivered by Multer's memory storage. */
export interface UploadedAvatarFile {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}

@Injectable()
export class AvatarsService implements OnModuleInit {
    private readonly logger = new Logger(AvatarsService.name);

    constructor(
        private readonly b2: B2StorageService,
        private readonly config: ConfigService,
        @InjectRepository(Avatar)
        private readonly avatarRepo: Repository<Avatar>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.ensureSchema();
    }

    /**
     * Create the `avatars` table if it does not yet exist.
     *
     * The table backs the TypeORM `Avatar` entity, but `synchronize` is off and
     * no migration shipped it, so a fresh deployment had no `avatars` table.
     * Self-heal it on boot instead of relying on the row already being present in
     * the production database.
     */
    private async ensureSchema(): Promise<void> {
        await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS avatars (
        id           INT(11) NOT NULL AUTO_INCREMENT,
        userId       INT(11) NOT NULL,
        originalName VARCHAR(255) NOT NULL,
        mimeType     VARCHAR(100) NOT NULL,
        sizeBytes    BIGINT(20) NOT NULL,
        b2FileId     VARCHAR(255) NOT NULL,
        b2Path       VARCHAR(500) NOT NULL,
        createdAt    DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY userId (userId),
        KEY idx_userId (userId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
        this.logger.log('Avatar schema ready');
    }

    private get bucket() {
        return {
            bucketId: this.config.get<string>('B2_BUCKET_AVATARS_ID') || '',
            bucketName: this.config.get<string>('B2_BUCKET_AVATARS_NAME') || '',
        };
    }

    async uploadAvatar(
        userId: number,
        file: UploadedAvatarFile,
    ): Promise<Avatar> {
        if (!file) throw new BadRequestException('File is required');

        const safeName = this.b2.generateSafeName(
            file.originalname,
            `user-${userId}`,
        );
        const result = await this.b2.upload(
            this.bucket,
            file.buffer,
            safeName,
            file.mimetype || 'image/png',
        );

        // Delete old avatar if exists
        const existing = await this.avatarRepo.findOne({ where: { userId } });
        if (existing) {
            try {
                await this.b2.deleteFile(existing.b2FileId, existing.b2Path);
            } catch {
                this.logger.warn(
                    `Could not delete old avatar: ${existing.b2FileId}`,
                );
            }
            await this.avatarRepo.remove(existing);
        }

        const avatar = this.avatarRepo.create({
            userId,
            originalName: file.originalname,
            mimeType: file.mimetype || 'image/png',
            sizeBytes: file.size,
            b2FileId: result.fileId,
            b2Path: result.fileName,
        });

        const saved = await this.avatarRepo.save(avatar);
        this.logger.log(`Avatar uploaded for user ${userId}: ${saved.id}`);
        return saved;
    }

    async getAvatar(
        userId: number,
    ): Promise<{ avatar: Avatar | null; url: string | null }> {
        const avatar = await this.avatarRepo.findOne({ where: { userId } });
        if (!avatar) return { avatar: null, url: null };

        const url = await this.b2.getDownloadUrl(
            this.bucket,
            avatar.b2Path,
            3600,
        );
        return { avatar, url };
    }

    async deleteAvatar(userId: number): Promise<void> {
        const avatar = await this.avatarRepo.findOne({ where: { userId } });
        if (!avatar) throw new BadRequestException('Avatar not found');

        try {
            await this.b2.deleteFile(avatar.b2FileId, avatar.b2Path);
        } catch (e) {
            // Still remove the record. "Remove my photo" has to work — leaving the row
            // behind means it cannot be removed from the UI at all and the request
            // surfaced as a 500. The object is logged so it can be cleaned up by hand.
            this.logger.error(
                `Could not delete B2 object ${avatar.b2FileId} (${avatar.b2Path}) for user ${userId}: ` +
                    (e instanceof Error ? e.message : String(e)),
            );
        }

        await this.avatarRepo.remove(avatar);
        this.logger.log(`Avatar deleted for user ${userId}`);
    }
}
