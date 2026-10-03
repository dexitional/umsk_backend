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
const client_1 = require("../prisma/client");
const ais = client_1.prisma;
// Log Module API (route/logRoute.ts, audit::admin only). Reads the shared
// `log` table written across all modules -- including the ais_assessment
// audit trail (prisma/auditAssessment.ts).
// Action-name prefixes/keywords -> category, for the module's filter tabs.
const CATEGORIES = {
    assessment: ["ASSESSMENT", "SHEET", "BACKLOG", "RESIT", "SCORE"],
    auth: ["LOGIN", "PASSWORD", "SWITCH_USER", "LOGOUT", "TOKEN"],
    students: ["STUDENT", "INDEX_NUMBER", "GRADUAT", "DEFER"],
    academics: ["COURSE", "CALENDAR", "PROGRAM", "SESSION", "SCHEME", "STRUCTURE", "MAJOR", "DEPARTMENT", "UNIT"],
    finance: ["BILL", "PAYMENT", "CHARGE", "TRANSACT", "FEE", "REFUND", "DEBT"],
    messaging: ["SEND_", "SMS", "REMINDER", "NOTIF"],
};
const categoryOf = (action) => { var _a; return ((_a = Object.entries(CATEGORIES).find(([, keys]) => keys.some((k) => action === null || action === void 0 ? void 0 : action.toUpperCase().includes(k)))) === null || _a === void 0 ? void 0 : _a[0]) || "other"; };
function buildWhere(q) {
    const { keyword = "", action = "", category = "", user = "", student = "", from = "", to = "" } = q;
    const and = [];
    if (keyword)
        and.push({ OR: [{ action: { contains: keyword } }, { user: { contains: keyword } }, { student: { contains: keyword } }] });
    if (action)
        and.push({ action });
    if (user)
        and.push({ user });
    if (student)
        and.push({ student });
    if (category && CATEGORIES[category])
        and.push({ OR: CATEGORIES[category].map((k) => ({ action: { contains: k } })) });
    if (category === "other")
        and.push({ NOT: { OR: Object.values(CATEGORIES).flat().map((k) => ({ action: { contains: k } })) } });
    if (from || to)
        and.push({ createdAt: Object.assign(Object.assign({}, (from && { gte: new Date(from) })), (to && { lte: new Date(`${to}T23:59:59.999`) })) });
    return and.length ? { AND: and } : {};
}
// Resolve user tags / student refs to display names (staff, students,
// support accounts) for one page of results.
function resolveNames(tags) {
    return __awaiter(this, void 0, void 0, function* () {
        const ids = [...new Set(tags.filter((t) => t && t !== "system"))];
        if (!ids.length)
            return new Map();
        const name = (p) => [p.fname, p.mname, p.lname].filter(Boolean).join(" ");
        const out = new Map();
        const [staff, students, support] = yield Promise.all([
            ais.staff.findMany({ where: { staffNo: { in: ids } }, select: { staffNo: true, fname: true, mname: true, lname: true } }).catch(() => []),
            ais.student.findMany({ where: { OR: [{ id: { in: ids } }, { indexno: { in: ids } }] }, select: { id: true, indexno: true, fname: true, mname: true, lname: true } }).catch(() => []),
            ais.support.findMany({ where: { supportNo: { in: ids.map(Number).filter((n) => Number.isInteger(n)) } }, select: { supportNo: true, fname: true, lname: true } }).catch(() => []),
        ]);
        support.forEach((s) => out.set(String(s.supportNo), name(s)));
        students.forEach((s) => { out.set(s.id, name(s)); if (s.indexno)
            out.set(s.indexno, name(s)); });
        staff.forEach((s) => out.set(s.staffNo, name(s)));
        return out;
    });
}
// Some modules log credential material in meta (e.g. account staging writes
// the password hash + unlock PIN) -- never send those to the browser.
// Any key that names a credential, e.g. password, oldpassword, newpassword,
// rnewpassword, unlockPin, pin, apiToken, secret, otp.
const SECRET_KEYS = /(pass(word|wd)?|pwd|secret|token|otp)|^(unlock)?pin$/i;
const redact = (v) => Array.isArray(v) ? v.map(redact)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(x)]))
        : v;
const decorate = (rows, names) => rows.map((r) => (Object.assign(Object.assign({}, r), { meta: redact(r.meta), category: categoryOf(r.action), userName: names.get(r.user) || null, studentName: names.get(r.student) || null })));
class LogController {
    fetchLogs(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const page = Math.max(1, Number(req.query.page) || 1);
                const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
                const where = buildWhere(req.query);
                const [total, rows] = yield ais.$transaction([
                    ais.log.count({ where }),
                    ais.log.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: "desc" } }),
                ]);
                const names = yield resolveNames(rows.flatMap((r) => [r.user, r.student]));
                res.status(200).json({ totalPages: Math.ceil(total / pageSize), totalData: total, page, pageSize, data: decorate(rows, names) });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: "Could not load logs" });
            }
        });
    }
    fetchLog(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const row = yield ais.log.findUnique({ where: { id: String(req.params.id) } });
                if (!row)
                    return res.status(404).json({ message: "Log not found" });
                const names = yield resolveNames([row.user || "", row.student || ""]);
                res.status(200).json(decorate([row], names)[0]);
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: "Could not load log" });
            }
        });
    }
    fetchSummary(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const now = new Date();
                const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const daysAgo = (n) => new Date(startOfToday.getTime() - n * 86400000);
                const [total, today, last7, created, updated, deleted, byAction, byUser] = yield Promise.all([
                    ais.log.count(),
                    ais.log.count({ where: { createdAt: { gte: startOfToday } } }),
                    ais.log.count({ where: { createdAt: { gte: daysAgo(6) } } }),
                    ais.log.count({ where: { action: "ASSESSMENT_CREATED" } }),
                    ais.log.count({ where: { action: "ASSESSMENT_UPDATED" } }),
                    ais.log.count({ where: { action: "ASSESSMENT_DELETED" } }),
                    ais.log.groupBy({ by: ["action"], _count: { _all: true }, orderBy: { _count: { action: "desc" } } }),
                    ais.log.groupBy({ by: ["user"], where: { createdAt: { gte: daysAgo(29) }, NOT: { user: null } }, _count: { _all: true }, orderBy: { _count: { user: "desc" } }, take: 6 }),
                ]);
                // Daily activity for the last 14 days (zero-filled).
                const daily = yield ais.$queryRaw `SELECT DATE(createdAt) AS d, COUNT(*) AS c FROM log WHERE createdAt >= ${daysAgo(13)} GROUP BY DATE(createdAt)`;
                const dayMap = new Map(daily.map((r) => [new Date(r.d).toISOString().slice(0, 10), Number(r.c)]));
                const days = Array.from({ length: 14 }, (_, i) => { const d = daysAgo(13 - i); const key = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10); return { date: key, count: dayMap.get(key) || 0 }; });
                const categories = {};
                byAction.forEach((a) => { const c = categoryOf(a.action); categories[c] = (categories[c] || 0) + a._count._all; });
                const names = yield resolveNames(byUser.map((u) => u.user));
                res.status(200).json({
                    total, today, last7,
                    assessment: { created, updated, deleted },
                    categories,
                    actions: byAction.map((a) => ({ action: a.action, count: a._count._all, category: categoryOf(a.action) })),
                    topUsers: byUser.map((u) => ({ user: u.user, name: names.get(u.user) || null, count: u._count._all })),
                    daily: days,
                });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: "Could not load log summary" });
            }
        });
    }
}
exports.default = LogController;
