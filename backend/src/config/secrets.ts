/**
 * Secrets read from the environment, with no fallbacks.
 *
 * Every one of these used to have a literal fallback in the source. That is
 * indistinguishable from publishing the value: this repository is public, so a
 * fallback is a key anyone can read, and a deployment that quietly ran with one
 * would be signing real sessions with a known key while reporting healthy. A
 * missing secret now stops the process at startup, which is loud and fixable,
 * instead of degrading to a published value, which is neither.
 */

/** Shorter than this is not worth calling a secret. */
const MIN_LENGTH = 16;

/** Suggested way to make one. */
const GENERATE = 'Generate one with `openssl rand -hex 32`';

/**
 * Values that have shipped in this repository, so they are public and must be
 * treated as compromised. Refusing them is the only way anyone notices that one
 * is still configured somewhere.
 */
const RETIRED = new Set([
    'openrx-secret-key-2024',
    'openrx-license-secret-v1',
    'openrx-license-secret-v2-2026',
    'openrx-sales-2024',
    'd5c7e8f9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7',
    'password123',
]);

/**
 * The value of a required secret, or an error naming the variable.
 */
export function requiredSecret(name: string): string {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error(
            `[config] ${name} is not set. ${GENERATE}, then set it in the ` +
                `environment - backend/.env locally, the service environment in ` +
                `production.`,
        );
    }

    const value = raw.trim();
    if (RETIRED.has(value)) {
        throw new Error(
            `[config] ${name} holds a value that has been published in this ` +
                `repository and must be considered compromised. ${GENERATE}.`,
        );
    }
    if (value.length < MIN_LENGTH) {
        throw new Error(
            `[config] ${name} is shorter than ${MIN_LENGTH} characters. ${GENERATE}.`,
        );
    }
    return value;
}

/** HS256 key for access tokens. */
export function jwtSecret(): string {
    return requiredSecret('JWT_SECRET');
}

/**
 * Licence signing secrets, newest first, as `<version>:<secret>` entries
 * separated by commas - for example `2:<new>,1:<old>`.
 *
 * Older entries stay so that keys issued under them still validate, which is
 * what makes rotation possible; generation uses the highest version.
 */
export function licenseSecrets(): { version: number; secret: string }[] {
    const entries = requiredSecret('LICENSE_SECRETS')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');

    const parsed = entries.map((entry, index) => {
        const at = entry.indexOf(':');
        const version = Number(entry.slice(0, at).trim());
        const secret = entry.slice(at + 1).trim();
        if (
            at < 1 ||
            !Number.isInteger(version) ||
            version < 1 ||
            secret.length < MIN_LENGTH
        ) {
            // Deliberately does not echo the entry: an error message is a log
            // line, and a log line that contains half a secret is a leak.
            throw new Error(
                `[config] LICENSE_SECRETS entry ${index + 1} is not ` +
                    `\`<version>:<secret>\` with a secret of at least ` +
                    `${MIN_LENGTH} characters (version parsed as ` +
                    `${Number.isNaN(version) ? 'not a number' : version}, secret ` +
                    `${secret.length} characters).`,
            );
        }
        return { version, secret };
    });

    if (parsed.length === 0) {
        throw new Error('[config] LICENSE_SECRETS is empty.');
    }
    if (new Set(parsed.map((entry) => entry.version)).size !== parsed.length) {
        throw new Error('[config] LICENSE_SECRETS repeats a version number.');
    }

    // Highest version first: the service treats the first entry as current.
    return parsed.sort((a, b) => b.version - a.version);
}

/**
 * SHA-256 of the sales-side generator passphrase. Only the hash is configured,
 * so the passphrase itself is not in the repository - but the hash this used to
 * hold shipped with a comment stating the passphrase, which is why that hash is
 * in RETIRED.
 */
export function licenseGeneratorPassphraseHash(): string {
    return requiredSecret('LICENSE_GENERATOR_PASSPHRASE_HASH');
}
