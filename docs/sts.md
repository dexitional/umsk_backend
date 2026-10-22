# Supported Teaching in Schools

## Deployment

1. Back up the target database using the normal deployment procedure.
2. Apply `prisma/sql/2026-10-21_sts_module.sql` **once**, to the same MySQL database used by the application. This creates four STS tables, their foreign keys, and the AIS `sts::admin` / `sts::mentor` roles. It does not assign students or change existing academic data. Existing `ais_student.id` and `ais_session.id` columns must use the same utf8mb4_unicode_ci collation as the new foreign-key columns.
3. Run `npx prisma generate` and `npm run build` in the backend, then deploy the backend and the frontend build together. The schema migration must precede use of the new pages.
4. In Access Control grant `sts::admin` to STS coordinators and `sts::mentor` to linked staff mentor accounts. Existing staff with `student::admin` or `student::registry` can also coordinate STS. Users should sign in again after roles change because roles are carried in the token.

No database migration is executed by starting the app. The checked-in SQL is additive; applying it twice is not supported.

## Workflow

Open **Academics → Supported Teaching in Schools** (`/ais/sts`). Add schools with unique codes, then add their mentors. A mentor can supervise multiple students; every placement has one responsible mentor belonging to its school. Contact details are optional. An optional staff account tag links an existing active staff login to the mentor; this does not create credentials or grant access by itself. The mentor must also hold `sts::mentor`. Without a linked login, coordinators maintain the placement on the mentor's behalf.

After normal student progression, set the current default semester in Academic Calendar. Search for an individual student and assign a school and mentor. Each semester starts with no carried-forward placements: coordinators explicitly create the new semester's placement, including when the school is unchanged. Years 1–3 are eligible each semester. Year 4 is excluded when the student's semester equals their programme's semesterTotal (for example 8 of 8). Years above 4, deferred/completed/graduated students, missing programme duration, invalid student semesters and semester-parity mismatches are rejected. Eligibility uses the student's current academic record, so historical and future sessions cannot receive new placements.

One placement is allowed per student and academic session. **Reassign** changes the school/mentor in the current semester, requires a reason, and retains the earlier details in **View history**. Cancellation also requires a reason and preserves history. Cancelled placements can be restored only through Reassign, subject to current eligibility. Assignment and event writes are transactional. Version checks prevent concurrent editors silently overwriting each other.

**Update progress** records notes and active/completed status. Linked mentors can view, report on and update only their own students; they cannot create, cancel or reassign placements. Notes are visible to the student. Coordinators can update progress for any placement. School/mentor deletion is blocked when referenced; deactivate records instead. A mentor with placement history cannot be moved to another school; create a new mentor record there. Existing placements remain visible when a school or mentor is deactivated, but an inactive mentor cannot access them through the mentor login.

Use semester, school, mentor, programme, year, status and student filters for the report. CSV exports include all matching rows (up to 10,000, independent of the on-screen 50-row pagination), with spreadsheet formula injection escaping. Counts reflect the current filters. Names, programme and year are captured at placement time and do not change when the student progresses or records are renamed. Reports show the latest placement state; View history shows every change, actor, timestamp and reason.

Students can see their own current and previous placements, mentor contacts and notes at `/aisp/sts`. The existing STS appraisal/evaluation form remains separate.

## Verification

`node --test scripts/test-sts.cjs` uses isolated in-memory fixtures, not a configured database. For the optional local MySQL constraint check, run `STS_TEST_DATABASE=1 node scripts/test-sts-database.cjs`; its synthetic records are always rolled back. Also run `npx tsc --noEmit`, `npx prisma validate` and the frontend production build. A deployment smoke test should create a school and mentor, place a student in semester 1, reassign them, verify mentor/student access and report/history, and confirm semester 8 of 8 is rejected.
