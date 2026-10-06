// Jenkins Job DSL — the two OpenRx jobs.
//
// Apply once with the "Job DSL" plugin:
//   1. New Item -> Freestyle project named e.g. "openrx-seed".
//   2. Build step -> "Process Job DSLs" -> "Look on Filesystem" ->
//      "DSL Scripts" = jenkins/jobs.groovy (this repo is the seed's SCM).
//   3. Build it once. It creates/updates "OpenRx-CI" and "OpenRx-Nightly".
// Re-running the seed keeps both jobs in sync with this file.
//
// Both jobs run the SAME pipeline (this repo's Jenkinsfile); they differ only
// in their schedule and their RUN_UI_TESTS parameter default. The Jenkinsfile
// deliberately declares neither, so each job owns them. Both jobs also keep
// DEPLOY_BACKEND off — enable it per run on the build you intend to release.
//
// The repository is public, so no credentials are set. If you make it private,
// add `credentials('<id>')` inside the `remote { }` block below (an SSH key or
// username/password credential with read access).

job('OpenRx-CI') {
    description('OpenRx backend CI — every 35 minutes. Backend unit + API tests, ' +
                'then the reliability report. UI tests OFF.')
    parameters {
        booleanParam('RUN_UI_TESTS', false,
            'Build the SPA and run the Vitest + Playwright UI suites.')
        booleanParam('DEPLOY_BACKEND', false,
            'Deploy the built backend to production. Off by default — enable per run.')
        booleanParam('TRIGGER_SMOKE', false,
            'On success, trigger the OpenRx-Smoke production health check.')
    }
    triggers {
        cron('H/35 * * * *')
    }
    definition {
        cpsScm {
            scm {
                git {
                    remote {
                        url('https://github.com/harrington40/openrx-backend.git')
                    }
                    branch('*/main')
                }
            }
            scriptPath('Jenkinsfile')
            lightweight(true)
        }
    }
}

job('OpenRx-Nightly') {
    description('OpenRx nightly — once per night. Full run including the SPA build, ' +
                'the Vitest unit tests and the Playwright UI sweep.')
    parameters {
        booleanParam('RUN_UI_TESTS', true,
            'Build the SPA and run the Vitest + Playwright UI suites.')
        booleanParam('DEPLOY_BACKEND', false,
            'Deploy the built backend to production. Off by default — enable per run.')
        booleanParam('TRIGGER_SMOKE', true,
            'On success, trigger the OpenRx-Smoke production health check.')
    }
    triggers {
        // Once per night, at a hashed minute inside the 0-4 AM window.
        cron('H H(0-4) * * *')
    }
    definition {
        cpsScm {
            scm {
                git {
                    remote {
                        url('https://github.com/harrington40/openrx-backend.git')
                    }
                    branch('*/main')
                }
            }
            scriptPath('Jenkinsfile')
            lightweight(true)
        }
    }
}

// Manual, versioned customer release. No cron — start it by hand with a semver.
job('OpenRx-Release') {
    description('OpenRx customer release — manual. Validates a semver version, runs the ' +
                'test gate, stamps + builds, packages artifacts, tags v<version>, and ' +
                'optionally deploys. Needs the `openrx-github` credential to push.')
    parameters {
        stringParam('RELEASE_VERSION', '', 'Version to release, semver, e.g. 1.4.0 (required).')
        booleanParam('RUN_TESTS', true, 'Run the backend unit tests + build as a release gate.')
        booleanParam('PUSH_TAG', true, 'Commit the version bump and push the v<version> git tag.')
        booleanParam('GITHUB_RELEASE', true, 'Publish a GitHub Release for the tag using RELEASE_NOTES-<version>.md.')
        booleanParam('BUILD_FRONTEND', true, 'Also build and package the SPA (interface/new).')
        booleanParam('DEPLOY', false, 'Deploy the released backend after a successful build.')
        booleanParam('DRY_RUN', false, 'Do everything except commit/tag/push and deploy.')
        stringParam('SMOKE_BASE_URL', 'https://openrx.transtechologies.com', 'Origin to smoke-test after deploy (SPA root + /api).')
        booleanParam('SMOKE_LOGIN', true, 'Use the openrx-smoke credential to exercise login + authenticated routes.')
        booleanParam('SMOKE_ROLLBACK', false, 'If the post-deploy smoke test fails, roll the backend back one release.')
    }
    definition {
        cpsScm {
            scm {
                git {
                    remote {
                        url('https://github.com/harrington40/openrx-backend.git')
                    }
                    branch('*/main')
                }
            }
            scriptPath('Jenkinsfile.release')
            lightweight(true)
        }
    }
}

// Nightly production health check — no release, no deploy.
job('OpenRx-Smoke') {
    description('OpenRx production smoke — nightly. Read-only health check of the running ' +
                'deployment (/config, SPA, login, key routes). Does not tag, release or deploy.')
    parameters {
        stringParam('SMOKE_BASE_URL', 'https://openrx.transtechologies.com', 'Origin to smoke-test (SPA root + /api).')
        booleanParam('SMOKE_LOGIN', true, 'Use the openrx-smoke credential to exercise login + authenticated routes.')
    }
    triggers {
        // Nightly, after the OpenRx-Nightly window (which runs H H(0-4)).
        cron('H H(5-7) * * *')
    }
    definition {
        cpsScm {
            scm {
                git {
                    remote {
                        url('https://github.com/harrington40/openrx-backend.git')
                    }
                    branch('*/main')
                }
            }
            scriptPath('Jenkinsfile.smoke')
            lightweight(true)
        }
    }
}
