// Data-level scoping for the Resit module (resit::admin, resit::assessor).
// Route-level access (which endpoints a role may call at all) is enforced by
// requireRole middleware; this file narrows that further to which specific
// resit *records* a role may see or act on:
//   resit::admin     - unrestricted
//   resit::assessor  - only resits for a course whose curriculum entry
//                       (structure) is owned by a department this caller
//                       heads. A course can be taught by more than one
//                       department (one `structure` row per program/major/
//                       semester it's offered in), and it's the STRUCTURE
//                       row's own unitId — not the student's own declared
//                       program's unit — that determines who's authorized
//                       to score it. `structure` has no relation back to
//                       `resit`/`assessment`, so the lookup goes the other
//                       way: resit's (courseId, semesterNum, student's
//                       programId) -> matching structure row -> unitId ->
//                       unit.headStaffNo.

type Role = { role?: string; module?: string; app?: string };

function heldResitTags(roles: Role[] = []): string[] {
  return roles
    .filter((r) => r?.module === 'resit' && r?.role)
    .map((r) => r.role as string);
}

export function isResitAdmin(roles: Role[] = []): boolean {
  return heldResitTags(roles).includes('resit::admin');
}

// Prisma `where` fragment to AND into list queries (fetchResitSessionList).
// Resolves to {} for admin (no restriction) or a deny-all sentinel if the
// caller holds none of the recognized roles / heads no department with any
// matching curriculum entries. Async: unlike a single-hop relation filter,
// this has no direct Prisma relation to join through, so the caller's
// owned (courseId, programId, semesterNum) combos must be resolved with a
// separate query first.
export async function resitScopeWhere(ais: any, roles: Role[], userId: string): Promise<any> {
  const tags = heldResitTags(roles);
  if (!tags.length) return { id: '__no_resit_role__' };
  if (tags.includes('resit::admin')) return {};
  if (tags.includes('resit::assessor')) {
    // Some legacy `unit` rows have headStaffNo set to '' rather than left
    // null — never treat that as a real identity match (a blank userId
    // matching every such unit blew this query past MySQL's 61-table join
    // limit when tested against live data).
    if (!userId) return { id: '__no_resit_role__' };
    const owned = await ais.structure.findMany({
      where: { unit: { headStaffNo: userId } },
      select: { courseId: true, programId: true, semesterNum: true },
    });
    if (!owned.length) return { id: '__no_resit_role__' };
    return {
      OR: owned.map((s: any) => ({
        courseId: s.courseId,
        semesterNum: s.semesterNum,
        student: { programId: s.programId },
      })),
    };
  }
  return { id: '__no_resit_role__' };
}

// Checks whether one specific resit record falls within any role-scope the
// caller holds. Route-level requireRole already restricts which action types
// a role may attempt; this only narrows WHICH records within that action —
// used before saveResitSession mutates a score by raw resit row id.
export async function isResitInScope(ais: any, resitId: string, roles: Role[], userId: string): Promise<boolean> {
  if (isResitAdmin(roles)) return true;
  const tags = heldResitTags(roles);
  if (!tags.length) return false;

  const resit = await ais.resit.findUnique({
    where: { id: resitId },
    select: {
      courseId: true,
      semesterNum: true,
      student: { select: { programId: true } },
    },
  });
  if (!resit || !resit.student?.programId) return false;

  const structureRow = await ais.structure.findFirst({
    where: {
      courseId: resit.courseId,
      programId: resit.student.programId,
      semesterNum: resit.semesterNum,
    },
    select: { unit: { select: { headStaffNo: true } } },
  });
  const unitHeadStaffNo = structureRow?.unit?.headStaffNo;

  return tags.some((tag) => {
    switch (tag) {
      case 'resit::assessor':
        return !!unitHeadStaffNo && unitHeadStaffNo === userId;
      default:
        return false;
    }
  });
}
