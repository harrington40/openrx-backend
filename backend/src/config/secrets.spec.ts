import {
    jwtSecret,
    licenseGeneratorPassphraseHash,
    licenseSecrets,
    requiredSecret,
} from './secrets';

/** Every variable these tests touch, and what it was before they ran. */
const TOUCHED = [
    'TEST_SECRET',
    'JWT_SECRET',
    'LICENSE_SECRETS',
    'LICENSE_GENERATOR_PASSPHRASE_HASH',
];
const SAVED = new Map(TOUCHED.map((name) => [name, process.env[name]]));

/** A value that passes every check. */
const OK = 'a'.repeat(48);
const RETIRED_JWT = 'openrx-secret-key-2024';
const RETIRED_HASH =
    'd5c7e8f9a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7';

function setEnv(name: string, value?: string): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

/** The message from whatever `fn` throws, for asserting on its content. */
function messageFrom(fn: () => unknown): string {
    try {
        fn();
    } catch (error) {
        return (error as Error).message;
    }
    throw new Error('expected the call to throw');
}

afterEach(() => {
    for (const name of TOUCHED) {
        const value = SAVED.get(name);
        if (value === undefined) {
            delete process.env[name];
        } else {
            process.env[name] = value;
        }
    }
});

describe('requiredSecret', () => {
    it('returns a configured secret', () => {
        setEnv('TEST_SECRET', OK);
        expect(requiredSecret('TEST_SECRET')).toBe(OK);
    });

    it('trims surrounding whitespace', () => {
        setEnv('TEST_SECRET', `  ${OK}  `);
        expect(requiredSecret('TEST_SECRET')).toBe(OK);
    });

    it('throws when the variable is missing, naming it', () => {
        setEnv('TEST_SECRET');
        expect(() => requiredSecret('TEST_SECRET')).toThrow(
            /TEST_SECRET is not set/,
        );
    });

    it('treats a blank value as missing', () => {
        setEnv('TEST_SECRET', '   ');
        expect(() => requiredSecret('TEST_SECRET')).toThrow(/is not set/);
    });

    it('refuses a value that has been published in this repository', () => {
        setEnv('TEST_SECRET', RETIRED_JWT);
        expect(() => requiredSecret('TEST_SECRET')).toThrow(
            /published in this repository/,
        );
    });

    it('refuses a secret shorter than the minimum', () => {
        setEnv('TEST_SECRET', 'too-short');
        expect(() => requiredSecret('TEST_SECRET')).toThrow(
            /shorter than 16 characters/,
        );
    });

    it('does not put the offending value in the error message', () => {
        setEnv('TEST_SECRET', RETIRED_JWT);
        expect(messageFrom(() => requiredSecret('TEST_SECRET'))).not.toContain(
            RETIRED_JWT,
        );
    });
});

describe('jwtSecret', () => {
    it('reads JWT_SECRET', () => {
        setEnv('JWT_SECRET', OK);
        expect(jwtSecret()).toBe(OK);
    });

    it('refuses the value production used to fall back to', () => {
        setEnv('JWT_SECRET', RETIRED_JWT);
        expect(() => jwtSecret()).toThrow(/compromised/);
    });
});

describe('licenseSecrets', () => {
    it('parses a single version', () => {
        setEnv('LICENSE_SECRETS', `1:${OK}`);
        expect(licenseSecrets()).toEqual([{ version: 1, secret: OK }]);
    });

    it('returns the newest version first whatever order is given', () => {
        const older = 'b'.repeat(32);
        setEnv('LICENSE_SECRETS', `1:${older}, 2:${OK}`);
        expect(licenseSecrets().map((entry) => entry.version)).toEqual([2, 1]);
    });

    it('keeps every version, so keys issued under an old one still validate', () => {
        const older = 'b'.repeat(32);
        setEnv('LICENSE_SECRETS', `1:${older},2:${OK}`);
        expect(licenseSecrets()).toHaveLength(2);
    });

    it('throws when an entry has no version', () => {
        setEnv('LICENSE_SECRETS', OK);
        expect(() => licenseSecrets()).toThrow(/entry 1 is not/);
    });

    it('throws when an entry has no secret', () => {
        // Long enough overall to clear the blanket length check, so this
        // exercises the per-entry parse rather than that check.
        setEnv('LICENSE_SECRETS', `1:,2:${'d'.repeat(20)}`);
        expect(() => licenseSecrets()).toThrow(/entry 1 is not/);
    });

    it('rejects a value too short to carry any version at all', () => {
        setEnv('LICENSE_SECRETS', '1:');
        expect(() => licenseSecrets()).toThrow(/shorter than 16 characters/);
    });

    it('throws on a repeated version', () => {
        setEnv('LICENSE_SECRETS', `1:${OK},1:${'c'.repeat(32)}`);
        expect(() => licenseSecrets()).toThrow(/repeats a version/);
    });

    it('does not put an unparseable entry in the error message', () => {
        setEnv(
            'LICENSE_SECRETS',
            'x:Super-Secret-Value-That-Must-Not-Be-Logged',
        );
        expect(messageFrom(() => licenseSecrets())).not.toContain(
            'Super-Secret',
        );
    });
});

describe('licenseGeneratorPassphraseHash', () => {
    it('reads the hash', () => {
        setEnv('LICENSE_GENERATOR_PASSPHRASE_HASH', 'f'.repeat(64));
        expect(licenseGeneratorPassphraseHash()).toBe('f'.repeat(64));
    });

    it('refuses the hash whose passphrase shipped alongside it', () => {
        setEnv('LICENSE_GENERATOR_PASSPHRASE_HASH', RETIRED_HASH);
        expect(() => licenseGeneratorPassphraseHash()).toThrow(/compromised/);
    });
});
