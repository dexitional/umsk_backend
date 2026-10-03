import { PrismaClient } from "@prisma/client";
import { auditAssessment } from "./auditAssessment";

const { mysqlAdapter } = require("./mysqlAdapter");

declare global {
  // eslint-disable-next-line no-var
  var __prismaUmsa: PrismaClient | undefined;
}

// Plain client -- used by the audit extension itself (pre-reads + log
// writes), so auditing never recurses into its own hooks.
export const prismaBase: PrismaClient =
  global.__prismaUmsa ??
  new PrismaClient({
    adapter: mysqlAdapter,
  });

if (process.env.NODE_ENV !== "production") {
  global.__prismaUmsa = prismaBase;
}

// Shared client for the whole app: every write to ais_assessment is
// audit-logged (see prisma/auditAssessment.ts). The extension only wraps
// existing operations (it adds no methods), so the plain PrismaClient type
// still describes it exactly -- keeping that type avoids the extended
// client's looser batch-$transaction result types breaking callers.
export const prisma: PrismaClient = prismaBase.$extends(auditAssessment(prismaBase)) as unknown as PrismaClient;
