// Data-level scoping for the Assessment Sheet module (sheet::*, mysheet::assessor).
// Route-level access (which endpoints a role may call at all) is enforced by
// requireRole middleware; this file narrows that further to which specific
// sheet *records* a role may see or act on, per role:
//   sheet::admin        - unrestricted
//   sheet::dean         - any category, but only units whose PARENT (level1) they head
//   sheet::hod          - UG/CP/DP category, only units they directly head
//   sheet::head         - any category, only units they directly head (moderation gate)
//   sheet::pg-registry  - PG category, any unit
//   sheet::ug-registry  - UG/CP/DP category, any unit
//   mysheet::assessor   - only sheets assigned to them (assignStaffId)
// A user can hold a sheet::* role and mysheet::assessor at once (different
// module tags), so scope is the union of every relevant role they hold.

type Role = { role?: string; module?: string; app?: string };

const UG_LIKE = ['UG', 'CP', 'DP'];

function heldSheetTags(roles: Role[] = []): string[] {
  return roles
    .filter((r) => (r?.module === 'sheet' || r?.module === 'mysheet') && r?.role)
    .map((r) => r.role as string);
}

export function isSheetAdmin(roles: Role[] = []): boolean {
  return heldSheetTags(roles).includes('sheet::admin');
}

// Prisma `where` fragment to AND into list/detail queries (fetchSheets, fetchSheet).
// Returns null for admin (no restriction) or a deny-all sentinel if the caller
// holds none of the recognized roles.
export function sheetScopeWhere(roles: Role[], userId: string): any {
  const tags = heldSheetTags(roles);
  if (!tags.length) return { id: '__no_sheet_role__' };
  if (tags.includes('sheet::admin')) return null;

  const clauses: any[] = [];
  if (tags.includes('sheet::dean')) {
    clauses.push({ unit: { level1: { headStaffNo: userId } } });
  }
  if (tags.includes('sheet::hod')) {
    clauses.push({
      program: { category: { in: UG_LIKE } },
      unit: { headStaffNo: userId },
    });
  }
  if (tags.includes('sheet::head')) {
    clauses.push({ unit: { headStaffNo: userId } });
  }
  if (tags.includes('sheet::pg-registry')) {
    clauses.push({ program: { category: 'PG' } });
  }
  if (tags.includes('sheet::ug-registry')) {
    clauses.push({ program: { category: { in: UG_LIKE } } });
  }
  if (tags.includes('mysheet::assessor')) {
    clauses.push({ assignStaffId: userId });
  }

  if (!clauses.length) return { id: '__no_sheet_role__' };
  return clauses.length === 1 ? clauses[0] : { OR: clauses };
}

// Checks whether one specific sheet record falls within any role-scope the
// caller holds. Route-level requireRole already restricts which action types
// a role may attempt; this only narrows WHICH records within that action.
export async function isSheetInScope(ais: any, sheetId: string, roles: Role[], userId: string): Promise<boolean> {
  if (isSheetAdmin(roles)) return true;
  const tags = heldSheetTags(roles);
  if (!tags.length) return false;

  const sheet = await ais.sheet.findUnique({
    where: { id: sheetId },
    select: {
      assignStaffId: true,
      program: { select: { category: true } },
      unit: {
        select: {
          headStaffNo: true,
          level1: { select: { headStaffNo: true } },
        },
      },
    },
  });
  if (!sheet) return false;

  const category = sheet.program?.category;
  const unitHeadStaffNo = sheet.unit?.headStaffNo;
  const level1HeadStaffNo = sheet.unit?.level1?.headStaffNo;

  return tags.some((tag) => {
    switch (tag) {
      case 'sheet::dean':
        return level1HeadStaffNo === userId;
      case 'sheet::hod':
        return UG_LIKE.includes(category) && unitHeadStaffNo === userId;
      case 'sheet::head':
        return unitHeadStaffNo === userId;
      case 'sheet::pg-registry':
        return category === 'PG';
      case 'sheet::ug-registry':
        return UG_LIKE.includes(category);
      case 'mysheet::assessor':
        return sheet.assignStaffId === userId;
      default:
        return false;
    }
  });
}
