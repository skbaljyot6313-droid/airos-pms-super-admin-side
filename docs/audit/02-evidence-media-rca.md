# Completion-evidence image failure — RCA and release record

Date: 2026-11-04. Repository/branch: Super Admin, `development-branch`.

## Incident

The development Super Admin task lightbox displayed broken completion-evidence images and thumbnails. The affected frontend is https://airos-super-admin-dev.web.app. This report distinguishes inspected evidence, implemented changes and release verification; it does not claim an unrelated production environment has been updated.

## Confirmed primary root cause

Super Admin and Employee Backend shared database image references but did not share their effective object storage configuration:

| Component | Observed configuration before fix |
|---|---|
| Super Admin API | `airos-sa-api-dev-00004-s9z`, `STORAGE_BACKEND=local`, `UPLOAD_DIR=uploads`, no persistent volumes |
| Employee API | `airos-eb-api-dev-00004-cnd`, GCS bucket `final-airos-os-dev-employee-objects-94363806721` |
| Browser | Resolves `/api/v1/media/file/<key>` against the Super Admin API origin |
| Super Admin lookup | Searches its container filesystem rather than the Employee GCS bucket |

Read-only request-log investigation found 60 media-proxy 404s in the sampled recent logs. All keys matched the existing flat UUID `.jpg` whitelist, ruling out key-format rejection for those requests. Three distinct failed keys were checked through GCS metadata: all three objects existed in the Employee bucket with JPEG content types and nonzero sizes. No image contents or credentials were printed for that investigation.

Thus database metadata and browser URLs were present, but the selected storage reader pointed to the wrong backend. The three sampled Employee objects did not require recovery. These samples establish this failure mode, not completeness of all historical media.

## Contributing factors

1. Container-local uploads were permitted in production, with only a warning despite the filesystem being disposable.
2. `auto` selection could fall back silently to local disk; unsupported backend names also fell through to local.
3. No native GCS adapter existed in Super Admin, although the Employee deployment already used GCS.
4. Shared object-storage ownership/configuration was not verified as a release prerequisite.
5. The lightbox lacked an actionable image-failure state.
6. An older public static `/uploads/` URL contract needed compatibility with durable storage, not merely new upload URLs.
7. Backend build contexts and cloud source uploads needed separate exclusion rules; Docker exclusions alone do not govern Cloud Build source staging.

## Legacy local-file finding

Three additional historical `/uploads/` keys were last served successfully by revision `00003-2lj` on 2026-11-02. Before replacing the serving API, a user-approved preservation attempt checked those URLs and the shared bucket. The first unavailable source halted the create-only preservation procedure. The first checked file was unavailable from both the running API and the shared bucket; the procedure stopped at that point rather than claiming recovery of all three. An exact-name check found none of the three files in this checkout's `backend/uploads` directory. No existing object was overwritten and no successful preservation copy is claimed.

Those legacy files require original uploads/backups or a separately authorised recovery source. This is separate from the Employee evidence objects confirmed present in GCS. No blanket claim is made that all historical files can be recovered, or that the current release caused their disappearance.

## Implemented changes

### Shared storage

- Added `GCS_BUCKET` configuration and native `GCSStorage` using `google-cloud-storage==3.4.1`, released 2025-10-08, with Application Default Credentials/runtime identity rather than new downloaded service-account keys.
- GCS save returns the established `/api/v1/media/file/<key>` contract. It does not make objects public or issue persistent signed URLs.
- New uploads use `if_generation_match=0`, preventing silent overwrite on key collision.
- Reads retrieve metadata then download the matching object generation. Permission failures propagate as storage failures rather than being disguised as missing objects.
- Blocking SDK I/O runs off the async event loop. Read responses preserve image MIME type and byte length.
- Unknown storage modes fail explicitly. Production local/automatic-local storage fails validation rather than accepting disposable uploads.
- Production startup resolves the configured storage backend before database readiness checks. Missing GCS configuration fails clearly; actual object permissions are also checked by release smoke tests, not inferred solely from construction.
- Legacy flat `/uploads/{key}` requests now use the same validated/rate-limited storage reader, before the historical static mount. No database URL rewrite is necessary for preserved legacy keys.

### IAM and deployment

With explicit user approval, the existing Employee development bucket received two bucket-scoped bindings for `airos-sa-dev-runtime@final-airos-os.iam.gserviceaccount.com`:

- `roles/storage.objectViewer`
- `roles/storage.objectCreator`

No object-admin grant, public/allUsers binding, bucket recreation, object deletion or overwrite was performed. The adapter exposes a delete method for interface compatibility, but these approved roles intentionally do not authorise deletion. If future object deletion is required, review it separately rather than broadening IAM implicitly.

Added `backend/.gcloudignore` with a default-deny runtime-source allowlist, complementing `.dockerignore`. The first cloud upload was verified to contain 141 source/runtime files (1.1 MiB uncompressed), without environments, keys, local uploads, tests or Git data. The shared-revision rebuild additionally includes the mirrored migration file.

Cloud Run is explicitly launched with uvicorn arguments, overriding the image's migration-containing default CMD. No `alembic upgrade`, downgrade, stamp or other migration command was run against an existing database.

### UI and Hosting release guardrails

- Lightbox displays an actionable failure message and retry button rather than only a broken main image.
- Other images remain navigable after a failure; retry does not rewrite stored URLs or delete evidence.
- Repaired the existing development-only Firebase REST deployer: valid `sites/<id>` resource paths, deterministic gzip hashes, one cached short-lived deployment token, finalised versions released using the `versionName` query parameter, empty-build prevention and upload-origin/hash validation.
- Hosting root/deep-link HTML is configured `no-cache`; hashed assets remain immutable. This prevents an old shell from hiding a newly released fix.
- No actual production site/API is hardcoded into this development deployer.

## Secondary rollout blocker: shared migration graph

The corrected candidate reached storage/database startup, then the schema guard rejected it because the shared database reported `w3b7d9f1a4c6`, while this checkout only knew `v9f2b5c8d1e4`. This is a missing shared revision, not proof the database is behind.

With separate explicit user approval, the Employee-owned `w3b7d9f1a4c6_notification_push_delivery.py` was read from the adjacent Employee repository and mirrored into Super Admin, unchanged. Both files have Git blob hash `117d889a8f69f0e12fa74c3c0e0e6691358a0e15`; its parent is `v9f2b5c8d1e4`. This confirms equality with the inspected local Employee source, not independently proven container-source provenance.

The revision adds notification push-outbox fields; the Super Admin ORM may omit those extra columns while database defaults cover new inserts. Existing shared-chain instructions require preserving/mirroring Employee revisions rather than stamping over them. The schema guard remains enabled and unchanged in meaning. Only the local graph was extended; the revision's SQL, historical-row update and downgrade were not executed by this release.

Offline `alembic heads` now resolves one head, `w3b7d9f1a4c6`. A regression test checks that exact shared head and parent without connecting to a database.

## Verification

- Initial storage regression run reproduced missing GCS support/configuration; an early failure printed a settings representation containing a local storage credential. The user was immediately informed and asked to rotate the affected credential. No credential is reproduced here.
- Settings representations now exclude database credentials, JWT/storage/API keys and credential-bearing Redis URLs. A synthetic regression checks both `repr` and `str`.
- Backend suite before shared-revision/deployer additions: 248 passed.
- Frontend: 68 passed across nine test files, including three new image-error/retry/navigation tests. Existing `act(...)` and localStorage/environment warnings remain; no clean-warning claim.
- TypeScript `npm run lint`: passed.
- Frontend `npm run build`: passed using the development API URL.
- Hosting-deployer tests: five passed, including deterministic hashes, missing-build rejection, release ordering/query and untrusted upload-target rejection.
- Shared graph: offline head command passed; source and mirrored revision hashes match.
- Tests use inert loopback database settings, fake keys, synthetic data and mocked storage. No load/account-seeding harness was run.
- Live object metadata checks and post-release HTTP smoke checks are tracked separately from synthetic tests.

## Release events

1. Cloud Build `bc05f3b7-8e2f-4b41-ab60-ab642922cb77` succeeded for the initial GCS implementation. Image digest: `sha256:883124c4d2dbc7abe3abc2c2b444f7516d4e5baa6acbf1c8a145496010971f50`.
2. Candidate `00005-9pg` failed because shell argument parsing combined uvicorn arguments. It did not become the serving revision. The subsequent command uses explicit subprocess arguments.
3. Candidate `00006-z59` had correct command/environment, resolved `GCSStorage`, and failed the shared-schema guard described above. No timeout increase, migration execution or guard bypass was used.
4. Frontend released: `sites/airos-super-admin-dev/releases/1793797183306000`, Hosting version `4654bb3abcb3d832`.
5. The shared-head backend rebuild and live media smoke results are recorded below when available. Until then, backend restoration is pending and the frontend release alone must not be called a complete fix.

## Remaining risks and production gate

- The existing media-by-key endpoint remains anonymous/public-cacheable by design. This functional incident fix does **not** resolve the broader tenant-scoped evidence-access finding. The origin bucket was not made public; public proxy authorisation needs a separately reviewed shared-client change.
- Some legacy local files are unavailable and need a recovery source.
- A real authenticated browser upload/end-to-end task completion has not been claimed verified solely from mocked tests or read-only smoke tests.
- Scheduler singleton ownership, refresh rotation and the broader engineering audit remain separate pending tasks.
- The user requested actual production too but has not provided its frontend/API/project target. No unrelated production environment is approved by inference from a development resource's `APP_ENV=production` value. Production release remains blocked pending exact target confirmation.
- No branch switch, commit, push, destructive operation, Employee code modification, secret value publication in this report or repository cleanup was performed. Existing uncommitted changes were preserved; deployed development builds use the current working tree, including pre-existing application edits.
