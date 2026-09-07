import { and, asc, count, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { Request, Response } from "express";
import fs from "fs";
import moment from "moment";
import path from "path";
import { db } from "../drizzle/mysqlAdapter";
import { candidate, election, elector, portfolio, staff, student, user } from "../drizzle/schema"; // Your schema definitions
import { paramStr } from "../util/paramStr";
const { isElectionAdmin } = require("../middleware/requireElectionAdmin");

// voterData carries every voter's username/pin/phone (from setupVoters) —
// strip it down to {tag, name} for any response that isn't admin-scoped,
// since that's all list/card views need (turnout is reported separately).
// Plain function rather than a class method: controller methods are passed
// to Express as bare callbacks (`this.controller.fetchElections`), so `this`
// is undefined when they run — a class method here would throw the same way.
function stripVoterData(voterData: unknown) {
   return ((voterData as any[]) || []).map((r: any) => ({ tag: r?.tag, name: r?.name }));
}

// Candidate photos and election logos land in a publicly-served static
// folder — the client already checks `type.match("image.*")`, but that's
// trivially bypassed by calling the API directly, so it isn't a real
// control on its own. Re-check server-side before ever writing the file.
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB

function isValidImageUpload(file: any): boolean {
   return !!file && ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype) && file.size > 0 && file.size <= MAX_IMAGE_UPLOAD_BYTES;
}

export default class EvsController {

   // Elections
   async fetchAdminElections(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const limit = Number(pageSize);
      const offset = (Number(page) - 1) * limit;
      try {
         const searchFilter = keyword ? or(like(election.title, `%${keyword}%`)) : undefined;
         const [totalCount, data] = await db.transaction(async (tx) => {
            // const countResult = await tx.select({ value: count() }).from(election).where(searchFilter);
            const countResult = await tx.$count(election, searchFilter);
            const items = await tx.query.election.findMany({
               where: searchFilter,
               with: { group: true },
               limit: limit,
               offset: offset,
               orderBy: [desc(election.createdAt)]
            });
            // return [countResult[0].value, items];
            return [countResult, items];
         });

         if (data.length) {
            res.status(200).json({
               totalPages: Math.ceil(totalCount / limit),
               totalData: data.length,
               data: data,
            });
         } else {
            res.status(204).json({ message: `no records found` });
         }
      } catch (error: any) {
         console.error(error);
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchElections(req: Request, res: Response) {
      try {
         const resp = await db.query.election.findMany({
            where: eq(election.status, 1),
            orderBy: [desc(election.createdAt)]
         });
         const data = resp.map((r: any) => ({ ...r, voterData: stripVoterData(r.voterData) }));
         data.length ? res.status(200).json(data) : res.status(204).json({ message: `no record found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchMyElections(req: Request, res: Response) {
      try {
         // "My" elections means the caller's own — identity comes from the
         // verified JWT, not the URL, otherwise anyone could pass another
         // user's tag and see who they're registered/admin for and every
         // vote cast in that election (via the old unfiltered `voters` field).
         const tag = (req as any).userId;
         if (!tag || tag.toLowerCase() !== paramStr(req.params.tag)?.toLowerCase()) {
            return res.status(403).json({ message: `You do not have permission to perform this action.` });
         }

         const en = await db.select().from(election).where(
            and(
               eq(election.status, 1),
               or(
                  sql`JSON_CONTAINS(${election.voterData}, JSON_OBJECT('tag', ${tag}))`,
                  sql`JSON_CONTAINS(${election.admins}, JSON_QUOTE(${tag}))`
               )
            )
         );

         if (en.length) {
            // One query for elector rows across every matching election,
            // rather than a turnout count() + a findFirst per election (was
            // 2 extra round-trips per election).
            const electionIds = en.map((r: any) => r.id);
            const allElectors = await db.select({ electionId: elector.electionId, tag: elector.tag }).from(elector).where(inArray(elector.electionId, electionIds));
            const turnoutByElection = new Map<number, number>();
            const votedElectionIds = new Set<number>();
            for (const row of allElectors as any[]) {
               turnoutByElection.set(row.electionId, (turnoutByElection.get(row.electionId) || 0) + 1);
               if (row.tag === tag) votedElectionIds.add(row.electionId);
            }

            const resp = await Promise.all(en.map(async (r: any) => {
               const isAdmin = await isElectionAdmin(req, r.id);
               return {
                  ...r,
                  voterData: isAdmin ? r.voterData : stripVoterData(r.voterData),
                  turnout: turnoutByElection.get(r.id) || 0,
                  voteStatus: votedElectionIds.has(r.id)
               };
            }));
            res.status(200).json(resp);
         } else {
            res.status(204).json({ message: `no record found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchElection(req: Request, res: Response) {
      try {
         const id = Number(paramStr(req.params.id));
         const resp = await db.query.election.findFirst({
            where: eq(election.id, id),
            with: { group: true },
         });

         if (resp) {
            const tsResult = await db.select({ value: count() }).from(elector).where(eq(elector.electionId, id));
            const turnout = tsResult[0].value;

            // voterData entries carry username/pin/phone (populated by
            // setupVoters for SMS delivery at registration time) — only an
            // election admin should ever see those again; everyone else
            // gets just enough to render the voters register (tag/name/status).
            const isAdmin = await isElectionAdmin(req, id);
            const voterData: any = resp.voterData;
            // One query for every elector row in this election, rather than
            // one findFirst per registered voter (was N+1 — an election
            // with hundreds/thousands of voters meant that many round-trips).
            const electorRows = voterData?.length
               ? await db.select({ tag: elector.tag }).from(elector).where(eq(elector.electionId, id))
               : [];
            const votedTags = new Set(electorRows.map((r: any) => r.tag));
            const tm = voterData?.map((r: any) => {
               const voteStatus = votedTags.has(r?.tag);
               return isAdmin ? { ...r, voteStatus } : { tag: r?.tag, name: r?.name, voteStatus };
            });

            res.status(200).json({ ...resp, voterData: tm, turnout });
         } else {
            res.status(204).json({ message: `no record found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async postElection(req: Request, res: Response) {
      try {
         let data = { ...req.body };
         delete data.logo;

         if (data.startAt) data.startAt = new Date(data.startAt);
         if (data.endAt) data.endAt = new Date(data.endAt);
         if (data.groupId) data.groupId = Number(data.groupId);
         if (data.voterList) data.voterList = JSON.parse(data.voterList);
         
         const booleanFields = ['status', 'allowMonitor', 'allowVip', 'allowResult', 'allowMask', 'allowEcMonitor', 'allowEcVip', 'allowEcResult', 'autoStop'];
         booleanFields.forEach(field => {
            if (data[field] !== undefined) data[field] = Boolean(Number(data[field]));
         });

         const logo: any = req?.files?.logo;
         if (logo && !isValidImageUpload(logo)) {
            return res.status(400).json({ message: `Logo must be an image (png/jpeg/webp/gif) under 5MB.` });
         }
         const [newElection] = await db.insert(election).values(data);

         if (newElection) {
            // Candidate photos for this election are stored under
            // public/cdn/photo/evs/{electionId}/ — this used to create a
            // same-named-but-wrong public/cdn/evs/{electionId}/ folder
            // instead, so that directory never existed and candidate photo
            // uploads silently failed (express-fileupload's .mv() errors on
            // a missing target dir, but the error was only console.log'd).
            const folderPath = path.join(__dirname, "/../../public/cdn/photo/evs", String(newElection.insertId));
            if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

            if (logo) {
               const dest = path.join(__dirname, "/../../public/cdn/photo/evs/", `${newElection.insertId}.png`);
               logo.mv(dest, (err: any) => err && console.log(err));
            }
            res.status(200).json(newElection);
         }
      } catch (error: any) {
         console.log(error)
         // return res.status(500).json({ message: error.message });
      }
   }

   async updateElection(req: Request, res: Response) {
      try {
         const id = Number(paramStr(req.params.id));
         let data = { ...req.body };
         delete data.logo;
         if (data.startAt) data.startAt = new Date(data.startAt);
         if (data.endAt) data.endAt = new Date(data.endAt);
         if (data.groupId) data.groupId = Number(data.groupId);
         if (data.voterList) data.voterList = JSON.parse(data.voterList);

         const booleanFields = ['status', 'allowMonitor', 'allowVip', 'allowResult', 'allowMask', 'allowEcMonitor', 'allowEcVip', 'allowEcResult', 'autoStop'];
         booleanFields.forEach(field => {
            if (data[field] !== undefined) data[field] = Boolean(Number(data[field]));
         });

         const logo: any = req?.files?.logo;
         if (logo && !isValidImageUpload(logo)) {
            return res.status(400).json({ message: `Logo must be an image (png/jpeg/webp/gif) under 5MB.` });
         }
         await db.update(election).set(data).where(eq(election.id, id));
         const updated = await db.query.election.findFirst({ where: eq(election.id, id) });

         if (updated) {
            if (logo) {
               const dest = path.join(__dirname, "/../../public/cdn/photo/evs/", `${id}.png`);
               fs.mkdirSync(path.dirname(dest), { recursive: true });
               logo.mv(dest, (err: any) => err && console.log(err));
            }
            res.status(200).json(updated);
         } else {
            res.status(204).json({ message: `No records found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async deleteElection(req: Request, res: Response) {
      try {
         const id = Number(paramStr(req.params.id));
         const [resp] = await db.delete(election).where(eq(election.id, id));
         resp ? res.status(200).json(resp) : res.status(204).json({ message: `No records found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async actionReset(req: Request, res: Response) {
      try {
         const { electionId } = req.body;
         const eid = Number(electionId);

         await db.transaction(async (tx) => {
            await tx.update(candidate)
               .set({ votes: 0 })
               .where(
                  inArray(
                     candidate.portfolioId,
                     tx.select({ id: portfolio.id }).from(portfolio).where(eq(portfolio.electionId, eid))
                  )
               );

            // Delete Electors
            await tx.delete(elector).where(eq(elector.electionId, eid));
         });

         res.status(200).json({ success: true });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async actionAdmin(req: Request, res: Response) {
      try {
         const { tag, electionId } = req.body;
         const eid = Number(electionId);
         const electionRes = await db.query.election.findFirst({ where: eq(election.id, eid) });

         if (electionRes) {
            const admins = (electionRes.admins as string[]) || [];
            const exists = admins.find((r: any) => r?.toLowerCase() === tag?.toLowerCase());
            const newAdmins = exists
               ? admins.filter((r: any) => r?.toLowerCase() !== tag?.toLowerCase())
               : [...admins, tag];

            const [resp] = await db.update(election)
               .set({ admins: newAdmins })
               .where(eq(election.id, eid));

            return resp ? res.status(200).json(resp) : res.status(202).json({ message: `No record found!` });
         }
         return res.status(202).json({ message: `Election not staged!` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   // Voters & Votes
   async postVotes(req: Request, res: Response) {
      try {
         const result = await db.transaction(async (tx) => {
            let { id, votes } = req.body;
            // The voter's identity comes from the verified JWT (req.userId),
            // never from the request body — trusting a client-supplied tag
            // would let any authenticated user cast a vote as anyone else.
            const tag = (req as any).userId;
            const ip = req.headers['x-forwarded-for'] ? Array.isArray(req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'][0] : (req.headers['x-forwarded-for'] as string).split(',')[0] : req.socket.remoteAddress;

            const eid = Number(id);
            if (!tag || !id) throw new Error(`Request user or ID not found`);

            // Check if elector is in voterData JSON array
            const [en] = await tx.select().from(election).where(
               and(
                  eq(election.id, eid),
                  eq(election.status, 1),
                  sql`JSON_CONTAINS(${election.voterData}, JSON_OBJECT('tag', ${tag}))`
               )
            );
            if (!en) throw new Error(`Elector not qualified!`);

            const ev = await tx.query.elector.findFirst({
               where: and(eq(elector.electionId, eid), eq(elector.tag, tag))
            });
            if (ev) throw new Error(`Elector already voted`);

            const isGracePeriod = en.action === 'ENDED' && moment().diff(moment(en.endAt), 'seconds') <= 120;
            if (en.status && (en.action === 'STARTED' || isGracePeriod)) {

               if (!votes?.length) throw new Error(`Votes invalid!`);

               // Submitted candidate IDs must actually belong to this
               // election — without this check, any voter eligible for *any*
               // open election could submit candidate IDs from a different
               // election (or an arbitrary ID) and inflate/deflate those
               // vote counts, since the update below matched purely on
               // candidate.id with no scoping to eid.
               const votedIds = votes.map((cid: number) => Number(cid));
               const electionPortfolios = await tx.query.portfolio.findMany({ where: eq(portfolio.electionId, eid), columns: { id: true } });
               const electionCandidates = await tx.query.candidate.findMany({ where: inArray(candidate.portfolioId, electionPortfolios.map((p: any) => p.id)), columns: { id: true } });
               const validCandidateIds = new Set(electionCandidates.map((c: any) => c.id));
               if (votedIds.some((cid: number) => !validCandidateIds.has(cid))) throw new Error(`Votes invalid!`);

               //# Increment candidate votes
               const cs = await tx.update(candidate).set({ votes: sql`${candidate.votes} + 1` }).where(inArray(candidate.id, votedIds));
               const vs = (en.voterData as any[])?.find((r: any) => r.tag === tag);
               const data: any = {
                  voteStatus: true,
                  voteSum: votes.join(","),
                  // elector.voteTime is a `timestamp()` column with no
                  // `mode: 'string'` override, so drizzle expects a Date
                  // object (it calls .toISOString() on whatever's passed) —
                  // a formatted string here throws at insert time.
                  voteTime: new Date(),
                  voteIp: ip,
                  name: vs?.name,
                  tag,
                  electionId: eid
               }

               const [electorRes] = await tx.insert(elector).values(data);
               const newElector = await tx.query.elector.findFirst({ where: eq(elector.id, Number(electorRes.insertId)) });

               // Handle Socket Broadcast — a delta (updated tallies + turnout
               // count), not the full elector list. That used to be a
               // `select()` of every column for every registered voter (tag,
               // name, IP, vote time) refetched and rebroadcast on *every
               // single vote* — expensive, and it re-leaked PII that's
               // deliberately stripped everywhere else in this file (see
               // fetchVotes/fetchElection) through a channel with no
               // per-recipient scoping.
               const allPortfolios = await db.query.portfolio.findMany({
                  where: eq(portfolio.electionId, eid),
                  with: {
                     candidate: {
                        where: eq(candidate.status, 1),
                        with: { portfolio: true },
                        orderBy: [desc(candidate.votes), asc(candidate.orderNo)]
                     }
                  }
               });

               const turnoutResult = await db.select({ value: count() }).from(elector).where(eq(elector.electionId, eid));
               const turnout = turnoutResult[0]?.value ?? 0;

               if (req.app?.locals?.broadcastElection) {
                  req.app.locals.broadcastElection(eid, { election: en, portfolio: allPortfolios, turnout });
               }

               return newElector;
            } else {
               throw new Error(`Election is closed!`);
            }
         });

         res.status(200).json(result);
      } catch (error: any) {
         console.log(error)
         return res.status(203).json({ message: error.message });
      }
   }

   async fetchVotes(req: Request, res: Response) {
      try {
         const eid = Number(paramStr(req.params.id));

         const electionRes = await db.query.election.findFirst({ where: eq(election.id, eid) });
         let portfolios: any = await db.query.portfolio.findMany({
            where: eq(portfolio.electionId, eid),
            with: {
               candidate: {
                  where: eq(candidate.status, 1),
                  with: { portfolio: true },
                  orderBy: [desc(candidate.votes), asc(candidate.orderNo)]
               }
            }
         });
         portfolios = portfolios.map((r: any) => ({ ...r, candidates: r.candidate }));

         if (electionRes && portfolios) {
            const turnoutResult = await db.select({ value: count() }).from(elector).where(eq(elector.electionId, eid));
            const turnout = turnoutResult[0]?.value ?? 0;
            const voterCount = (electionRes.voterData as any[] | null)?.length || 0;

            // Per-elector detail (name, exact vote, IP) breaks ballot
            // secrecy if shown to non-admins, and election.voterData carries
            // every voter's username/pin (from setupVoters) — neither
            // belongs in a response any authenticated user can request, so
            // both are stripped down to counts unless the caller is an
            // admin for this election.
            const isAdmin = await isElectionAdmin(req, eid);
            const payload: any = {
               election: { ...electionRes, voterData: isAdmin ? electionRes.voterData : undefined },
               portfolios,
               turnout,
               voterCount,
            };
            if (isAdmin) {
               payload.electors = await db.select().from(elector).where(eq(elector.electionId, eid));
            }
            res.status(200).json(payload);
         } else {
            res.status(204).json({ message: `no records found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchVoters(req: Request, res: Response) {
      try {
         const resp = await db.query.election.findFirst({
            where: eq(election.id, Number(paramStr(req.params.id))),
            columns: { voterData: true }
         });
         resp ? res.status(200).json(resp.voterData) : res.status(204).json({ message: `no record found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchVoter(req: Request, res: Response) {
      try {
         const tag = paramStr(req.params.tag);
         const id = Number(paramStr(req.params.id));

         // A voter may look up their own status; anything about another
         // voter (including their username/pin, still on voterData from
         // setupVoters) requires being an admin for this election.
         const isSelf = tag?.toLowerCase() === (req as any).userId?.toLowerCase();
         const isAdmin = isSelf ? true : await isElectionAdmin(req, id);
         if (!isSelf && !isAdmin) {
            return res.status(403).json({ message: `You do not have permission to perform this action.` });
         }

         const resp = await db.query.election.findFirst({
            where: eq(election.id, id),
         });

         if (resp) {
            const voterData = (resp.voterData as any[]) || [];
            const found = voterData.find((r: any) => r.tag == tag);

            // Check Vote Status
            const vs = await db.query.elector.findFirst({
               where: and(eq(elector.electionId, id), eq(elector.tag, tag))
            });

            const voter = isAdmin ? found : found && { tag: found.tag, name: found.name };
            res.status(200).json({ ...resp, voterData: undefined, voter, voteStatus: !!vs });
         } else {
            res.status(204).json({ message: `no record found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async setupVoters(req: Request, res: Response) {
      try {
         const eid = Number(req.body.electionId);
         const en = await db.query.election.findFirst({
            where: eq(election.id, eid),
            columns: { voterList: true, groupId: true }
         });

         if (en && (en.voterList as any[])?.length) {
            const list = en.voterList as any[];
            const voters = await Promise.all(list.map(async (r: any) => {
               let ts: any;
               if (en.groupId === 1) {
                  ts = await db.query.student.findFirst({
                     where: eq(student.id, r),
                     columns: { fname: true, mname: true, lname: true, id: true, phone: true }
                  });
               } else {
                  ts = await db.query.staff.findFirst({
                     where: eq(staff.staffNo, r),
                     columns: { fname: true, mname: true, lname: true, staffNo: true, phone: true }
                  });
               }

               const us = await db.query.user.findFirst({ where: eq(user.tag, r) });

               return {
                  tag: ts?.id || ts?.staffNo,
                  name: `${ts?.fname} ${ts?.mname ? ts?.mname + ' ' : ''}${ts?.lname}`,
                  username: us?.username,
                  pin: us?.unlockPin,
                  phone: ts?.phone
               };
            }));

            const [updated] = await db.update(election)
               .set({ voterData: voters })
               .where(eq(election.id, eid));

            return res.status(200).json(updated);
         }
         return res.status(202).json({ message: `Voter register not populated` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async postVoter(req: Request, res: Response) {
      try {
         const { tag, name } = req.body;
         const id = Number(paramStr(req.params.id));
         const [resp] = await db.update(election)
            .set({
               voterData: sql`JSON_ARRAY_APPEND(COALESCE(${election.voterData}, '[]'), '$', CAST(${JSON.stringify({ tag, name })} AS JSON))`
            })
            .where(eq(election.id, id));
         resp ? res.status(200).json(resp) : res.status(204).json({ message: `no record found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async deleteVoter(req: Request, res: Response) {
      try {
         const tag = paramStr(req.params.tag);
         const id = Number(paramStr(req.params.id));
         const en = await db.query.election.findFirst({ where: eq(election.id, id) });
         if (en) {
            const currentVoters = (en.voterData as any[]) || [];
            const newVoters = currentVoters.filter((v: any) => v.tag !== tag);
            const [resp] = await db.update(election)
               .set({ voterData: newVoters })
               .where(eq(election.id, id));
            res.status(200).json(resp);
         } else {
            res.status(204).json({ message: `no record found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchReceipt(req: Request, res: Response) {
      try {
         const tag = paramStr(req.params.tag);
         const id = paramStr(req.params.id);

         // A receipt names exactly who voted for whom — only that voter, or
         // an admin for this election, may read it.
         const isSelf = tag?.toLowerCase() === (req as any).userId?.toLowerCase();
         if (!isSelf && !(await isElectionAdmin(req, Number(id)))) {
            return res.status(403).json({ message: `You do not have permission to perform this action.` });
         }

         const resp = await db.query.elector.findFirst({
            where: and(eq(elector.tag, tag), eq(elector.electionId, Number(id)))
         });
         resp ? res.status(200).json(resp) : res.status(204).json({ message: `no record found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchPortfolios(req: Request, res: Response) {
      try {
         const resp = await db.query.portfolio.findMany({
            where: eq(portfolio.electionId, Number(paramStr(req.params.id))),
            with: {
               election: true,
               candidate: true,
            }
         });

         if (resp?.length) {
            const formatted = resp?.map(p => ({
               ...p,
               _count: { candidate: p?.candidate?.length }
            }));
            res.status(200).json(formatted);
         } else {
            res.status(204).json({ message: `no records found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchPortfolioList(req: Request, res: Response) {
      try {
         const resp = await db.query.portfolio.findMany({
            where: and(eq(portfolio.status, true), eq(portfolio.electionId, Number(req.query.electionId)))
         });
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchPortfolio(req: Request, res: Response) {
      try {
         const resp = await db.query.portfolio.findFirst({
            where: eq(portfolio.id, Number(paramStr(req.params.id))),
            extras: {
               // Replicates Prisma's _count: { candidate: true }
               candidateCount: sql<number>`(
                  SELECT count(*) FROM ${candidate} 
                  WHERE ${candidate.portfolioId} = ${portfolio.id}
               )`.as('candidate_count'),
            },
         });
         resp ? res.status(200).json(resp) : res.status(204).json({ message: `no record found` });

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postPortfolio(req: Request, res: Response) {
      try {
         const [result] = await db.insert(portfolio).values(req.body);
         const insertId = result.insertId;

         if (insertId) {
            await db.insert(candidate).values({
               tag: 'Skip',
               name: 'No / Skip',
               votes: 0,
               orderNo: 0,
               status: true,
               portfolioId: insertId
            } as any);
            res.status(200).json(insertId);
         } else {
            res.status(204).json({ message: `no records found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async updatePortfolio(req: Request, res: Response) {
      try {
         const id = Number(paramStr(req.params.id));
         const [resp] = await db.update(portfolio)
            .set(req.body)
            .where(eq(portfolio.id, id));

         resp ? res.status(200).json(resp) : res.status(204).json({ message: `No records found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async deletePortfolio(req: Request, res: Response) {
      try {
         const id = Number(paramStr(req.params.id));
         await db.delete(candidate).where(eq(candidate.portfolioId, id));

         const [resp] = await db.delete(portfolio).where(eq(portfolio.id, id));
         resp ? res.status(200).json(resp) : res.status(204).json({ message: `No records found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   // Candidates
   async fetchCandidates(req: Request, res: Response) {
      try {
         const pid = Number(paramStr(req.params.id));
         const resp = await db.query.candidate.findMany({
            where: eq(candidate.portfolioId, pid),
            with: { portfolio: true },
            orderBy: [asc(candidate.orderNo)]
         });

         resp.length ? res.status(200).json(resp) : res.status(204).json({ message: `no records found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async fetchCandidate(req: Request, res: Response) {
      try {
         const resp = await db.query.candidate.findFirst({
            where: eq(candidate.id, Number(paramStr(req.params.id))),
            with: { portfolio: true }
         });
         resp ? res.status(200).json(resp) : res.status(204).json({ message: `no record found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async postCandidate(req: Request, res: Response) {
      try {
         const data = { ...req.body };
         delete data.photo;
         if (data.portfolioId) data.portfolioId = Number(data.portfolioId);
         if (data.orderNo) data.orderNo = Number(data.orderNo);

         // This never handled the uploaded photo at all — the candidate
         // record saved fine, but the file was silently dropped every time.
         const photo: any = req?.files?.photo;
         if (photo && !isValidImageUpload(photo)) {
            return res.status(400).json({ message: `Photo must be an image (png/jpeg/webp/gif) under 5MB.` });
         }
         const [resp] = await db.insert(candidate).values(data);
         if (resp?.insertId) {
            if (photo) {
               const created = await db.query.candidate.findFirst({
                  where: eq(candidate.id, resp.insertId),
                  with: { portfolio: true }
               });
               const eid = (created as any)?.portfolio?.electionId;
               const dest = path.join(__dirname, "/../../public/cdn/photo/evs/" + eid, `${resp.insertId}.jpg`);
               fs.mkdirSync(path.dirname(dest), { recursive: true });
               photo.mv(dest, (err: any) => err && console.log(err));
            }
            res.status(200).json(resp);
         } else {
            res.status(204).json({ message: `could not create candidate` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async updateCandidate(req: Request, res: Response) {
      try {
         const id = Number(paramStr(req.params.id));
         const data = { ...req.body };
         delete data.photo;
         const photo: any = req?.files?.photo;
         if (photo && !isValidImageUpload(photo)) {
            return res.status(400).json({ message: `Photo must be an image (png/jpeg/webp/gif) under 5MB.` });
         }
         const [resp] = await db.update(candidate)
            .set(data)
            .where(eq(candidate.id, id));

         if (resp) {
            if (photo) {
               const updated = await db.query.candidate.findFirst({
                  where: eq(candidate.id, id),
                  with: { portfolio: true }
               });
               const eid = (updated as any)?.portfolio?.electionId;
               const dest = path.join(__dirname, "/../../public/cdn/photo/evs/" + eid, `${id}.jpg`);
               fs.mkdirSync(path.dirname(dest), { recursive: true });
               photo.mv(dest, (err: any) => err && console.log(err));
            }
            res.status(200).json(resp);
         } else {
            res.status(204).json({ message: `No records found` });
         }
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   async deleteCandidate(req: Request, res: Response) {
      try {
         const [resp] = await db.delete(candidate)
            .where(eq(candidate.id, Number(paramStr(req.params.id))));
         resp ? res.status(200).json(resp) : res.status(204).json({ message: `No records found` });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }

   // Lets the frontend mirror requireElectionAdmin's own two-tier check
   // (platform `election::admin` role OR listed in this election's
   // `admins`) so UI gating (show/hide Add/Edit buttons) matches what the
   // backend will actually accept, instead of checking the platform role
   // alone and hiding those actions from legitimate per-election admins.
   async checkElectionAdmin(req: Request, res: Response) {
      try {
         const eid = Number(paramStr(req.params.id));
         const admin = await isElectionAdmin(req, eid);
         res.status(200).json({ isAdmin: admin });
      } catch (error: any) {
         return res.status(500).json({ message: error.message });
      }
   }


}
