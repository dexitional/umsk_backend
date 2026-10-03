import { Request, Response } from "express";
import { prisma } from "../prisma/client";
const ais = prisma;

// Log Module API (route/logRoute.ts, audit::admin only). Reads the shared
// `log` table written across all modules -- including the ais_assessment
// audit trail (prisma/auditAssessment.ts).

// Action-name prefixes/keywords -> category, for the module's filter tabs.
const CATEGORIES: Record<string, string[]> = {
   assessment: ["ASSESSMENT", "SHEET", "BACKLOG", "RESIT", "SCORE"],
   auth: ["LOGIN", "PASSWORD", "SWITCH_USER", "LOGOUT", "TOKEN"],
   students: ["STUDENT", "INDEX_NUMBER", "GRADUAT", "DEFER"],
   academics: ["COURSE", "CALENDAR", "PROGRAM", "SESSION", "SCHEME", "STRUCTURE", "MAJOR", "DEPARTMENT", "UNIT"],
   finance: ["BILL", "PAYMENT", "CHARGE", "TRANSACT", "FEE", "REFUND", "DEBT"],
   messaging: ["SEND_", "SMS", "REMINDER", "NOTIF"],
};
const categoryOf = (action: string) => Object.entries(CATEGORIES).find(([, keys]) => keys.some((k) => action?.toUpperCase().includes(k)))?.[0] || "other";

function buildWhere(q: any) {
   const { keyword = "", action = "", category = "", user = "", student = "", from = "", to = "" } = q;
   const and: any[] = [];
   if (keyword) and.push({ OR: [{ action: { contains: keyword } }, { user: { contains: keyword } }, { student: { contains: keyword } }] });
   if (action) and.push({ action });
   if (user) and.push({ user });
   if (student) and.push({ student });
   if (category && CATEGORIES[category]) and.push({ OR: CATEGORIES[category].map((k) => ({ action: { contains: k } })) });
   if (category === "other") and.push({ NOT: { OR: Object.values(CATEGORIES).flat().map((k) => ({ action: { contains: k } })) } });
   if (from || to) and.push({ createdAt: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(`${to}T23:59:59.999`) }) } });
   return and.length ? { AND: and } : {};
}

// Resolve user tags / student refs to display names (staff, students,
// support accounts) for one page of results.
async function resolveNames(tags: string[]) {
   const ids = [...new Set(tags.filter((t) => t && t !== "system"))];
   if (!ids.length) return new Map<string, string>();
   const name = (p: any) => [p.fname, p.mname, p.lname].filter(Boolean).join(" ");
   const out = new Map<string, string>();
   const [staff, students, support] = await Promise.all([
      ais.staff.findMany({ where: { staffNo: { in: ids } }, select: { staffNo: true, fname: true, mname: true, lname: true } }).catch(() => []),
      ais.student.findMany({ where: { OR: [{ id: { in: ids } }, { indexno: { in: ids } }] }, select: { id: true, indexno: true, fname: true, mname: true, lname: true } }).catch(() => []),
      ais.support.findMany({ where: { supportNo: { in: ids.map(Number).filter((n) => Number.isInteger(n)) } }, select: { supportNo: true, fname: true, lname: true } }).catch(() => []),
   ]);
   support.forEach((s: any) => out.set(String(s.supportNo), name(s)));
   students.forEach((s: any) => { out.set(s.id, name(s)); if (s.indexno) out.set(s.indexno, name(s)); });
   staff.forEach((s: any) => out.set(s.staffNo, name(s)));
   return out;
}

// Some modules log credential material in meta (e.g. account staging writes
// the password hash + unlock PIN) -- never send those to the browser.
// Any key that names a credential, e.g. password, oldpassword, newpassword,
// rnewpassword, unlockPin, pin, apiToken, secret, otp.
const SECRET_KEYS = /(pass(word|wd)?|pwd|secret|token|otp)|^(unlock)?pin$/i;
const redact = (v: any): any =>
   Array.isArray(v) ? v.map(redact)
   : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : redact(x)]))
   : v;

const decorate = (rows: any[], names: Map<string, string>) =>
   rows.map((r) => ({ ...r, meta: redact(r.meta), category: categoryOf(r.action), userName: names.get(r.user) || null, studentName: names.get(r.student) || null }));

export default class LogController {
   async fetchLogs(req: Request, res: Response) {
      try {
         const page = Math.max(1, Number(req.query.page) || 1);
         const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
         const where = buildWhere(req.query);
         const [total, rows] = await ais.$transaction([
            ais.log.count({ where }),
            ais.log.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: { createdAt: "desc" } }),
         ]);
         const names = await resolveNames(rows.flatMap((r: any) => [r.user, r.student]));
         res.status(200).json({ totalPages: Math.ceil(total / pageSize), totalData: total, page, pageSize, data: decorate(rows, names) });
      } catch (error: any) {
         console.log(error);
         return res.status(500).json({ message: "Could not load logs" });
      }
   }

   async fetchLog(req: Request, res: Response) {
      try {
         const row = await ais.log.findUnique({ where: { id: String(req.params.id) } });
         if (!row) return res.status(404).json({ message: "Log not found" });
         const names = await resolveNames([row.user || "", row.student || ""]);
         res.status(200).json(decorate([row], names)[0]);
      } catch (error: any) {
         console.log(error);
         return res.status(500).json({ message: "Could not load log" });
      }
   }

   async fetchSummary(req: Request, res: Response) {
      try {
         const now = new Date();
         const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
         const daysAgo = (n: number) => new Date(startOfToday.getTime() - n * 86400000);
         const [total, today, last7, created, updated, deleted, byAction, byUser] = await Promise.all([
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
         const daily: any[] = await ais.$queryRaw`SELECT DATE(createdAt) AS d, COUNT(*) AS c FROM log WHERE createdAt >= ${daysAgo(13)} GROUP BY DATE(createdAt)`;
         const dayMap = new Map(daily.map((r: any) => [new Date(r.d).toISOString().slice(0, 10), Number(r.c)]));
         const days = Array.from({ length: 14 }, (_, i) => { const d = daysAgo(13 - i); const key = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10); return { date: key, count: dayMap.get(key) || 0 }; });

         const categories: Record<string, number> = {};
         byAction.forEach((a: any) => { const c = categoryOf(a.action); categories[c] = (categories[c] || 0) + a._count._all; });
         const names = await resolveNames(byUser.map((u: any) => u.user));
         res.status(200).json({
            total, today, last7,
            assessment: { created, updated, deleted },
            categories,
            actions: byAction.map((a: any) => ({ action: a.action, count: a._count._all, category: categoryOf(a.action) })),
            topUsers: byUser.map((u: any) => ({ user: u.user, name: names.get(u.user) || null, count: u._count._all })),
            daily: days,
         });
      } catch (error: any) {
         console.log(error);
         return res.status(500).json({ message: "Could not load log summary" });
      }
   }
}
