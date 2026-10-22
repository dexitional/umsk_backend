# Curriculum grading schemes

Grading scheme selection lives on **Curriculum → Create/Edit**. Each `ais_structure` row has a nullable `scheme_id` foreign key, exposed by Prisma and the API as `schemeId`. New and edited curriculum records require a valid scheme. The programme form no longer loads or submits grading schemes, and programme writes ignore legacy scheme fields and nested scheme input.

Apply `prisma/sql/2026-10-21_curriculum_grading_scheme.sql` once before deploying the updated application, then run `npx prisma generate`, build the backend, and build the frontend. The SQL adds the column/index/foreign key and copies each curriculum's programme scheme into it. The legacy programme column is retained for rollback compatibility and is no longer used to choose grading rules. The local database migration was applied and verified against all 148 curriculum records, with no missing or mismatched schemes. Apply this SQL separately to any deployment database; do not replay it on the migrated local database.

New registration selects the active curriculum by programme, student semester, course and applicable major. A major-specific entry overrides the common course entry. Conflicting duplicate schemes or missing curriculum schemes block registration with a Registry-facing error; they never fall back to the programme. Registration saves the resolved scheme on the assessment, ignoring client-supplied scheme and credit values. Administrative additions also resolve the curriculum for the selected student semester.

Assessment and resit records keep their saved schemes, including when a curriculum's scheme is later edited. Saved registration slips remain accessible without fetching the current curriculum. Existing grades, CGPAs and result snapshots are not rewritten by the migration.

Graduation imports resolve award classification metadata through applicable curriculum schemes. If the curriculum has missing or conflicting classification bands, the import records a descriptive graduation log error for review instead of choosing an arbitrary course's classification scheme. Different course grading bands with the same award classification bands are supported.

Verification:

- `node --test scripts/test-curriculum-scheme.cjs scripts/test-system-updates.cjs scripts/test-sts.cjs`
- `CURRICULUM_TEST_DATABASE=1 node scripts/test-curriculum-scheme-database.cjs` (local only; synthetic records are rolled back)
- `npx prisma validate`, backend TypeScript build, and frontend Vite build.
