import { Request } from "express";
import { prisma } from "../prisma/client";

// Writes to the shared `log` table read by the Log Module (logController).
// Record-level entries use the shape the Logs drawer renders:
//   meta = { table, count, records: [snapshot | { id, changes: { field: { from, to } } }], request, ...extra }

// JSON-safe copy for log.meta (Dates -> ISO strings, undefined dropped).
const plain = (v: any) => JSON.parse(JSON.stringify(v ?? {}));

export const requestInfo = (req: Request) => ({
   method: req.method,
   path: req.originalUrl?.split("?")[0],
   ip: String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip,
});

// Never throws: a failed log write must not fail (or roll back the response
// of) the payment/bill operation being logged.
export async function writeLog(action: string, entry: { user?: string | null; student?: string | null; meta?: any }) {
   try {
      await prisma.log.create({ data: { action, user: entry.user ?? null, student: entry.student ?? null, meta: plain(entry.meta) } });
   } catch (error: any) {
      console.log(`log write failed (${action}):`, error?.message);
   }
}

export const pick = (row: any, fields: string[]) =>
   row ? Object.fromEntries(fields.filter((f) => row[f] !== undefined).map((f) => [f, row[f]])) : null;

// Field-level differences between two snapshots, as { field: { from, to } }.
export function diff(before: any, after: any, fields: string[]) {
   const out: Record<string, { from: any; to: any }> = {};
   for (const f of fields) {
      const a = before?.[f] ?? null, b = after?.[f] ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { from: a, to: b };
   }
   return out;
}

// One record-level entry for a staff action on `table`.
export const logRecords = (req: any, action: string, table: string, records: any[], extra: { student?: string | null; user?: string | null; [k: string]: any } = {}) => {
   const { student, user, ...rest } = extra;
   return writeLog(action, {
      user: user ?? req?.userId ?? null,
      student: student ?? null,
      meta: { table, count: records.length, records, ...(req?.method ? { request: requestInfo(req) } : {}), ...rest },
   });
};

export const BILL_FIELDS = ["id", "narrative", "programId", "sessionId", "bankaccId", "type", "residentialStatus", "currency", "amount", "discount", "quota", "mainGroupCode", "discountGroupCode", "posted", "status"];
export const PAYMENT_FIELDS = ["id", "studentId", "transtypeId", "bankaccId", "collectorId", "amount", "currency", "reference", "transtag", "payType", "feeType", "createdAt"];
