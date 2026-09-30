/**
 * Throwaway signing secrets for test runs.
 *
 * The application has no fallback for these - by design, so that a deployment
 * cannot silently use a published key - which means the test runners need values
 * before any module is imported. These constants exist only so unit and e2e
 * tests can boot; they are never used outside a test process, and anything that
 * really needs to sign something must configure the real variables.
 *
 * An existing value always wins, so CI can export its own.
 */
const TEST_SECRETS: Record<string, string> = {
    JWT_SECRET: 'openrx-test-jwt-secret-not-for-any-real-deployment',
    LICENSE_SECRETS: '1:openrx-test-license-secret-not-for-real-use',
    LICENSE_GENERATOR_PASSPHRASE_HASH:
        '5601e6dfd8ee13137d54ea1ca5df6bb9d2fa66c785400313feefda397d5fdca8',
};

for (const [name, value] of Object.entries(TEST_SECRETS)) {
    if (!process.env[name]) {
        process.env[name] = value;
    }
}
