"use strict";
// Data-level scoping for AMS modules split by admission category: applicant,
// shortlist, matriculant. Each has at most 4 role variants (admin-ug,
// clerk-ug, admin-pg, clerk-pg) — and per the app-wide "one role per module"
// rule, a user holds at most one of them for a given module, so scope
// resolves directly from whichever tag is held, no union needed.
Object.defineProperty(exports, "__esModule", { value: true });
exports.categoryScope = categoryScope;
exports.categoryWhere = categoryWhere;
exports.hasRoleTag = hasRoleTag;
exports.categoryScopeAcross = categoryScopeAcross;
function heldRoles(roles = [], modulePrefix) {
    return roles
        .filter((r) => (r === null || r === void 0 ? void 0 : r.module) === modulePrefix && (r === null || r === void 0 ? void 0 : r.role))
        .map((r) => r.role);
}
// 'UG' | 'PG' | null (null = holds no role for this module at all).
function categoryScope(roles, modulePrefix) {
    const tags = heldRoles(roles, modulePrefix);
    if (tags.some((t) => t.endsWith('-pg')))
        return 'PG';
    if (tags.some((t) => t.endsWith('-ug')))
        return 'UG';
    return null;
}
// Prisma where-fragment for a `categoryId` field at the current query level,
// given a resolved scope. For models where categoryId sits behind a relation
// (e.g. applicant.stage.categoryId), wrap this: { stage: categoryWhere(scope) }.
function categoryWhere(scope) {
    if (scope === 'PG')
        return { categoryId: 'PG' };
    if (scope === 'UG')
        return { categoryId: { not: 'PG' } };
    return { categoryId: '__no_category_role__' };
}
function hasRoleTag(roles = [], tag) {
    return roles.some((r) => (r === null || r === void 0 ? void 0 : r.role) === tag);
}
// Some applicant records are read from more than one module's page (the
// read-only application-form preview is shown from the applicant, shortlist,
// and matriculant pages alike) — resolve scope from whichever of those
// modules the caller actually holds a role in, rather than assuming they
// hold the applicant:: role specifically.
function categoryScopeAcross(roles, modulePrefixes) {
    for (const modulePrefix of modulePrefixes) {
        const scope = categoryScope(roles, modulePrefix);
        if (scope)
            return scope;
    }
    return null;
}
