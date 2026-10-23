# Hall management

Open **Academics → Hall Module** (`/ais/halls`). Access is granted to `hall::admin`, `student::admin` and `student::registry`. The migration registers `hall::admin` in AIS Access Control without granting roles automatically.

## Records and workflow

- Add halls with a required Male/Female gender, then rooms belonging to each hall. Room gender follows the selected hall. Each room has a unique number within its hall, capacity and active state.
- New affiliations, admissions/imports with a hall, transfers and room assignments require the student’s recorded gender to match the hall. Student hall choices are filtered on the server using the signed-in student record. A generic profile edit cannot change student gender to conflict with their current hall.
- Existing halls initially have no configured gender. Set each hall’s official gender in the Halls tab before new affiliations or room assignments. Initial configuration preserves legacy records and flags mismatching current affiliations/rooms for review. Once a gender is configured, it cannot change while the hall has affiliation, room or placement references.
- Record an original hall for a fresher through **Affiliations**, their first room assignment, an admission/import containing a known hall, or their one-time fresher profile selection. Imported hall names must already exist in the managed register.
- `student.originalHallId` is permanent. `instituteAffliate` retains its original display value for existing consumers. `student.currentHallId` is the floating affiliation used for subsequent room allocation.
- A continuing student whose original hall is missing must have it recorded by the registry with the source/reason before receiving a room.
- Assign and reassign rooms only in the active default **first semester** and when the student's programme semester is odd (1, 3, 5, 7, etc.). Deferred, completed and graduated students are ineligible.
- Academic years use consecutive years such as `2026/2027`. Formatting variants with spaces or a hyphen normalize to the same year. Each student has one placement record per academic year, retained when a new year starts.
- Assigning a room in another hall requires explicit re-affiliation consent from the staff member and a reason. This changes only `currentHallId`; the original hall remains unchanged.
- A reassignment changes the existing annual placement and adds an event containing the before/after snapshots, actor and reason. Original affiliation and current-hall transfers have their own event history.
- A room may be released during either semester of the current academic year. Release frees the bed and retains hall affiliation/history. Historical-year placements cannot be reassigned or released.
- Student and room row locks, transactions and version checks prevent duplicate student/year placements, overbooking and stale transfers. A history-write failure rolls the entire change back.
- Used halls/rooms cannot be deleted. Deactivate them instead. Rooms with placement history cannot change hall or gender. Capacity cannot be reduced below recorded active occupancy in an academic year.
- Occupancy is counted separately for each academic year. Placements and CSV reports can be filtered by year, hall, room, status and student search.

## Student portal

Both dashboard and profile show the original/current hall and the room for the active academic year, including semester two. Both also show the STS school for the active semester. These are read-only; room and STS management endpoints reject student access, and student profile updates ignore submitted assignment fields. Failed placement requests display a retry state independently of the rest of the profile.

## Database and deployment

Apply `prisma/sql/2026-10-22_hall_management.sql` once after the preceding migrations, followed by `prisma/sql/2026-10-22_hall_gender.sql`, then regenerate Prisma Client and rebuild the backend. Deploy the matching frontend alongside the backend.

The hall-gender migration adds a nullable `ais_hall.gender` for existing halls awaiting configuration; new hall forms require Male or Female. No hall gender is inferred from student membership.

The initial migration creates five hall/room/history tables and adds `originalHallId`, `currentHallId` and `originalHallSource` to `ais_student`. Existing nonempty `instituteAffliate` values seed the hall register and both hall IDs. These records are labelled `LEGACY` and receive a migration history event. No rooms or student room assignments are invented. Existing affiliation text is preserved exactly; the migration cannot reconstruct an admission hall that was overwritten before this module existed.

This migration was applied to the local development database on 2026-10-22: eight halls and 676 existing student affiliations were preserved. The subsequent hall-gender migration was also applied locally; all eight existing halls await explicit Male/Female configuration. Student affiliations were unchanged. Remote deployment is separate.

## Verification

Run under Node 24 from the backend:

```sh
node --test scripts/test-residence.cjs scripts/test-system-updates.cjs scripts/test-academic.cjs scripts/test-sts.cjs scripts/test-curriculum-scheme.cjs
HALL_TEST_DATABASE=1 node scripts/test-residence-database.cjs
npx tsc --noEmit
```

The database check accepts only a configured local MySQL server. It creates an isolated temporary database using table definitions, runs the actual migration and controller/transaction checks, and removes the test database afterward. It does not write to application student records. It covers concurrent requests for the final bed, gender/semester restrictions, original/current affiliation separation, rollback, capacity changes, releases, second-semester visibility, annual rollover and history/reporting.

Build the web frontend with `npm run build`. Automated rendering checks cover the student room/STS profile cards, failure isolation, read-only markup and hall form validation. Interactive browser verification is separate.
