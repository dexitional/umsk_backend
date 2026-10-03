import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { getRequestContext, requestContext } from "../util/requestContext";

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
const TRACKED = ["sessionId", "schemeId", "courseId", "indexno", "credit", "semesterNum", "classScore", "examScore", "totalScore", "type", "scoreA", "scoreB", "scoreC", "status"] as const;
const KEYS = ["id", "indexno", "courseId", "sessionId", "semesterNum"] as const;

const pick = (row: any, fields: readonly string[]) => Object.fromEntries(fields.filter((f) => row?.[f] !== undefined).map((f) => [f, row[f]]));
const snapshot = (row: any) => ({ ...pick(row, KEYS), ...pick(row, TRACKED) });

function diff(before: any, after: any) {
  const changes: Record<string, { from: any; to: any }> = {};
  for (const f of TRACKED) {
    const a = before?.[f] ?? null, b = after?.[f] ?? null;
    if (String(a) !== String(b)) changes[f] = { from: a, to: b };
  }
  return changes;
}

// `data` with only plain values (no { increment: 1 }-style operations) can be
// applied to the before-rows directly -- which also stays correct inside an
// uncommitted transaction, where a fresh read would still see old values.
const isPlainData = (data: any) => data && typeof data === "object" && Object.values(data).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v) || v instanceof Date);

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e: any) { console.log("assessment audit: pre-read failed:", e?.message); return null; }
}

function buildEntry(action: string, operation: string, records: any[]) {
  const ctx = getRequestContext();
  const students = [...new Set(records.map((r) => r?.indexno).filter(Boolean))];
  return {
    action,
    user: ctx?.userId || "system",
    student: students.length === 1 ? String(students[0]) : null,
    meta: {
      table: "ais_assessment",
      operation,
      count: records.length,
      records,
      request: ctx ? { method: ctx.method, path: ctx.path, ip: ctx.ip } : null,
    } as any,
  };
}

async function writeLog(base: PrismaClient, action: string, operation: string, records: any[]) {
  if (!records.length) return;
  const entry = buildEntry(action, operation, records);
  const ctx = getRequestContext();
  if (ctx?.deferredLogs) { ctx.deferredLogs.push(entry); return; } // inside withBufferedAudit
  try { await base.log.create({ data: entry }); } catch (e: any) { console.log("assessment audit: log write failed:", e?.message); }
}

export function auditAssessment(base: PrismaClient) {
  return Prisma.defineExtension({
    name: "auditAssessment",
    query: {
      assessment: {
        async create({ args, query }) {
          const res: any = await query(args);
          await writeLog(base, "ASSESSMENT_CREATED", "create", [snapshot(res)]);
          return res;
        },
        async createMany({ args, query }) {
          // MySQL can't return created rows, so give each row its id up front
          // (the column's @default(uuid()) would do the same) -- the audit
          // entry then references the real records.
          const rows = (Array.isArray(args.data) ? args.data : [args.data]).map((r: any) => ({ id: randomUUID(), ...r }));
          args.data = rows as any;
          const res: any = await query(args);
          if (res?.count) await writeLog(base, "ASSESSMENT_CREATED", "createMany", rows.map(snapshot));
          return res;
        },
        async update({ args, query }) {
          const before = await safe(() => base.assessment.findUnique({ where: args.where }));
          const res: any = await query(args);
          const changes = diff(before, res);
          if (Object.keys(changes).length) await writeLog(base, "ASSESSMENT_UPDATED", "update", [{ ...pick(res, KEYS), changes }]);
          return res;
        },
        async updateMany({ args, query }) {
          const before = (await safe(() => base.assessment.findMany({ where: args.where }))) || [];
          const res: any = await query(args);
          if (res?.count && before.length) {
            const after = isPlainData(args.data)
              ? before.map((b: any) => ({ ...b, ...(args.data as any) }))
              : (await safe(() => base.assessment.findMany({ where: { id: { in: before.map((b: any) => b.id) } } }))) || [];
            const byId = new Map(after.map((a: any) => [a.id, a]));
            const records = before
              .map((b: any) => ({ ...pick(b, KEYS), changes: diff(b, byId.get(b.id)) }))
              .filter((r: any) => Object.keys(r.changes).length);
            await writeLog(base, "ASSESSMENT_UPDATED", "updateMany", records);
          }
          return res;
        },
        async upsert({ args, query }) {
          const before = await safe(() => base.assessment.findUnique({ where: args.where }));
          const res: any = await query(args);
          if (!before) await writeLog(base, "ASSESSMENT_CREATED", "upsert", [snapshot(res)]);
          else {
            const changes = diff(before, res);
            if (Object.keys(changes).length) await writeLog(base, "ASSESSMENT_UPDATED", "upsert", [{ ...pick(res, KEYS), changes }]);
          }
          return res;
        },
        async delete({ args, query }) {
          const before = await safe(() => base.assessment.findUnique({ where: args.where }));
          const res: any = await query(args);
          await writeLog(base, "ASSESSMENT_DELETED", "delete", [snapshot(before || res)]);
          return res;
        },
        async deleteMany({ args, query }) {
          const before = (await safe(() => base.assessment.findMany({ where: args.where }))) || [];
          const res: any = await query(args);
          if (res?.count) await writeLog(base, "ASSESSMENT_DELETED", "deleteMany", before.map(snapshot));
          return res;
        },
      },
    },
  });
}

// Wrap an interactive transaction so its audit entries are written only if
// it commits -- a rolled-back transaction must not leave "changed" entries
// for changes that never happened.
export async function withBufferedAudit<T>(base: PrismaClient, fn: () => Promise<T>): Promise<T> {
  const deferredLogs: any[] = [];
  const result = await requestContext.run({ ...(getRequestContext() || {}), deferredLogs }, fn);
  if (deferredLogs.length) {
    try { await base.log.createMany({ data: deferredLogs }); } catch (e: any) { console.log("assessment audit: deferred log write failed:", e?.message); }
  }
  return result;
}
