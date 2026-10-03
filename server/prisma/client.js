"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = exports.prismaBase = void 0;
const client_1 = require("@prisma/client");
const auditAssessment_1 = require("./auditAssessment");
const { mysqlAdapter } = require("./mysqlAdapter");
// Plain client -- used by the audit extension itself (pre-reads + log
// writes), so auditing never recurses into its own hooks.
exports.prismaBase = (_a = global.__prismaUmsa) !== null && _a !== void 0 ? _a : new client_1.PrismaClient({
    adapter: mysqlAdapter,
});
if (process.env.NODE_ENV !== "production") {
    global.__prismaUmsa = exports.prismaBase;
}
// Shared client for the whole app: every write to ais_assessment is
// audit-logged (see prisma/auditAssessment.ts). The extension only wraps
// existing operations (it adds no methods), so the plain PrismaClient type
// still describes it exactly -- keeping that type avoids the extended
// client's looser batch-$transaction result types breaking callers.
exports.prisma = exports.prismaBase.$extends((0, auditAssessment_1.auditAssessment)(exports.prismaBase));
