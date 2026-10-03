import { AsyncLocalStorage } from 'async_hooks';

// Per-request context, so code far from the Express handler (e.g. the
// Prisma audit extension in prisma/auditAssessment.ts) can tell who is
// acting without every call site having to pass req.userId along.
// Populated by verifyToken for every authenticated request.
export type RequestContext = {
  userId?: string;
  ip?: string;
  method?: string;
  path?: string;
  // Set while inside withBufferedAudit(): audit entries are held here and
  // only written once the surrounding database transaction has committed.
  deferredLogs?: any[];
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const getRequestContext = (): RequestContext | undefined => requestContext.getStore();
