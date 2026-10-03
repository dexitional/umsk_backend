"use strict";
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
exports.auditAssessment = auditAssessment;
exports.withBufferedAudit = withBufferedAudit;
const client_1 = require("@prisma/client");
const crypto_1 = require("crypto");
const requestContext_1 = require("../util/requestContext");
// Audit trail for ais_assessment (course registrations, scores, publishing).
// Installed on the shared Prisma client (prisma/client.ts), so EVERY write
// through ais.assessment.* / tx.assessment.* is logged -- no per-call-site
// logging to forget. One `log` row per operation:
//   action  ASSESSMENT_CREATED | ASSESSMENT_UPDATED | ASSESSMENT_DELETED
//   user    acting user's tag (from verifyToken via requestContext), else 'system'
//   student the index number when every affected record belongs to one student
//   meta    { table, operation, count, records[], request }
//     created -> full new record          updated -> keys + { field: { from, to } }
//     deleted -> full snapshot (recoverable)
// Auditing never blocks the underlying write: failures are only console-logged.
// Fields compared for updates (timestamps excluded -- they always change).
const TRACKED = ["sessionId", "schemeId", "courseId", "indexno", "credit", "semesterNum", "classScore", "examScore", "totalScore", "type", "scoreA", "scoreB", "scoreC", "status"];
const KEYS = ["id", "indexno", "courseId", "sessionId", "semesterNum"];
const pick = (row, fields) => Object.fromEntries(fields.filter((f) => (row === null || row === void 0 ? void 0 : row[f]) !== undefined).map((f) => [f, row[f]]));
const snapshot = (row) => (Object.assign(Object.assign({}, pick(row, KEYS)), pick(row, TRACKED)));
function diff(before, after) {
    var _a, _b;
    const changes = {};
    for (const f of TRACKED) {
        const a = (_a = before === null || before === void 0 ? void 0 : before[f]) !== null && _a !== void 0 ? _a : null, b = (_b = after === null || after === void 0 ? void 0 : after[f]) !== null && _b !== void 0 ? _b : null;
        if (String(a) !== String(b))
            changes[f] = { from: a, to: b };
    }
    return changes;
}
// `data` with only plain values (no { increment: 1 }-style operations) can be
// applied to the before-rows directly -- which also stays correct inside an
// uncommitted transaction, where a fresh read would still see old values.
const isPlainData = (data) => data && typeof data === "object" && Object.values(data).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v) || v instanceof Date);
function safe(fn) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            return yield fn();
        }
        catch (e) {
            console.log("assessment audit: pre-read failed:", e === null || e === void 0 ? void 0 : e.message);
            return null;
        }
    });
}
function buildEntry(action, operation, records) {
    const ctx = (0, requestContext_1.getRequestContext)();
    const students = [...new Set(records.map((r) => r === null || r === void 0 ? void 0 : r.indexno).filter(Boolean))];
    return {
        action,
        user: (ctx === null || ctx === void 0 ? void 0 : ctx.userId) || "system",
        student: students.length === 1 ? String(students[0]) : null,
        meta: {
            table: "ais_assessment",
            operation,
            count: records.length,
            records,
            request: ctx ? { method: ctx.method, path: ctx.path, ip: ctx.ip } : null,
        },
    };
}
function writeLog(base, action, operation, records) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!records.length)
            return;
        const entry = buildEntry(action, operation, records);
        const ctx = (0, requestContext_1.getRequestContext)();
        if (ctx === null || ctx === void 0 ? void 0 : ctx.deferredLogs) {
            ctx.deferredLogs.push(entry);
            return;
        } // inside withBufferedAudit
        try {
            yield base.log.create({ data: entry });
        }
        catch (e) {
            console.log("assessment audit: log write failed:", e === null || e === void 0 ? void 0 : e.message);
        }
    });
}
function auditAssessment(base) {
    return client_1.Prisma.defineExtension({
        name: "auditAssessment",
        query: {
            assessment: {
                create(_a) {
                    return __awaiter(this, arguments, void 0, function* ({ args, query }) {
                        const res = yield query(args);
                        yield writeLog(base, "ASSESSMENT_CREATED", "create", [snapshot(res)]);
                        return res;
                    });
                },
                createMany(_a) {
                    return __awaiter(this, arguments, void 0, function* ({ args, query }) {
                        // MySQL can't return created rows, so give each row its id up front
                        // (the column's @default(uuid()) would do the same) -- the audit
                        // entry then references the real records.
                        const rows = (Array.isArray(args.data) ? args.data : [args.data]).map((r) => (Object.assign({ id: (0, crypto_1.randomUUID)() }, r)));
                        args.data = rows;
                        const res = yield query(args);
                        if (res === null || res === void 0 ? void 0 : res.count)
                            yield writeLog(base, "ASSESSMENT_CREATED", "createMany", rows.map(snapshot));
                        return res;
                    });
                },
                update(_a) {
                    return __awaiter(this, arguments, void 0, function* ({ args, query }) {
                        const before = yield safe(() => base.assessment.findUnique({ where: args.where }));
                        const res = yield query(args);
                        const changes = diff(before, res);
                        if (Object.keys(changes).length)
                            yield writeLog(base, "ASSESSMENT_UPDATED", "update", [Object.assign(Object.assign({}, pick(res, KEYS)), { changes })]);
                        return res;
                    });
                },
                updateMany(_a) {
                    return __awaiter(this, arguments, void 0, function* ({ args, query }) {
                        const before = (yield safe(() => base.assessment.findMany({ where: args.where }))) || [];
                        const res = yield query(args);
                        if ((res === null || res === void 0 ? void 0 : res.count) && before.length) {
                            const after = isPlainData(args.data)
                                ? before.map((b) => (Object.assign(Object.assign({}, b), args.data)))
                                : (yield safe(() => base.assessment.findMany({ where: { id: { in: before.map((b) => b.id) } } }))) || [];
                            const byId = new Map(after.map((a) => [a.id, a]));
                            const records = before
                                .map((b) => (Object.assign(Object.assign({}, pick(b, KEYS)), { changes: diff(b, byId.get(b.id)) })))
                                .filter((r) => Object.keys(r.changes).length);
                            yield writeLog(base, "ASSESSMENT_UPDATED", "updateMany", records);
                        }
                        return res;
                    });
                },
                upsert(_a) {
                    return __awaiter(this, arguments, void 0, function* ({ args, query }) {
                        const before = yield safe(() => base.assessment.findUnique({ where: args.where }));
                        const res = yield query(args);
                        if (!before)
                            yield writeLog(base, "ASSESSMENT_CREATED", "upsert", [snapshot(res)]);
                        else {
                            const changes = diff(before, res);
                            if (Object.keys(changes).length)
                                yield writeLog(base, "ASSESSMENT_UPDATED", "upsert", [Object.assign(Object.assign({}, pick(res, KEYS)), { changes })]);
                        }
                        return res;
                    });
                },
                delete(_a) {
                    return __awaiter(this, arguments, void 0, function* ({ args, query }) {
                        const before = yield safe(() => base.assessment.findUnique({ where: args.where }));
                        const res = yield query(args);
                        yield writeLog(base, "ASSESSMENT_DELETED", "delete", [snapshot(before || res)]);
                        return res;
                    });
                },
                deleteMany(_a) {
                    return __awaiter(this, arguments, void 0, function* ({ args, query }) {
                        const before = (yield safe(() => base.assessment.findMany({ where: args.where }))) || [];
                        const res = yield query(args);
                        if (res === null || res === void 0 ? void 0 : res.count)
                            yield writeLog(base, "ASSESSMENT_DELETED", "deleteMany", before.map(snapshot));
                        return res;
                    });
                },
            },
        },
    });
}
// Wrap an interactive transaction so its audit entries are written only if
// it commits -- a rolled-back transaction must not leave "changed" entries
// for changes that never happened.
function withBufferedAudit(base, fn) {
    return __awaiter(this, void 0, void 0, function* () {
        const deferredLogs = [];
        const result = yield requestContext_1.requestContext.run(Object.assign(Object.assign({}, ((0, requestContext_1.getRequestContext)() || {})), { deferredLogs }), fn);
        if (deferredLogs.length) {
            try {
                yield base.log.createMany({ data: deferredLogs });
            }
            catch (e) {
                console.log("assessment audit: deferred log write failed:", e === null || e === void 0 ? void 0 : e.message);
            }
        }
        return result;
    });
}
