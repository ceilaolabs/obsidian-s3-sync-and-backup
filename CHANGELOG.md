# Changelog

## [4.0.0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/3.4.0...4.0.0) (2026-05-04)


### ⚠ BREAKING CHANGES

* **storage:** Saved settings with provider: 'minio' are no longer accepted. The plugin has not been published to the community plugin store yet, so no end users are affected.

### Features

* **storage:** replace MinIO with RustFS as the dedicated provider option ([e6b654d](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/e6b654d3851f0b51954b3c14754fc17323e1f6ff))


### Bug Fixes

* **storage:** reject unsupported provider values at runtime ([56ff406](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/56ff4068bf33aa4d303c164cc636107d8724ae12))


### Code Refactoring

* **settings:** hide force-path-style toggle for fixed-mode providers ([5d64233](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5d64233b1b0304824d7273e08269c19532b0dedd))

## [3.4.0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/3.3.0...3.4.0) (2026-04-19)


### Features

* add Codecov coverage workflow on push to main ([7312c7e](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/7312c7e28d6afa315c7f1e79a411508d910f3893))


### Bug Fixes

* security fixes suggested by codeql ([f5ed3ba](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/f5ed3bac615c6166f606d58934e34a1237b121a0))
* **security:** resolve CodeQL high-severity alerts ([9796abf](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/9796abf73bb0ed3615935bd36d90b49eee1ed717))


### Documentation

* update README.md to add/reorder badges ([f8ac6ae](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/f8ac6ae62ff67f0a9e3042e53b1c4d0adcec9fe4))
* update README.md to add/reorder badges ([5e070ee](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5e070ee1586c97884e4583eb558bea0941ce57d8))

## [3.3.0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/3.2.0...3.3.0) (2026-04-17)


### Features

* add skills and claude.md ([234f412](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/234f4128dc344395bc459c2b9940e4c5cb0c2492))


### Bug Fixes

* **settings:** enforce sentence case for UI text and remove unnecessary async ([e1cab13](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/e1cab1338f603fd25df873d4e57b4bbdfd3e36ce))
* suggestions by ObsidianReviewBot and adding agent skills ([0b8df34](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/0b8df34071818a5517e57dbe37f2fc79fb23fd7c))


### Documentation

* update AGENTS.md and add OBSIDIAN-PLUGIN-GUIDE.md ([e426d16](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/e426d1634ecd8a987e6ce7edbb7f4380f69cd5ae))

## [3.2.0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/3.1.2...3.2.0) (2026-04-17)


### Features

* **backup:** add backup list modal with per-backup ZIP download ([ff7cb94](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/ff7cb94326a9bb825e8e263aa46abde1822b7b8a))


### Bug Fixes

* backup issues ([4cd89fe](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/4cd89fe5f2f91191eefb055388ca1793f31eaed3))
* **backup:** defer startup backup to onLayoutReady to prevent empty snapshots ([1eaf48e](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/1eaf48e78901834dc33f386e198ab13d49bc850d))


### Tests

* **backup:** add unit and E2E tests for backup list modal ([ef4d301](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/ef4d301a9c1ce339e965b936139f28102ecf68e6))

## [3.1.2](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/3.1.1...3.1.2) (2026-04-17)


### Bug Fixes

* update description for consistency ([438b926](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/438b926d402098479dea07703e12c0675c9306e2))
* update description for consistency across README, manifest, and package.json ([017cb48](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/017cb48e29c8ab8e88560faf3ff7c3ab02404e5d))


### Miscellaneous

* merge branch 'main' into dev ([b38553b](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/b38553bd380660f0d44739dc21ba9bab6c9d08c6))

## [3.1.1](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/3.1.0...3.1.1) (2026-04-16)


### Bug Fixes

* correct author name formatting in LICENSE, README, manifest, package.json ([e2f3c1a](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/e2f3c1adae7c53c2a6df75450d2b503fdad57c02))
* updates for the plugin submission ([18683ed](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/18683edc0c8c777b110402a105e3842b72fce551))


### Miscellaneous

* address Obsidian community plugin submission review findings ([e9463e8](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/e9463e8a5e715f1985c3d5b83d008b981404cadf))
* update branch ([9a458dc](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/9a458dcb732d3a3a93e637a2ac0eb95e0c17c708))


### Tests

* **e2e:** add 27 pipeline E2E tests for sync, encryption, backup, and multi-device ([ea17fe9](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/ea17fe9fdbb543a1a4f6aa4d8855206e265bb357))
* **e2e:** add pipeline E2E test infrastructure with in-memory vault harness ([00bc6f6](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/00bc6f63d68c9fca3c2150d6743fedda83619afe))

## [3.1.0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/3.0.0...3.1.0) (2026-04-16)


### Features

* updates to encryption and documentation ([f1d7024](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/f1d702450d3485d4e3774bff5fc145a77cb49078))

## [3.0.0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/2.0.0...3.0.0) (2026-04-16)


### ⚠ BREAKING CHANGES

* **crypto:** rewrite EncryptionCoordinator with local-source migration and lease locking

### Features

* **crypto:** add PayloadFormat type and wire payload-format metadata through S3 layer ([4db8ae2](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/4db8ae293a80f9750934204a42203e39434f4b48))
* **crypto:** refactor VaultMarker to v3 with transitioning state and migration fields ([0a8e769](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/0a8e769f6c380c5c9955bdbcc0ab2336e9d2408d))
* **crypto:** rewrite EncryptionCoordinator with local-source migration and lease locking ([8fb22db](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/8fb22db954c2e380e867327136908f3ddc75cafa))
* **settings:** wire EncryptionCoordinatorCallbacks through settings and main ([83173ad](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/83173adc1bd6c28b3683287b0fd5b5b0c0fa15c9))
* **sync:** add SyncLease for remote advisory lock during migrations ([a70de2e](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/a70de2e483ad019cea8409ce3c500aee4213a4d5))
* **sync:** make SyncPayloadCodec format-aware with metadata-driven decode ([7034759](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/7034759169a44d3273320b595843de39c23c0c4f))
* **sync:** wire payload format through planner and executor ([972b13d](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/972b13dfc7bddadf8bd31ede15de410830443814))


### Bug Fixes

* **crypto:** handle plaintext files gracefully during encryption disable migration ([89e272b](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/89e272b64a25b88699ccc94f2a2369a830194c34))
* encryption issues ([ffe3935](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/ffe3935328ee27e9a8311230507b5f5ccebe1ead))
* encryption wiring and more tests ([7dfeaa7](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/7dfeaa78fa5e01c77ed9393bafff96d835c832ed))
* **settings:** use transient UI flag for encryption setup and implement reset button ([02a7ac7](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/02a7ac7f63d914f3bbf7d0f73ce3ddbdda7877bf))
* **sync:** propagate exclude pattern changes to ChangeTracker immediately ([9d38c8f](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/9d38c8f32008f0246cfb92f0c16225cf1f299f39))


### Documentation

* add debug logging section to CONTRIBUTING.md ([bdfbbc3](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/bdfbbc3f6d48d238724e209f32fc06adbb135df9))


### Code Refactoring

* **backup:** use encryption key presence as sole encryption guard ([5c6b16c](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5c6b16c367850f9fec554ec6fb795cb80f5d1b69))


### Tests

* **backup:** add unit tests for BackupDownloader ([7f725f0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/7f725f077aa428444df02925e2ba141c781e5d01))
* **crypto:** add multi-device encryption scenario tests ([b0c2358](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/b0c2358e9bea6d0bcbe87431beadce4e7edffc7f))
* **crypto:** add unit tests for EncryptionCoordinator ([c12d7ff](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/c12d7ff20eb9a89ec2430b81cac094b61351e56d))
* **storage:** expand ObsidianHttpHandler coverage ([9c76a1e](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/9c76a1e5fff00bbf8d89e149e17bad45d33e9aef))
* **sync:** add missing decision table state combination tests ([1063770](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/106377089be2c9d50f672a1ca02a5611283705ea))
* **sync:** add unit tests for SyncEngine orchestrator ([7f30bfd](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/7f30bfd02c9ca7c2c2188be4e43a8a77c3375112))
* **sync:** add unit tests for SyncScheduler lifecycle and guards ([4d0571d](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/4d0571d5a2a13a8b2025a2851780bb56a28486ee))

## [2.0.0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/1.1.3...2.0.0) (2026-04-16)


### ⚠ BREAKING CHANGES

* **sync:** Sync state schema changed from v1 manifest to v2 per-file baselines. No migration needed (plugin unpublished).

### Features

* add backup downloading and zip export functionality ([61c8776](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/61c8776cf8dff6b1e4015a48dcca47478d959723))
* enhance S3 sync functionality with improved file tracking and metadata retrieval ([fbf8e92](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/fbf8e92632b7610754eec65a4009cdf682bc72f7))
* implement backup scheduling and ETag tracking for S3 sync ([eb55251](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/eb5525150701a654e77e5eab9f65bde3d9373785))
* implement rebasePendingOutcomes logic and add unit tests for SyncEngine ([3f6be85](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/3f6be859b70222f6cf49232df32374e3a09f94fe))
* sync engine v2 ([6352917](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/6352917cccc0a5873154ad281d161e1b36891328))
* **sync:** rebuild sync engine with v2 three-way reconciliation architecture ([5ed5e4d](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5ed5e4de2e3905651f7a420ea60f314bf772771a))


### Bug Fixes

* some fixes for sync issues ([58bfc0f](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/58bfc0f996a908f9f67324342e478d7a3b7b27d7))
* **sync:** resolve 13 bugs in sync engine, change tracker, journal, and S3 provider ([afa072b](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/afa072b0e17ba7f67a68ce3464db4f774dfb494d))
* unify deviceId to vault-scoped storage preventing cross-vault contamination ([5860fab](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5860fabfd9abf3156b76676ae3d2ce31975e67fa))
* unify deviceId to vault-scoped storage preventing cross-vault contamination ([340ee74](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/340ee74b528ab95926190ab6e08f32ee22350cb0))
* update release-please config to show hidden sections ([c600726](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/c600726ff4cd63994502c0112908f72a1a39f927))
* update release-please config to show hidden sections for chore, test, and build ([1c1033e](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/1c1033e883ac628bea81a62919271b869b14c834))


### Documentation

* add comprehensive JSDoc to plugin core modules ([54239e3](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/54239e33145d787cc8a0060603bce0f507694407))
* **backup:** add comprehensive JSDoc to all backup modules ([6eb49ea](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/6eb49eaeb289edf2fda546c537f46918cc728b35))
* rewrite AGENTS.md with v2 architecture and development workflow sections ([12ab81b](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/12ab81b678767141ef0ecd29907ea6f485f20884))
* **storage:** add comprehensive JSDoc to all S3 storage modules ([18f3f79](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/18f3f79dcdc754dbae0c48e7fbe490cc42ac268c))
* **sync:** add comprehensive JSDoc to all sync engine modules ([c70aeb9](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/c70aeb9e8367d8d4d2a8db446a816092cf9418d6))
* update README and rewrite CONTRIBUTING for v2 sync engine ([5718d8f](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5718d8f9fdcac50fdfaff0e91417752e21d9bf04))
* **utils:** add comprehensive JSDoc to path and vault file utilities ([0985b85](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/0985b858208a2c990bc48adb8ae45aad7a4ffa2b))


### Miscellaneous

* **deps-dev:** bump flatted from 3.3.3 to 3.4.2 ([7f08511](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/7f085116007ac0d0bb452f1538e2e62b7117b205))
* **deps-dev:** bump flatted from 3.3.3 to 3.4.2 ([da68d62](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/da68d62adfd526cb93e752751852745dc120f83d))
* **deps-dev:** bump handlebars from 4.7.8 to 4.7.9 ([fd1e88a](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/fd1e88a3c1be15e9c0507426fff72ca7dfb4b8bb))
* **deps-dev:** bump handlebars from 4.7.8 to 4.7.9 ([8699b68](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/8699b68c5daafd8464e355c07f5bfbf700ceb9dd))
* **deps-dev:** bump lodash from 4.17.21 to 4.18.1 ([5d6d1b6](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5d6d1b668e9e21a448fd0b5cf5322f5511d5787c))
* **deps-dev:** bump lodash from 4.17.21 to 4.18.1 ([f8bfc30](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/f8bfc30c6d6b0418e145f6df5368a0cad1f574af))
* **deps-dev:** bump picomatch from 2.3.1 to 2.3.2 ([773f10e](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/773f10e4cd1a656384333608fe1a90e691cb8865))
* **deps-dev:** bump picomatch from 2.3.1 to 2.3.2 ([de969ca](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/de969ca943a2b916c60bdca93b219c693d726458))
* **deps:** bump the npm_and_yarn group across 1 directory with 3 updates ([ffa1f14](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/ffa1f14335cb216f6d4cf87ca9e94669ec53ae5c))
* **deps:** bump the npm_and_yarn group across 1 directory with 3 updates ([7de9d45](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/7de9d450d4b9c5f994c898c37f53e58185d5f409))
* remove BLUEPRINT.md ([707fd9c](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/707fd9c0dc69c6693aa4de9fba248f5ff13d9ba1))


### Tests

* add comprehensive tests for bug fixes and coverage (375 tests, 87% coverage) ([0a55af4](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/0a55af4760131999ab213f914ebef22695f8c489))
* **sync:** add unit tests for v2 decision table, journal, and change tracker ([2f4ed5a](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/2f4ed5a4b8aed082e531024c92059f8ed68b0869))
* **sync:** add unit tests for v2 sync planner and executor ([e4ab606](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/e4ab6068f9f287a4f1c2c8cbe3912d9c0c5c5216))
* **sync:** replace v1 test files with v2 infrastructure module tests ([f8f80f9](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/f8f80f917e780565922d5037ef80b9a461ca15cc))

## [1.1.3](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/1.1.2...1.1.3) (2025-12-29)


### Documentation

* update project blueprint document ([d5a69c3](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/d5a69c30d335373341f89e4f4e2c9081878ea2ec))


### Code Refactoring

* shorten plugin id and improve docs ([3a74e37](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/3a74e372baef46eeddcca50fa312f811155b86d9))
* shorten plugin id and overhaul agent directives, documentation ([675f21c](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/675f21ca72c6476c1e800d9063c301851a7f293a))

## [1.1.2](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/1.1.1...1.1.2) (2025-12-28)


### Bug Fixes

* **ci:** release title format ([0ca4d62](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/0ca4d62171215ed30970ec35dc848389088a6b10))
* **ci:** release title format ([064e683](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/064e683fdcfb2d7102b672ab0b6e91edbdf78409))

## [1.1.1](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/v1.1.0...1.1.1) (2025-12-28)


### Bug Fixes

* ci/cd corrections for version ([f119ca9](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/f119ca9caedadb0505fcfd7824826b0629b3869d))
* **release:** use release-please config file and add version verification ([b5103ca](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/b5103caf8fdd683493a9f567b491d7e4f545104e))


### Documentation

* agents and readme ([1b5df3c](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/1b5df3c79e79348541c5f683cb5c9aac006701d6))

## [1.1.0](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/v1.0.1...v1.1.0) (2025-12-28)


### Features

* add S3 integration tests ([6b21a49](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/6b21a496827e56e1550b7e13df79e8a2035e68d5))
* add S3 integration tests ([ec3a688](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/ec3a688cd01aaab74da5ff06c362c1b73e41ed5b))
* ci/cd, conventional commits, documentation ([8ed5c17](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/8ed5c17f283caf0a3b51f74edebb348e43cb9881))
* implement backup functionality with snapshot creation, retention management, and status updates. ([22d822b](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/22d822b4fb5e90a1ecd93c9fbb797fb1d0dfa970))
* implement comprehensive s3 sync and backup functionality with a new settings ui. ([5fb20ab](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5fb20ab71bb3fdbdff21d150733878d408b28326))
* update project version and author, add linting instructions, and reorder package dependencies. ([0617510](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/0617510aca4005466f43ce7d52629c89348e5fc0))


### Bug Fixes

* add versioning script and refactor actions ([78349ff](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/78349ff89fd1c1d051d533f88c75dc362311997c))
* add versioning script and refactor actions ([67ecae7](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/67ecae7972b50318243aea7c6e4a03703e14b2d3))
* ci and docs ([878b8e3](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/878b8e334be43d83f23aad0222d885c050c39aab))
* correct author name spelling ([2ac78d4](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/2ac78d4a3e254b67e3ba8a0f95a6410ffef633d1))

## [1.0.1](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/compare/v1.0.0...v1.0.1) (2025-12-27)


### Bug Fixes

* add versioning script and refactor actions ([78349ff](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/78349ff89fd1c1d051d533f88c75dc362311997c))
* add versioning script and refactor actions ([67ecae7](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/67ecae7972b50318243aea7c6e4a03703e14b2d3))
* ci and docs ([878b8e3](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/878b8e334be43d83f23aad0222d885c050c39aab))

## 1.0.0 (2025-12-27)


### Features

* ci/cd, conventional commits, documentation ([8ed5c17](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/8ed5c17f283caf0a3b51f74edebb348e43cb9881))
* implement backup functionality with snapshot creation, retention management, and status updates. ([22d822b](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/22d822b4fb5e90a1ecd93c9fbb797fb1d0dfa970))
* implement comprehensive s3 sync and backup functionality with a new settings ui. ([5fb20ab](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/5fb20ab71bb3fdbdff21d150733878d408b28326))
* update project version and author, add linting instructions, and reorder package dependencies. ([0617510](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/0617510aca4005466f43ce7d52629c89348e5fc0))


### Bug Fixes

* correct author name spelling ([2ac78d4](https://github.com/ceilaolabs/obsidian-s3-sync-and-backup/commit/2ac78d4a3e254b67e3ba8a0f95a6410ffef633d1))
