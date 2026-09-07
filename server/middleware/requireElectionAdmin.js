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
const drizzle_orm_1 = require("drizzle-orm");
const mysqlAdapter_1 = require("../drizzle/mysqlAdapter");
const schema_1 = require("../drizzle/schema");
// Elections have two admin tiers: the platform-wide `election::admin` role
// (from the JWT, via verifyToken) manages the whole module, while
// `election.admins` is a per-election JSON array of user tags (toggled via
// actionAdmin) scoped to operating just that one election. Either qualifies
// for per-election actions; only the platform role qualifies for actions
// that affect the module globally (creating/deleting elections, granting
// per-election admin rights) — those routes use requireRole directly instead
// of this helper.
function isElectionAdmin(req, electionId) {
    return __awaiter(this, void 0, void 0, function* () {
        const held = (req.roles || []).map((r) => r === null || r === void 0 ? void 0 : r.role);
        if (held.includes('election::admin'))
            return true;
        if (!electionId)
            return false;
        const en = yield mysqlAdapter_1.db.query.election.findFirst({
            where: (0, drizzle_orm_1.eq)(schema_1.election.id, electionId),
            columns: { admins: true },
        });
        const admins = (en === null || en === void 0 ? void 0 : en.admins) || [];
        return admins.some((tag) => { var _a; return (tag === null || tag === void 0 ? void 0 : tag.toLowerCase()) === ((_a = req.userId) === null || _a === void 0 ? void 0 : _a.toLowerCase()); });
    });
}
// `getElectionId` resolves the election id for the request — a plain param
// read for most routes, but an async join lookup for portfolio/candidate
// routes where the election id isn't directly in the URL.
const requireElectionAdmin = (getElectionId) => (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    const electionId = yield getElectionId(req);
    if (electionId && (yield isElectionAdmin(req, electionId)))
        return next();
    return res.status(403).json({ message: `You do not have permission to perform this action.` });
});
const electionIdFromParam = (req) => Number(req.params.id) || undefined;
const electionIdFromBody = (req) => { var _a, _b, _c; return Number((_b = (_a = req.body) === null || _a === void 0 ? void 0 : _a.electionId) !== null && _b !== void 0 ? _b : (_c = req.body) === null || _c === void 0 ? void 0 : _c.id) || undefined; };
const electionIdFromPortfolioParam = (req) => __awaiter(void 0, void 0, void 0, function* () {
    const id = Number(req.params.id);
    if (!id)
        return undefined;
    const row = yield mysqlAdapter_1.db.query.portfolio.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.portfolio.id, id), columns: { electionId: true } });
    return row === null || row === void 0 ? void 0 : row.electionId;
});
const electionIdFromCandidateParam = (req) => __awaiter(void 0, void 0, void 0, function* () {
    const id = Number(req.params.id);
    if (!id)
        return undefined;
    const row = yield mysqlAdapter_1.db.query.candidate.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.candidate.id, id), columns: { portfolioId: true } });
    if (!(row === null || row === void 0 ? void 0 : row.portfolioId))
        return undefined;
    const p = yield mysqlAdapter_1.db.query.portfolio.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.portfolio.id, row.portfolioId), columns: { electionId: true } });
    return p === null || p === void 0 ? void 0 : p.electionId;
});
const electionIdFromCandidateBody = (req) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const portfolioId = Number((_a = req.body) === null || _a === void 0 ? void 0 : _a.portfolioId);
    if (!portfolioId)
        return undefined;
    const p = yield mysqlAdapter_1.db.query.portfolio.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.portfolio.id, portfolioId), columns: { electionId: true } });
    return p === null || p === void 0 ? void 0 : p.electionId;
});
module.exports = {
    isElectionAdmin,
    requireElectionAdmin,
    electionIdFromParam,
    electionIdFromBody,
    electionIdFromPortfolioParam,
    electionIdFromCandidateParam,
    electionIdFromCandidateBody,
};
