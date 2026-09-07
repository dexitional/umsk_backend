"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSheetAdmin = isSheetAdmin;
exports.sheetScopeWhere = sheetScopeWhere;
exports.isSheetInScope = isSheetInScope;
const UG_LIKE = ['UG', 'CP', 'DP'];
function heldSheetTags(roles = []) {
    return roles
        .filter((r) => ((r === null || r === void 0 ? void 0 : r.module) === 'sheet' || (r === null || r === void 0 ? void 0 : r.module) === 'mysheet') && (r === null || r === void 0 ? void 0 : r.role))
        .map((r) => r.role);
}
function isSheetAdmin(roles = []) {
    return heldSheetTags(roles).includes('sheet::admin');
}
// Prisma `where` fragment to AND into list/detail queries (fetchSheets, fetchSheet).
// Returns null for admin (no restriction) or a deny-all sentinel if the caller
// holds none of the recognized roles.
function sheetScopeWhere(roles, userId) {
    const tags = heldSheetTags(roles);
    if (!tags.length)
        return { id: '__no_sheet_role__' };
    if (tags.includes('sheet::admin'))
        return null;
    const clauses = [];
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
    if (!clauses.length)
        return { id: '__no_sheet_role__' };
    return clauses.length === 1 ? clauses[0] : { OR: clauses };
}
// Checks whether one specific sheet record falls within any role-scope the
// caller holds. Route-level requireRole already restricts which action types
// a role may attempt; this only narrows WHICH records within that action.
function isSheetInScope(ais, sheetId, roles, userId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        if (isSheetAdmin(roles))
            return true;
        const tags = heldSheetTags(roles);
        if (!tags.length)
            return false;
        const sheet = yield ais.sheet.findUnique({
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
        if (!sheet)
            return false;
        const category = (_a = sheet.program) === null || _a === void 0 ? void 0 : _a.category;
        const unitHeadStaffNo = (_b = sheet.unit) === null || _b === void 0 ? void 0 : _b.headStaffNo;
        const level1HeadStaffNo = (_d = (_c = sheet.unit) === null || _c === void 0 ? void 0 : _c.level1) === null || _d === void 0 ? void 0 : _d.headStaffNo;
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
    });
}
