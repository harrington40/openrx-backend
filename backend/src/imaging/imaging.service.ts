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
import { Imaging, ImagingType } from './imaging.entity';

/** Study file as delivered by Multer's memory storage. */
export interface UploadedImagingFile {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}

@Injectable()
export class ImagingService implements OnModuleInit {
    private readonly logger = new Logger(ImagingService.name);

    constructor(
        private readonly b2: B2StorageService,
        private readonly config: ConfigService,
        @InjectRepository(Imaging)
        private readonly imagingRepo: Repository<Imaging>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.ensureSchema();
    }

    /**
     * Create the `imaging` table if it does not yet exist.
     *
     * The table backs the TypeORM `Imaging` entity, but `synchronize` is off and
     * no migration shipped it, so a fresh deployment had no `imaging` table and
     * the imaging endpoints failed with a 5xx. Self-heal it on boot instead of
     * relying on the table already being present in the production database.
     */
    private async ensureSchema(): Promise<void> {
        await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS imaging (
        id           INT(11) NOT NULL AUTO_INCREMENT,
        pid          INT(11) NOT NULL,
        eid          INT(11) DEFAULT NULL,
        type         VARCHAR(20) NOT NULL,
        originalName VARCHAR(255) NOT NULL,
        mimeType     VARCHAR(100) NOT NULL,
        sizeBytes    BIGINT(20) NOT NULL,
        b2FileId     VARCHAR(255) NOT NULL,
        b2Path       VARCHAR(500) NOT NULL,
        description  VARCHAR(500) DEFAULT '',
        uploadedBy   VARCHAR(100) NOT NULL,
        createdAt    DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_pid (pid),
        KEY idx_type (type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
        this.logger.log('Imaging schema ready');
    }

    private getBucket(type: ImagingType) {
        const prefix = type === 'xray' ? 'XRAYS' : 'LABS';
        return {
            bucketId: this.config.get<string>(`B2_BUCKET_${prefix}_ID`) || '',
            bucketName:
                this.config.get<string>(`B2_BUCKET_${prefix}_NAME`) || '',
        };
    }

    async upload(
        type: ImagingType,
        file: UploadedImagingFile,
        metadata: {
            pid: number;
            eid?: number;
            uploadedBy: string;
            description?: string;
        },
    ): Promise<Imaging> {
        if (!file) throw new BadRequestException('File is required');
        if (!metadata.pid)
            throw new BadRequestException('Patient ID is required');

        const bucket = this.getBucket(type);
        const safeName = this.b2.generateSafeName(
            file.originalname,
            `${type}/pid-${metadata.pid}`,
        );

        const result = await this.b2.upload(
            bucket,
            file.buffer,
            safeName,
            file.mimetype || 'application/dicom',
        );

        const image = this.imagingRepo.create({
            type,
            pid: metadata.pid,
            eid: metadata.eid || null,
            originalName: file.originalname,
            mimeType: file.mimetype || 'application/dicom',
            sizeBytes: file.size,
            b2FileId: result.fileId,
            b2Path: result.fileName,
            description: metadata.description || '',
            uploadedBy: metadata.uploadedBy,
        });

        const saved = await this.imagingRepo.save(image);
        this.logger.log(
            `Imaging uploaded: ${type} for pid=${metadata.pid} → ${saved.id}`,
        );
        return saved;
    }

    async listByPatient(pid: number, type?: ImagingType): Promise<Imaging[]> {
        const where: { pid: number; type?: ImagingType } = { pid };
        if (type) where.type = type;
        return this.imagingRepo.find({
            where,
            order: { createdAt: 'DESC' },
        });
    }

    async getOne(id: number): Promise<Imaging | null> {
        return this.imagingRepo.findOne({ where: { id } });
    }

    async getDownloadUrl(id: number): Promise<string> {
        const image = await this.imagingRepo.findOne({ where: { id } });
        if (!image) throw new BadRequestException('Imaging record not found');

        const bucket = this.getBucket(image.type);
        return this.b2.getDownloadUrl(bucket, image.b2Path, 3600);
    }

    async delete(id: number): Promise<void> {
        const image = await this.imagingRepo.findOne({ where: { id } });
        if (!image) throw new BadRequestException('Imaging record not found');

        await this.b2.deleteFile(image.b2FileId, image.b2Path);
        await this.imagingRepo.remove(image);
        this.logger.log(`Imaging deleted: ${id}`);
    }
}
