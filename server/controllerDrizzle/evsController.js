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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const drizzle_orm_1 = require("drizzle-orm");
const fs_1 = __importDefault(require("fs"));
const moment_1 = __importDefault(require("moment"));
const path_1 = __importDefault(require("path"));
const mysqlAdapter_1 = require("../drizzle/mysqlAdapter");
const schema_1 = require("../drizzle/schema"); // Your schema definitions
const paramStr_1 = require("../util/paramStr");
const { isElectionAdmin } = require("../middleware/requireElectionAdmin");
// voterData carries every voter's username/pin/phone (from setupVoters) —
// strip it down to {tag, name} for any response that isn't admin-scoped,
// since that's all list/card views need (turnout is reported separately).
// Plain function rather than a class method: controller methods are passed
// to Express as bare callbacks (`this.controller.fetchElections`), so `this`
// is undefined when they run — a class method here would throw the same way.
function stripVoterData(voterData) {
    return (voterData || []).map((r) => ({ tag: r === null || r === void 0 ? void 0 : r.tag, name: r === null || r === void 0 ? void 0 : r.name }));
}
// Candidate photos and election logos land in a publicly-served static
// folder — the client already checks `type.match("image.*")`, but that's
// trivially bypassed by calling the API directly, so it isn't a real
// control on its own. Re-check server-side before ever writing the file.
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB
function isValidImageUpload(file) {
    return !!file && ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype) && file.size > 0 && file.size <= MAX_IMAGE_UPLOAD_BYTES;
}
class EvsController {
    // Elections
    fetchAdminElections(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const limit = Number(pageSize);
            const offset = (Number(page) - 1) * limit;
            try {
                const searchFilter = keyword ? (0, drizzle_orm_1.or)((0, drizzle_orm_1.like)(schema_1.election.title, `%${keyword}%`)) : undefined;
                const [totalCount, data] = yield mysqlAdapter_1.db.transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                    // const countResult = await tx.select({ value: count() }).from(election).where(searchFilter);
                    const countResult = yield tx.$count(schema_1.election, searchFilter);
                    const items = yield tx.query.election.findMany({
                        where: searchFilter,
                        with: { group: true },
                        limit: limit,
                        offset: offset,
                        orderBy: [(0, drizzle_orm_1.desc)(schema_1.election.createdAt)]
                    });
                    // return [countResult[0].value, items];
                    return [countResult, items];
                }));
                if (data.length) {
                    res.status(200).json({
                        totalPages: Math.ceil(totalCount / limit),
                        totalData: data.length,
                        data: data,
                    });
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.error(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchElections(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield mysqlAdapter_1.db.query.election.findMany({
                    where: (0, drizzle_orm_1.eq)(schema_1.election.status, 1),
                    orderBy: [(0, drizzle_orm_1.desc)(schema_1.election.createdAt)]
                });
                const data = resp.map((r) => (Object.assign(Object.assign({}, r), { voterData: stripVoterData(r.voterData) })));
                data.length ? res.status(200).json(data) : res.status(204).json({ message: `no record found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchMyElections(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                // "My" elections means the caller's own — identity comes from the
                // verified JWT, not the URL, otherwise anyone could pass another
                // user's tag and see who they're registered/admin for and every
                // vote cast in that election (via the old unfiltered `voters` field).
                const tag = req.userId;
                if (!tag || tag.toLowerCase() !== ((_a = (0, paramStr_1.paramStr)(req.params.tag)) === null || _a === void 0 ? void 0 : _a.toLowerCase())) {
                    return res.status(403).json({ message: `You do not have permission to perform this action.` });
                }
                const en = yield mysqlAdapter_1.db.select().from(schema_1.election).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.election.status, 1), (0, drizzle_orm_1.or)((0, drizzle_orm_1.sql) `JSON_CONTAINS(${schema_1.election.voterData}, JSON_OBJECT('tag', ${tag}))`, (0, drizzle_orm_1.sql) `JSON_CONTAINS(${schema_1.election.admins}, JSON_QUOTE(${tag}))`)));
                if (en.length) {
                    // One query for elector rows across every matching election,
                    // rather than a turnout count() + a findFirst per election (was
                    // 2 extra round-trips per election).
                    const electionIds = en.map((r) => r.id);
                    const allElectors = yield mysqlAdapter_1.db.select({ electionId: schema_1.elector.electionId, tag: schema_1.elector.tag }).from(schema_1.elector).where((0, drizzle_orm_1.inArray)(schema_1.elector.electionId, electionIds));
                    const turnoutByElection = new Map();
                    const votedElectionIds = new Set();
                    for (const row of allElectors) {
                        turnoutByElection.set(row.electionId, (turnoutByElection.get(row.electionId) || 0) + 1);
                        if (row.tag === tag)
                            votedElectionIds.add(row.electionId);
                    }
                    const resp = yield Promise.all(en.map((r) => __awaiter(this, void 0, void 0, function* () {
                        const isAdmin = yield isElectionAdmin(req, r.id);
                        return Object.assign(Object.assign({}, r), { voterData: isAdmin ? r.voterData : stripVoterData(r.voterData), turnout: turnoutByElection.get(r.id) || 0, voteStatus: votedElectionIds.has(r.id) });
                    })));
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `no record found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchElection(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                const resp = yield mysqlAdapter_1.db.query.election.findFirst({
                    where: (0, drizzle_orm_1.eq)(schema_1.election.id, id),
                    with: { group: true },
                });
                if (resp) {
                    const tsResult = yield mysqlAdapter_1.db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_1.elector).where((0, drizzle_orm_1.eq)(schema_1.elector.electionId, id));
                    const turnout = tsResult[0].value;
                    // voterData entries carry username/pin/phone (populated by
                    // setupVoters for SMS delivery at registration time) — only an
                    // election admin should ever see those again; everyone else
                    // gets just enough to render the voters register (tag/name/status).
                    const isAdmin = yield isElectionAdmin(req, id);
                    const voterData = resp.voterData;
                    // One query for every elector row in this election, rather than
                    // one findFirst per registered voter (was N+1 — an election
                    // with hundreds/thousands of voters meant that many round-trips).
                    const electorRows = (voterData === null || voterData === void 0 ? void 0 : voterData.length)
                        ? yield mysqlAdapter_1.db.select({ tag: schema_1.elector.tag }).from(schema_1.elector).where((0, drizzle_orm_1.eq)(schema_1.elector.electionId, id))
                        : [];
                    const votedTags = new Set(electorRows.map((r) => r.tag));
                    const tm = voterData === null || voterData === void 0 ? void 0 : voterData.map((r) => {
                        const voteStatus = votedTags.has(r === null || r === void 0 ? void 0 : r.tag);
                        return isAdmin ? Object.assign(Object.assign({}, r), { voteStatus }) : { tag: r === null || r === void 0 ? void 0 : r.tag, name: r === null || r === void 0 ? void 0 : r.name, voteStatus };
                    });
                    res.status(200).json(Object.assign(Object.assign({}, resp), { voterData: tm, turnout }));
                }
                else {
                    res.status(204).json({ message: `no record found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postElection(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                let data = Object.assign({}, req.body);
                delete data.logo;
                if (data.startAt)
                    data.startAt = new Date(data.startAt);
                if (data.endAt)
                    data.endAt = new Date(data.endAt);
                if (data.groupId)
                    data.groupId = Number(data.groupId);
                if (data.voterList)
                    data.voterList = JSON.parse(data.voterList);
                const booleanFields = ['status', 'allowMonitor', 'allowVip', 'allowResult', 'allowMask', 'allowEcMonitor', 'allowEcVip', 'allowEcResult', 'autoStop'];
                booleanFields.forEach(field => {
                    if (data[field] !== undefined)
                        data[field] = Boolean(Number(data[field]));
                });
                const logo = (_a = req === null || req === void 0 ? void 0 : req.files) === null || _a === void 0 ? void 0 : _a.logo;
                if (logo && !isValidImageUpload(logo)) {
                    return res.status(400).json({ message: `Logo must be an image (png/jpeg/webp/gif) under 5MB.` });
                }
                const [newElection] = yield mysqlAdapter_1.db.insert(schema_1.election).values(data);
                if (newElection) {
                    // Candidate photos for this election are stored under
                    // public/cdn/photo/evs/{electionId}/ — this used to create a
                    // same-named-but-wrong public/cdn/evs/{electionId}/ folder
                    // instead, so that directory never existed and candidate photo
                    // uploads silently failed (express-fileupload's .mv() errors on
                    // a missing target dir, but the error was only console.log'd).
                    const folderPath = path_1.default.join(__dirname, "/../../public/cdn/photo/evs", String(newElection.insertId));
                    if (!fs_1.default.existsSync(folderPath))
                        fs_1.default.mkdirSync(folderPath, { recursive: true });
                    if (logo) {
                        const dest = path_1.default.join(__dirname, "/../../public/cdn/photo/evs/", `${newElection.insertId}.png`);
                        logo.mv(dest, (err) => err && console.log(err));
                    }
                    res.status(200).json(newElection);
                }
            }
            catch (error) {
                console.log(error);
                // return res.status(500).json({ message: error.message });
            }
        });
    }
    updateElection(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                let data = Object.assign({}, req.body);
                delete data.logo;
                if (data.startAt)
                    data.startAt = new Date(data.startAt);
                if (data.endAt)
                    data.endAt = new Date(data.endAt);
                if (data.groupId)
                    data.groupId = Number(data.groupId);
                if (data.voterList)
                    data.voterList = JSON.parse(data.voterList);
                const booleanFields = ['status', 'allowMonitor', 'allowVip', 'allowResult', 'allowMask', 'allowEcMonitor', 'allowEcVip', 'allowEcResult', 'autoStop'];
                booleanFields.forEach(field => {
                    if (data[field] !== undefined)
                        data[field] = Boolean(Number(data[field]));
                });
                const logo = (_a = req === null || req === void 0 ? void 0 : req.files) === null || _a === void 0 ? void 0 : _a.logo;
                if (logo && !isValidImageUpload(logo)) {
                    return res.status(400).json({ message: `Logo must be an image (png/jpeg/webp/gif) under 5MB.` });
                }
                yield mysqlAdapter_1.db.update(schema_1.election).set(data).where((0, drizzle_orm_1.eq)(schema_1.election.id, id));
                const updated = yield mysqlAdapter_1.db.query.election.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.election.id, id) });
                if (updated) {
                    if (logo) {
                        const dest = path_1.default.join(__dirname, "/../../public/cdn/photo/evs/", `${id}.png`);
                        fs_1.default.mkdirSync(path_1.default.dirname(dest), { recursive: true });
                        logo.mv(dest, (err) => err && console.log(err));
                    }
                    res.status(200).json(updated);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteElection(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                const [resp] = yield mysqlAdapter_1.db.delete(schema_1.election).where((0, drizzle_orm_1.eq)(schema_1.election.id, id));
                resp ? res.status(200).json(resp) : res.status(204).json({ message: `No records found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    actionReset(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { electionId } = req.body;
                const eid = Number(electionId);
                yield mysqlAdapter_1.db.transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                    yield tx.update(schema_1.candidate)
                        .set({ votes: 0 })
                        .where((0, drizzle_orm_1.inArray)(schema_1.candidate.portfolioId, tx.select({ id: schema_1.portfolio.id }).from(schema_1.portfolio).where((0, drizzle_orm_1.eq)(schema_1.portfolio.electionId, eid))));
                    // Delete Electors
                    yield tx.delete(schema_1.elector).where((0, drizzle_orm_1.eq)(schema_1.elector.electionId, eid));
                }));
                res.status(200).json({ success: true });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    actionAdmin(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { tag, electionId } = req.body;
                const eid = Number(electionId);
                const electionRes = yield mysqlAdapter_1.db.query.election.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.election.id, eid) });
                if (electionRes) {
                    const admins = electionRes.admins || [];
                    const exists = admins.find((r) => (r === null || r === void 0 ? void 0 : r.toLowerCase()) === (tag === null || tag === void 0 ? void 0 : tag.toLowerCase()));
                    const newAdmins = exists
                        ? admins.filter((r) => (r === null || r === void 0 ? void 0 : r.toLowerCase()) !== (tag === null || tag === void 0 ? void 0 : tag.toLowerCase()))
                        : [...admins, tag];
                    const [resp] = yield mysqlAdapter_1.db.update(schema_1.election)
                        .set({ admins: newAdmins })
                        .where((0, drizzle_orm_1.eq)(schema_1.election.id, eid));
                    return resp ? res.status(200).json(resp) : res.status(202).json({ message: `No record found!` });
                }
                return res.status(202).json({ message: `Election not staged!` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // Voters & Votes
    postVotes(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const result = yield mysqlAdapter_1.db.transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                    var _a, _b, _c, _d, _e;
                    let { id, votes } = req.body;
                    // The voter's identity comes from the verified JWT (req.userId),
                    // never from the request body — trusting a client-supplied tag
                    // would let any authenticated user cast a vote as anyone else.
                    const tag = req.userId;
                    const ip = req.headers['x-forwarded-for'] ? Array.isArray(req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'][0] : req.headers['x-forwarded-for'].split(',')[0] : req.socket.remoteAddress;
                    const eid = Number(id);
                    if (!tag || !id)
                        throw new Error(`Request user or ID not found`);
                    // Check if elector is in voterData JSON array
                    const [en] = yield tx.select().from(schema_1.election).where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.election.id, eid), (0, drizzle_orm_1.eq)(schema_1.election.status, 1), (0, drizzle_orm_1.sql) `JSON_CONTAINS(${schema_1.election.voterData}, JSON_OBJECT('tag', ${tag}))`));
                    if (!en)
                        throw new Error(`Elector not qualified!`);
                    const ev = yield tx.query.elector.findFirst({
                        where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.elector.electionId, eid), (0, drizzle_orm_1.eq)(schema_1.elector.tag, tag))
                    });
                    if (ev)
                        throw new Error(`Elector already voted`);
                    const isGracePeriod = en.action === 'ENDED' && (0, moment_1.default)().diff((0, moment_1.default)(en.endAt), 'seconds') <= 120;
                    if (en.status && (en.action === 'STARTED' || isGracePeriod)) {
                        if (!(votes === null || votes === void 0 ? void 0 : votes.length))
                            throw new Error(`Votes invalid!`);
                        // Submitted candidate IDs must actually belong to this
                        // election — without this check, any voter eligible for *any*
                        // open election could submit candidate IDs from a different
                        // election (or an arbitrary ID) and inflate/deflate those
                        // vote counts, since the update below matched purely on
                        // candidate.id with no scoping to eid.
                        const votedIds = votes.map((cid) => Number(cid));
                        const electionPortfolios = yield tx.query.portfolio.findMany({ where: (0, drizzle_orm_1.eq)(schema_1.portfolio.electionId, eid), columns: { id: true } });
                        const electionCandidates = yield tx.query.candidate.findMany({ where: (0, drizzle_orm_1.inArray)(schema_1.candidate.portfolioId, electionPortfolios.map((p) => p.id)), columns: { id: true } });
                        const validCandidateIds = new Set(electionCandidates.map((c) => c.id));
                        if (votedIds.some((cid) => !validCandidateIds.has(cid)))
                            throw new Error(`Votes invalid!`);
                        //# Increment candidate votes
                        const cs = yield tx.update(schema_1.candidate).set({ votes: (0, drizzle_orm_1.sql) `${schema_1.candidate.votes} + 1` }).where((0, drizzle_orm_1.inArray)(schema_1.candidate.id, votedIds));
                        const vs = (_a = en.voterData) === null || _a === void 0 ? void 0 : _a.find((r) => r.tag === tag);
                        const data = {
                            voteStatus: true,
                            voteSum: votes.join(","),
                            // elector.voteTime is a `timestamp()` column with no
                            // `mode: 'string'` override, so drizzle expects a Date
                            // object (it calls .toISOString() on whatever's passed) —
                            // a formatted string here throws at insert time.
                            voteTime: new Date(),
                            voteIp: ip,
                            name: vs === null || vs === void 0 ? void 0 : vs.name,
                            tag,
                            electionId: eid
                        };
                        const [electorRes] = yield tx.insert(schema_1.elector).values(data);
                        const newElector = yield tx.query.elector.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.elector.id, Number(electorRes.insertId)) });
                        // Handle Socket Broadcast — a delta (updated tallies + turnout
                        // count), not the full elector list. That used to be a
                        // `select()` of every column for every registered voter (tag,
                        // name, IP, vote time) refetched and rebroadcast on *every
                        // single vote* — expensive, and it re-leaked PII that's
                        // deliberately stripped everywhere else in this file (see
                        // fetchVotes/fetchElection) through a channel with no
                        // per-recipient scoping.
                        const allPortfolios = yield mysqlAdapter_1.db.query.portfolio.findMany({
                            where: (0, drizzle_orm_1.eq)(schema_1.portfolio.electionId, eid),
                            with: {
                                candidate: {
                                    where: (0, drizzle_orm_1.eq)(schema_1.candidate.status, 1),
                                    with: { portfolio: true },
                                    orderBy: [(0, drizzle_orm_1.desc)(schema_1.candidate.votes), (0, drizzle_orm_1.asc)(schema_1.candidate.orderNo)]
                                }
                            }
                        });
                        const turnoutResult = yield mysqlAdapter_1.db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_1.elector).where((0, drizzle_orm_1.eq)(schema_1.elector.electionId, eid));
                        const turnout = (_c = (_b = turnoutResult[0]) === null || _b === void 0 ? void 0 : _b.value) !== null && _c !== void 0 ? _c : 0;
                        if ((_e = (_d = req.app) === null || _d === void 0 ? void 0 : _d.locals) === null || _e === void 0 ? void 0 : _e.broadcastElection) {
                            req.app.locals.broadcastElection(eid, { election: en, portfolio: allPortfolios, turnout });
                        }
                        return newElector;
                    }
                    else {
                        throw new Error(`Election is closed!`);
                    }
                }));
                res.status(200).json(result);
            }
            catch (error) {
                console.log(error);
                return res.status(203).json({ message: error.message });
            }
        });
    }
    fetchVotes(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            try {
                const eid = Number((0, paramStr_1.paramStr)(req.params.id));
                const electionRes = yield mysqlAdapter_1.db.query.election.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.election.id, eid) });
                let portfolios = yield mysqlAdapter_1.db.query.portfolio.findMany({
                    where: (0, drizzle_orm_1.eq)(schema_1.portfolio.electionId, eid),
                    with: {
                        candidate: {
                            where: (0, drizzle_orm_1.eq)(schema_1.candidate.status, 1),
                            with: { portfolio: true },
                            orderBy: [(0, drizzle_orm_1.desc)(schema_1.candidate.votes), (0, drizzle_orm_1.asc)(schema_1.candidate.orderNo)]
                        }
                    }
                });
                portfolios = portfolios.map((r) => (Object.assign(Object.assign({}, r), { candidates: r.candidate })));
                if (electionRes && portfolios) {
                    const turnoutResult = yield mysqlAdapter_1.db.select({ value: (0, drizzle_orm_1.count)() }).from(schema_1.elector).where((0, drizzle_orm_1.eq)(schema_1.elector.electionId, eid));
                    const turnout = (_b = (_a = turnoutResult[0]) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : 0;
                    const voterCount = ((_c = electionRes.voterData) === null || _c === void 0 ? void 0 : _c.length) || 0;
                    // Per-elector detail (name, exact vote, IP) breaks ballot
                    // secrecy if shown to non-admins, and election.voterData carries
                    // every voter's username/pin (from setupVoters) — neither
                    // belongs in a response any authenticated user can request, so
                    // both are stripped down to counts unless the caller is an
                    // admin for this election.
                    const isAdmin = yield isElectionAdmin(req, eid);
                    const payload = {
                        election: Object.assign(Object.assign({}, electionRes), { voterData: isAdmin ? electionRes.voterData : undefined }),
                        portfolios,
                        turnout,
                        voterCount,
                    };
                    if (isAdmin) {
                        payload.electors = yield mysqlAdapter_1.db.select().from(schema_1.elector).where((0, drizzle_orm_1.eq)(schema_1.elector.electionId, eid));
                    }
                    res.status(200).json(payload);
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchVoters(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield mysqlAdapter_1.db.query.election.findFirst({
                    where: (0, drizzle_orm_1.eq)(schema_1.election.id, Number((0, paramStr_1.paramStr)(req.params.id))),
                    columns: { voterData: true }
                });
                resp ? res.status(200).json(resp.voterData) : res.status(204).json({ message: `no record found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchVoter(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const tag = (0, paramStr_1.paramStr)(req.params.tag);
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                // A voter may look up their own status; anything about another
                // voter (including their username/pin, still on voterData from
                // setupVoters) requires being an admin for this election.
                const isSelf = (tag === null || tag === void 0 ? void 0 : tag.toLowerCase()) === ((_a = req.userId) === null || _a === void 0 ? void 0 : _a.toLowerCase());
                const isAdmin = isSelf ? true : yield isElectionAdmin(req, id);
                if (!isSelf && !isAdmin) {
                    return res.status(403).json({ message: `You do not have permission to perform this action.` });
                }
                const resp = yield mysqlAdapter_1.db.query.election.findFirst({
                    where: (0, drizzle_orm_1.eq)(schema_1.election.id, id),
                });
                if (resp) {
                    const voterData = resp.voterData || [];
                    const found = voterData.find((r) => r.tag == tag);
                    // Check Vote Status
                    const vs = yield mysqlAdapter_1.db.query.elector.findFirst({
                        where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.elector.electionId, id), (0, drizzle_orm_1.eq)(schema_1.elector.tag, tag))
                    });
                    const voter = isAdmin ? found : found && { tag: found.tag, name: found.name };
                    res.status(200).json(Object.assign(Object.assign({}, resp), { voterData: undefined, voter, voteStatus: !!vs }));
                }
                else {
                    res.status(204).json({ message: `no record found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    setupVoters(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const eid = Number(req.body.electionId);
                const en = yield mysqlAdapter_1.db.query.election.findFirst({
                    where: (0, drizzle_orm_1.eq)(schema_1.election.id, eid),
                    columns: { voterList: true, groupId: true }
                });
                if (en && ((_a = en.voterList) === null || _a === void 0 ? void 0 : _a.length)) {
                    const list = en.voterList;
                    const voters = yield Promise.all(list.map((r) => __awaiter(this, void 0, void 0, function* () {
                        let ts;
                        if (en.groupId === 1) {
                            ts = yield mysqlAdapter_1.db.query.student.findFirst({
                                where: (0, drizzle_orm_1.eq)(schema_1.student.id, r),
                                columns: { fname: true, mname: true, lname: true, id: true, phone: true }
                            });
                        }
                        else {
                            ts = yield mysqlAdapter_1.db.query.staff.findFirst({
                                where: (0, drizzle_orm_1.eq)(schema_1.staff.staffNo, r),
                                columns: { fname: true, mname: true, lname: true, staffNo: true, phone: true }
                            });
                        }
                        const us = yield mysqlAdapter_1.db.query.user.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.user.tag, r) });
                        return {
                            tag: (ts === null || ts === void 0 ? void 0 : ts.id) || (ts === null || ts === void 0 ? void 0 : ts.staffNo),
                            name: `${ts === null || ts === void 0 ? void 0 : ts.fname} ${(ts === null || ts === void 0 ? void 0 : ts.mname) ? (ts === null || ts === void 0 ? void 0 : ts.mname) + ' ' : ''}${ts === null || ts === void 0 ? void 0 : ts.lname}`,
                            username: us === null || us === void 0 ? void 0 : us.username,
                            pin: us === null || us === void 0 ? void 0 : us.unlockPin,
                            phone: ts === null || ts === void 0 ? void 0 : ts.phone
                        };
                    })));
                    const [updated] = yield mysqlAdapter_1.db.update(schema_1.election)
                        .set({ voterData: voters })
                        .where((0, drizzle_orm_1.eq)(schema_1.election.id, eid));
                    return res.status(200).json(updated);
                }
                return res.status(202).json({ message: `Voter register not populated` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postVoter(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { tag, name } = req.body;
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                const [resp] = yield mysqlAdapter_1.db.update(schema_1.election)
                    .set({
                    voterData: (0, drizzle_orm_1.sql) `JSON_ARRAY_APPEND(COALESCE(${schema_1.election.voterData}, '[]'), '$', CAST(${JSON.stringify({ tag, name })} AS JSON))`
                })
                    .where((0, drizzle_orm_1.eq)(schema_1.election.id, id));
                resp ? res.status(200).json(resp) : res.status(204).json({ message: `no record found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteVoter(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const tag = (0, paramStr_1.paramStr)(req.params.tag);
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                const en = yield mysqlAdapter_1.db.query.election.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.election.id, id) });
                if (en) {
                    const currentVoters = en.voterData || [];
                    const newVoters = currentVoters.filter((v) => v.tag !== tag);
                    const [resp] = yield mysqlAdapter_1.db.update(schema_1.election)
                        .set({ voterData: newVoters })
                        .where((0, drizzle_orm_1.eq)(schema_1.election.id, id));
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `no record found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchReceipt(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const tag = (0, paramStr_1.paramStr)(req.params.tag);
                const id = (0, paramStr_1.paramStr)(req.params.id);
                // A receipt names exactly who voted for whom — only that voter, or
                // an admin for this election, may read it.
                const isSelf = (tag === null || tag === void 0 ? void 0 : tag.toLowerCase()) === ((_a = req.userId) === null || _a === void 0 ? void 0 : _a.toLowerCase());
                if (!isSelf && !(yield isElectionAdmin(req, Number(id)))) {
                    return res.status(403).json({ message: `You do not have permission to perform this action.` });
                }
                const resp = yield mysqlAdapter_1.db.query.elector.findFirst({
                    where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.elector.tag, tag), (0, drizzle_orm_1.eq)(schema_1.elector.electionId, Number(id)))
                });
                resp ? res.status(200).json(resp) : res.status(204).json({ message: `no record found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchPortfolios(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield mysqlAdapter_1.db.query.portfolio.findMany({
                    where: (0, drizzle_orm_1.eq)(schema_1.portfolio.electionId, Number((0, paramStr_1.paramStr)(req.params.id))),
                    with: {
                        election: true,
                        candidate: true,
                    }
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    const formatted = resp === null || resp === void 0 ? void 0 : resp.map(p => {
                        var _a;
                        return (Object.assign(Object.assign({}, p), { _count: { candidate: (_a = p === null || p === void 0 ? void 0 : p.candidate) === null || _a === void 0 ? void 0 : _a.length } }));
                    });
                    res.status(200).json(formatted);
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchPortfolioList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield mysqlAdapter_1.db.query.portfolio.findMany({
                    where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.portfolio.status, true), (0, drizzle_orm_1.eq)(schema_1.portfolio.electionId, Number(req.query.electionId)))
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchPortfolio(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield mysqlAdapter_1.db.query.portfolio.findFirst({
                    where: (0, drizzle_orm_1.eq)(schema_1.portfolio.id, Number((0, paramStr_1.paramStr)(req.params.id))),
                    extras: {
                        // Replicates Prisma's _count: { candidate: true }
                        candidateCount: (0, drizzle_orm_1.sql) `(
                  SELECT count(*) FROM ${schema_1.candidate} 
                  WHERE ${schema_1.candidate.portfolioId} = ${schema_1.portfolio.id}
               )`.as('candidate_count'),
                    },
                });
                resp ? res.status(200).json(resp) : res.status(204).json({ message: `no record found` });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postPortfolio(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const [result] = yield mysqlAdapter_1.db.insert(schema_1.portfolio).values(req.body);
                const insertId = result.insertId;
                if (insertId) {
                    yield mysqlAdapter_1.db.insert(schema_1.candidate).values({
                        tag: 'Skip',
                        name: 'No / Skip',
                        votes: 0,
                        orderNo: 0,
                        status: true,
                        portfolioId: insertId
                    });
                    res.status(200).json(insertId);
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updatePortfolio(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                const [resp] = yield mysqlAdapter_1.db.update(schema_1.portfolio)
                    .set(req.body)
                    .where((0, drizzle_orm_1.eq)(schema_1.portfolio.id, id));
                resp ? res.status(200).json(resp) : res.status(204).json({ message: `No records found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deletePortfolio(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                yield mysqlAdapter_1.db.delete(schema_1.candidate).where((0, drizzle_orm_1.eq)(schema_1.candidate.portfolioId, id));
                const [resp] = yield mysqlAdapter_1.db.delete(schema_1.portfolio).where((0, drizzle_orm_1.eq)(schema_1.portfolio.id, id));
                resp ? res.status(200).json(resp) : res.status(204).json({ message: `No records found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // Candidates
    fetchCandidates(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const pid = Number((0, paramStr_1.paramStr)(req.params.id));
                const resp = yield mysqlAdapter_1.db.query.candidate.findMany({
                    where: (0, drizzle_orm_1.eq)(schema_1.candidate.portfolioId, pid),
                    with: { portfolio: true },
                    orderBy: [(0, drizzle_orm_1.asc)(schema_1.candidate.orderNo)]
                });
                resp.length ? res.status(200).json(resp) : res.status(204).json({ message: `no records found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchCandidate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield mysqlAdapter_1.db.query.candidate.findFirst({
                    where: (0, drizzle_orm_1.eq)(schema_1.candidate.id, Number((0, paramStr_1.paramStr)(req.params.id))),
                    with: { portfolio: true }
                });
                resp ? res.status(200).json(resp) : res.status(204).json({ message: `no record found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postCandidate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const data = Object.assign({}, req.body);
                delete data.photo;
                if (data.portfolioId)
                    data.portfolioId = Number(data.portfolioId);
                if (data.orderNo)
                    data.orderNo = Number(data.orderNo);
                // This never handled the uploaded photo at all — the candidate
                // record saved fine, but the file was silently dropped every time.
                const photo = (_a = req === null || req === void 0 ? void 0 : req.files) === null || _a === void 0 ? void 0 : _a.photo;
                if (photo && !isValidImageUpload(photo)) {
                    return res.status(400).json({ message: `Photo must be an image (png/jpeg/webp/gif) under 5MB.` });
                }
                const [resp] = yield mysqlAdapter_1.db.insert(schema_1.candidate).values(data);
                if (resp === null || resp === void 0 ? void 0 : resp.insertId) {
                    if (photo) {
                        const created = yield mysqlAdapter_1.db.query.candidate.findFirst({
                            where: (0, drizzle_orm_1.eq)(schema_1.candidate.id, resp.insertId),
                            with: { portfolio: true }
                        });
                        const eid = (_b = created === null || created === void 0 ? void 0 : created.portfolio) === null || _b === void 0 ? void 0 : _b.electionId;
                        const dest = path_1.default.join(__dirname, "/../../public/cdn/photo/evs/" + eid, `${resp.insertId}.jpg`);
                        fs_1.default.mkdirSync(path_1.default.dirname(dest), { recursive: true });
                        photo.mv(dest, (err) => err && console.log(err));
                    }
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `could not create candidate` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateCandidate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const id = Number((0, paramStr_1.paramStr)(req.params.id));
                const data = Object.assign({}, req.body);
                delete data.photo;
                const photo = (_a = req === null || req === void 0 ? void 0 : req.files) === null || _a === void 0 ? void 0 : _a.photo;
                if (photo && !isValidImageUpload(photo)) {
                    return res.status(400).json({ message: `Photo must be an image (png/jpeg/webp/gif) under 5MB.` });
                }
                const [resp] = yield mysqlAdapter_1.db.update(schema_1.candidate)
                    .set(data)
                    .where((0, drizzle_orm_1.eq)(schema_1.candidate.id, id));
                if (resp) {
                    if (photo) {
                        const updated = yield mysqlAdapter_1.db.query.candidate.findFirst({
                            where: (0, drizzle_orm_1.eq)(schema_1.candidate.id, id),
                            with: { portfolio: true }
                        });
                        const eid = (_b = updated === null || updated === void 0 ? void 0 : updated.portfolio) === null || _b === void 0 ? void 0 : _b.electionId;
                        const dest = path_1.default.join(__dirname, "/../../public/cdn/photo/evs/" + eid, `${id}.jpg`);
                        fs_1.default.mkdirSync(path_1.default.dirname(dest), { recursive: true });
                        photo.mv(dest, (err) => err && console.log(err));
                    }
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteCandidate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const [resp] = yield mysqlAdapter_1.db.delete(schema_1.candidate)
                    .where((0, drizzle_orm_1.eq)(schema_1.candidate.id, Number((0, paramStr_1.paramStr)(req.params.id))));
                resp ? res.status(200).json(resp) : res.status(204).json({ message: `No records found` });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // Lets the frontend mirror requireElectionAdmin's own two-tier check
    // (platform `election::admin` role OR listed in this election's
    // `admins`) so UI gating (show/hide Add/Edit buttons) matches what the
    // backend will actually accept, instead of checking the platform role
    // alone and hiding those actions from legitimate per-election admins.
    checkElectionAdmin(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const eid = Number((0, paramStr_1.paramStr)(req.params.id));
                const admin = yield isElectionAdmin(req, eid);
                res.status(200).json({ isAdmin: admin });
            }
            catch (error) {
                return res.status(500).json({ message: error.message });
            }
        });
    }
}
exports.default = EvsController;
