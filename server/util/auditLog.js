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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAYMENT_FIELDS = exports.BILL_FIELDS = exports.logRecords = exports.pick = exports.requestInfo = void 0;
exports.writeLog = writeLog;
exports.diff = diff;
const client_1 = require("../prisma/client");
// Writes to the shared `log` table read by the Log Module (logController).
// Record-level entries use the shape the Logs drawer renders:
//   meta = { table, count, records: [snapshot | { id, changes: { field: { from, to } } }], request, ...extra }
// JSON-safe copy for log.meta (Dates -> ISO strings, undefined dropped).
const plain = (v) => JSON.parse(JSON.stringify(v !== null && v !== void 0 ? v : {}));
const requestInfo = (req) => {
    var _a;
    return ({
        method: req.method,
        path: (_a = req.originalUrl) === null || _a === void 0 ? void 0 : _a.split("?")[0],
        ip: String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip,
    });
};
exports.requestInfo = requestInfo;
// Never throws: a failed log write must not fail (or roll back the response
// of) the payment/bill operation being logged.
function writeLog(action, entry) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        try {
            yield client_1.prisma.log.create({ data: { action, user: (_a = entry.user) !== null && _a !== void 0 ? _a : null, student: (_b = entry.student) !== null && _b !== void 0 ? _b : null, meta: plain(entry.meta) } });
        }
        catch (error) {
            console.log(`log write failed (${action}):`, error === null || error === void 0 ? void 0 : error.message);
        }
    });
}
const pick = (row, fields) => row ? Object.fromEntries(fields.filter((f) => row[f] !== undefined).map((f) => [f, row[f]])) : null;
exports.pick = pick;
// Field-level differences between two snapshots, as { field: { from, to } }.
function diff(before, after, fields) {
    var _a, _b;
    const out = {};
    for (const f of fields) {
        const a = (_a = before === null || before === void 0 ? void 0 : before[f]) !== null && _a !== void 0 ? _a : null, b = (_b = after === null || after === void 0 ? void 0 : after[f]) !== null && _b !== void 0 ? _b : null;
        if (JSON.stringify(a) !== JSON.stringify(b))
            out[f] = { from: a, to: b };
    }
    return out;
}
// One record-level entry for a staff action on `table`.
const logRecords = (req, action, table, records, extra = {}) => {
    var _a;
    const { student, user } = extra, rest = __rest(extra, ["student", "user"]);
    return writeLog(action, {
        user: (_a = user !== null && user !== void 0 ? user : req === null || req === void 0 ? void 0 : req.userId) !== null && _a !== void 0 ? _a : null,
        student: student !== null && student !== void 0 ? student : null,
        meta: Object.assign(Object.assign({ table, count: records.length, records }, ((req === null || req === void 0 ? void 0 : req.method) ? { request: (0, exports.requestInfo)(req) } : {})), rest),
    });
};
exports.logRecords = logRecords;
exports.BILL_FIELDS = ["id", "narrative", "programId", "sessionId", "bankaccId", "type", "residentialStatus", "currency", "amount", "discount", "quota", "mainGroupCode", "discountGroupCode", "posted", "status"];
exports.PAYMENT_FIELDS = ["id", "studentId", "transtypeId", "bankaccId", "collectorId", "amount", "currency", "reference", "transtag", "payType", "feeType", "createdAt"];
