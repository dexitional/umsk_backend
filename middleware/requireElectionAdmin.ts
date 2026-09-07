import { Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../drizzle/mysqlAdapter';
import { election, portfolio, candidate } from '../drizzle/schema';

// Elections have two admin tiers: the platform-wide `election::admin` role
// (from the JWT, via verifyToken) manages the whole module, while
// `election.admins` is a per-election JSON array of user tags (toggled via
// actionAdmin) scoped to operating just that one election. Either qualifies
// for per-election actions; only the platform role qualifies for actions
// that affect the module globally (creating/deleting elections, granting
// per-election admin rights) — those routes use requireRole directly instead
// of this helper.
async function isElectionAdmin(req: any, electionId?: number): Promise<boolean> {
   const held: string[] = (req.roles || []).map((r: any) => r?.role);
   if (held.includes('election::admin')) return true;
   if (!electionId) return false;

   const en = await db.query.election.findFirst({
      where: eq(election.id, electionId),
      columns: { admins: true },
   });
   const admins = (en?.admins as string[]) || [];
   return admins.some((tag) => tag?.toLowerCase() === req.userId?.toLowerCase());
}

// `getElectionId` resolves the election id for the request — a plain param
// read for most routes, but an async join lookup for portfolio/candidate
// routes where the election id isn't directly in the URL.
const requireElectionAdmin = (
   getElectionId: (req: any) => number | undefined | Promise<number | undefined>
) => async (req: any, res: Response, next: NextFunction) => {
   const electionId = await getElectionId(req);
   if (electionId && (await isElectionAdmin(req, electionId))) return next();
   return res.status(403).json({ message: `You do not have permission to perform this action.` });
};

const electionIdFromParam = (req: any) => Number(req.params.id) || undefined;
const electionIdFromBody = (req: any) => Number(req.body?.electionId ?? req.body?.id) || undefined;

const electionIdFromPortfolioParam = async (req: any) => {
   const id = Number(req.params.id);
   if (!id) return undefined;
   const row = await db.query.portfolio.findFirst({ where: eq(portfolio.id, id), columns: { electionId: true } });
   return row?.electionId;
};

const electionIdFromCandidateParam = async (req: any) => {
   const id = Number(req.params.id);
   if (!id) return undefined;
   const row = await db.query.candidate.findFirst({ where: eq(candidate.id, id), columns: { portfolioId: true } });
   if (!row?.portfolioId) return undefined;
   const p = await db.query.portfolio.findFirst({ where: eq(portfolio.id, row.portfolioId), columns: { electionId: true } });
   return p?.electionId;
};

const electionIdFromCandidateBody = async (req: any) => {
   const portfolioId = Number(req.body?.portfolioId);
   if (!portfolioId) return undefined;
   const p = await db.query.portfolio.findFirst({ where: eq(portfolio.id, portfolioId), columns: { electionId: true } });
   return p?.electionId;
};

module.exports = {
   isElectionAdmin,
   requireElectionAdmin,
   electionIdFromParam,
   electionIdFromBody,
   electionIdFromPortfolioParam,
   electionIdFromCandidateParam,
   electionIdFromCandidateBody,
};
