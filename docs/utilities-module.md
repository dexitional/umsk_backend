# Utilities Module

The AIS navigation opens `/ais/utilities`. Both desktop and compact menus expose the module to staff with `utilities::admin`, `student::admin` or `student::registry`. The API enforces the same AIS roles and staff account requirement.

## Models

| Submodule | Prisma model | Editable fields |
| --- | --- | --- |
| Religion | `religion` | title, status |
| Region | `region` | tag, title, status |
| Change of program | `activityProgchange` (`ais_activity_progchange`) | destination program, destination semester, academic session, reason (drafts) |
| Disability | `disability` | title, status |
| Title | `title` | tag, label, status |
| Country | `country` | code, shortName, longName, nationality, status |
| Marital status | `marital` | title, status |
| Relation | `relation` | title, status |

Lookup lists support search, active/inactive filters and pages of 50. Name/tag duplicates are rejected, including inactive entries. Reactivate existing entries instead of creating duplicates. Deletion is allowed only when no model relationships reference the record. Deactivation preserves existing references; existing AIS selection endpoints already return only active values.

All mutations are audited to `log` in the same transaction. Updates and deletions require the `updatedAt` value returned when the record was loaded; a stale request returns 409. Server-selected model and field allowlists prevent editing arbitrary Prisma models or nested relations.

## Change of program

1. Find the student and create a draft for the current active academic session, selecting the destination program, semester and reason.
2. Edit or delete the draft as necessary. Saving a draft does not change the student. A student can have only one pending draft.
3. Review and approve. Select an active destination major if the destination program requires one. Approval atomically updates `student.programId`, `student.majorId`, and `student.semesterNum`, then records the approver and approval time.

The destination semester must fit the program duration and match the session's first/second semester. Deferred, completed and graduated students are not eligible. The student's current program/index and the program/major/semester reviewed by the approver are checked again during approval.

Approved records are retained as history and cannot be edited or deleted. Existing legacy approved records are displayed without being applied again. Legacy drafts requesting a different index number cannot be approved through this module.

Index numbers, assessment records, grading scheme snapshots, existing bills, registration history, hall placements and STS placements are preserved. This workflow does not decide credit equivalencies or automatically reassign placements. Any such academic or placement changes remain in their respective modules.

## Setup

Run `prisma/sql/2026-10-22_utilities_module.sql` against the target database. It idempotently registers the Utilities Module and its administrator role without changing existing records or granting new users access. All eight Prisma models already exist, so no schema or generated-client update is required. Assign `utilities::admin` through User Roles for staff who do not already have the accepted student-management roles; sign in again after assigning roles.

Backend endpoints are mounted at `/api/ais/utilities`: `GET /options`, `GET /students?search=...`, CRUD at `/:module` and `/:module/:id`, and `POST /change-of-program/:id/approve`. Deletions send `{ updatedAt }`; approval sends `{ updatedAt, studentSnapshot: { programId, majorId, semesterNum, indexno }, majorId }`.

## Verification

- `node --test scripts/test-utilities.cjs` — allowlists, field validation, concurrency versions, permissions and server-rendered forms/navigation.
- `UTILITIES_TEST_DATABASE=1 node scripts/test-utilities-database.cjs` — all seven lookup CRUD flows, references, migration idempotence, program-change drafts/approval, and concurrent duplicate writes/approvals. Requires Node 24 and a local database; creates and drops an isolated test database without changing application data.
- Compile the backend and build the frontend before deployment.
