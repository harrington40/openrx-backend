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
// deliberately declares neither, so each job owns them.
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
