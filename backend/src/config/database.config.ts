import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    username: process.env.DB_USERNAME || 'openemr',
    // No literal fallback. A default password here is a password published in
    // the source, and this one used to be the production database's. An unset
    // value means "no password", which is what a throwaway local database has.
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'openemr',
}));
