import {
    Injectable,
    Logger,
    BadRequestException,
    OnModuleInit,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { B2StorageService } from '../storage/b2-storage.service';
import { Document, DocumentStatus } from './document.entity';

/** A file as delivered by Multer's memory storage. */
export interface UploadedFilePayload {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}

/**
 * A document row as returned to clients: the hashed access code never leaves the
 * server, and the plain code is only attached for the uploader.
 */
export type SanitizedDocument = Omit<
    Document,
    'accessCodeHash' | 'plainCode'
> & { plainCode?: string };

@Injectable()
export class DocumentsService implements OnModuleInit {
    private readonly logger = new Logger(DocumentsService.name);

    constructor(
        private readonly b2: B2StorageService,
        private readonly config: ConfigService,
        @InjectRepository(Document)
        private readonly docRepo: Repository<Document>,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.ensureSchema();
    }

    /**
     * Create the `documents_secure` table if it does not yet exist.
     *
     * The table backs the TypeORM `Document` entity, but `synchronize` is off and
     * no migration shipped it, so a fresh deployment had no `documents_secure`
     * table and the /documents endpoints failed with a 5xx. Self-heal it on boot
     * instead of relying on the table already being present in production.
     */
    private async ensureSchema(): Promise<void> {
        await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS documents_secure (
        id               INT(11) NOT NULL AUTO_INCREMENT,
        originalName     VARCHAR(255) NOT NULL,
        mimeType         VARCHAR(100) NOT NULL,
        sizeBytes        BIGINT(20) NOT NULL,
        b2FileId         VARCHAR(255) NOT NULL,
        b2Path           VARCHAR(500) NOT NULL,
        accessCodeHash   VARCHAR(255) NOT NULL,
        plainCode        VARCHAR(10) DEFAULT '',
        pid              INT(11) DEFAULT 0,
        uploaderUserId   INT(11) DEFAULT 0,
        uploadedBy       VARCHAR(100) NOT NULL,
        recipientContact VARCHAR(255) DEFAULT '',
        recipientName    VARCHAR(255) DEFAULT '',
        category         VARCHAR(50) DEFAULT 'general',
        status           VARCHAR(20) DEFAULT 'pending',
        notes            TEXT DEFAULT NULL,
        accessCount      INT(11) DEFAULT 0,
        lastAccessedAt   DATETIME DEFAULT NULL,
        createdAt        DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_pid (pid),
        KEY idx_uploader (uploaderUserId),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
        this.logger.log('Documents schema ready');
    }

    private get bucket() {
        return {
            bucketId: this.config.get<string>('B2_BUCKET_DOCUMENTS_ID') || '',
            bucketName:
                this.config.get<string>('B2_BUCKET_DOCUMENTS_NAME') || '',
        };
    }

    // ── 4-Digit Code ───────────────────────────────────────────

    generateAccessCode(): string {
        return String(Math.floor(1000 + Math.random() * 9000));
    }

    async hashCode(code: string): Promise<string> {
        return bcrypt.hash(code, 8);
    }

    async verifyCode(code: string, hash: string): Promise<boolean> {
        return bcrypt.compare(code, hash);
    }

    // ── Upload ─────────────────────────────────────────────────

    async uploadFile(
        file: UploadedFilePayload,
        metadata: {
            pid?: number;
            uploadedBy: string;
            uploaderUserId?: number;
            recipientContact?: string;
            recipientName?: string;
            category?: string;
            notes?: string;
        },
    ): Promise<{ document: SanitizedDocument; accessCode: string }> {
        const accessCode = this.generateAccessCode();
        const codeHash = await this.hashCode(accessCode);
        const safeName = this.b2.generateSafeName(file.originalname, 'docs');

        const result = await this.b2.upload(
            this.bucket,
            file.buffer,
            safeName,
            file.mimetype || 'application/octet-stream',
        );

        const doc = this.docRepo.create({
            originalName: file.originalname,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            b2FileId: result.fileId,
            b2Path: result.fileName,
            accessCodeHash: codeHash,
            plainCode: accessCode,
            pid: metadata.pid || 0,
            uploaderUserId: metadata.uploaderUserId || 0,
            uploadedBy: metadata.uploadedBy,
            recipientContact: metadata.recipientContact || '',
            recipientName: metadata.recipientName || '',
            category: metadata.category || 'general',
            status: 'pending',
            notes: metadata.notes || '',
        });

        const saved = await this.docRepo.save(doc);
        this.logger.log(
            `Document uploaded to B2: ${saved.id} — code ${accessCode}`,
        );
        return { document: this.sanitizeDocument(saved, true), accessCode };
    }

    // ── List All (admin view, no codes exposed) ────────────────

    async listDocuments(pid?: number): Promise<SanitizedDocument[]> {
        const where: { pid?: number } = {};
        if (pid !== undefined && pid > 0) {
            where.pid = pid;
        }
        const docs = await this.docRepo.find({
            where,
            order: { createdAt: 'DESC' },
        });
        return docs.map((d) => this.sanitizeDocument(d, false));
    }

    // ── My Documents (uploader view, codes exposed) ────────────

    async listMyDocuments(
        userId: number,
        pid?: number,
    ): Promise<SanitizedDocument[]> {
        const where: { uploaderUserId: number; pid?: number } = {
            uploaderUserId: userId,
        };
        if (pid !== undefined && pid > 0) {
            where.pid = pid;
        }
        const docs = await this.docRepo.find({
            where,
            order: { createdAt: 'DESC' },
        });
        return docs.map((d) => this.sanitizeDocument(d, true));
    }

    // ── Update Status ─────────────────────────────────────────

    async updateStatus(
        id: number,
        status: DocumentStatus,
        userId: number,
    ): Promise<SanitizedDocument> {
        const doc = await this.docRepo.findOne({ where: { id } });
        if (!doc) throw new BadRequestException('Document not found');
        if (doc.uploaderUserId !== userId) {
            throw new BadRequestException(
                'Only the uploader can update document status',
            );
        }
        doc.status = status;
        const saved = await this.docRepo.save(doc);
        return this.sanitizeDocument(saved, true);
    }

    // ── Verify Code ────────────────────────────────────────────

    async verifyDocumentCode(
        id: number,
        code: string,
    ): Promise<{ valid: boolean; downloadUrl?: string }> {
        const doc = await this.docRepo.findOne({ where: { id } });
        if (!doc) {
            throw new BadRequestException('Document not found');
        }

        const valid = await this.verifyCode(code, doc.accessCodeHash);
        if (!valid) {
            return { valid: false };
        }

        doc.accessCount += 1;
        doc.lastAccessedAt = new Date();
        if (doc.status === 'pending') {
            doc.status = 'accepted';
        }
        await this.docRepo.save(doc);

        const url = await this.b2.getDownloadUrl(this.bucket, doc.b2Path, 300);
        return { valid: true, downloadUrl: url };
    }

    // ── Get Single Document ────────────────────────────────────

    async getDocument(
        id: number,
        userId?: number,
    ): Promise<SanitizedDocument | null> {
        const doc = await this.docRepo.findOne({ where: { id } });
        if (!doc) return null;
        const isOwner = userId !== undefined && doc.uploaderUserId === userId;
        return this.sanitizeDocument(doc, isOwner);
    }

    // ── Get Download URL ───────────────────────────────────────

    async getDocumentDownloadUrl(id: number): Promise<string> {
        const doc = await this.docRepo.findOne({ where: { id } });
        if (!doc) throw new BadRequestException('Document not found');
        return this.b2.getDownloadUrl(this.bucket, doc.b2Path, 300);
    }

    // ── Sanitize ───────────────────────────────────────────────

    private sanitizeDocument(
        doc: Document,
        includeCode: boolean,
    ): SanitizedDocument {
        // The copy is typed with the entity's fields optional so the two secret
        // fields can be removed; the result still satisfies the response shape.
        const sanitized: SanitizedDocument & Partial<Document> = { ...doc };
        delete sanitized.accessCodeHash;
        if (!includeCode) {
            delete sanitized.plainCode;
        }
        return sanitized;
    }
}
