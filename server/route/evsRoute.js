"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
// import EvsController from '../controller/evsController'
const evsController_1 = __importDefault(require("../controllerDrizzle/evsController"));
const authController_1 = __importDefault(require("../controller/authController"));
const { voteLimiter } = require("../middleware/rateLimitterFlexible");
const { verifyToken } = require("../middleware/verifyToken");
const { requireRole } = require("../middleware/requireRole");
const { requireElectionAdmin, electionIdFromParam, electionIdFromBody, electionIdFromPortfolioParam, electionIdFromCandidateParam, electionIdFromCandidateBody, } = require("../middleware/requireElectionAdmin");
// Elections have two admin tiers (see middleware/requireElectionAdmin.ts):
// EVS_ADMIN_ROLES gates module-wide actions (create/delete elections,
// granting per-election admin rights); requireElectionAdmin(...) gates
// per-election operational actions and also accepts a tag listed in that
// specific election's `admins`.
const EVS_ADMIN_ROLES = ['election::admin'];
class EvsRoute {
    constructor() {
        this.router = (0, express_1.Router)();
        this.controller = new evsController_1.default();
        this.auth = new authController_1.default();
        this.initializeRoute();
    }
    initializeRoute() {
        this.router.use(verifyToken);
        // Elections & Control
        //this.router.get('/test', this.controller.fetchTest);
        this.router.get("/elections", this.controller.fetchElections);
        this.router.get("/elections/search", [requireRole(EVS_ADMIN_ROLES)], this.controller.fetchAdminElections);
        this.router.get("/elections/my/:tag", this.controller.fetchMyElections);
        this.router.get("/elections/:id", this.controller.fetchElection);
        this.router.get("/elections/:id/admin-check", this.controller.checkElectionAdmin);
        // Side-effecting (bulk SMS) actions must not be plain GETs — a GET has
        // no CORS preflight, so it's forgeable via a simple <img>/link CSRF.
        this.router.post("/elections/:id/pins", [requireElectionAdmin(electionIdFromParam)], this.auth.sendVoterPins);
        this.router.post("/elections/:id/reminder", [requireElectionAdmin(electionIdFromParam)], this.auth.sendVoterReminder);
        this.router.get("/elections/:id/data", this.controller.fetchVotes);
        this.router.post("/elections/:id/data", [voteLimiter], this.controller.postVotes);
        this.router.get("/elections/:id/portfolios", this.controller.fetchPortfolios);
        this.router.post("/elections/:id/voters", [requireElectionAdmin(electionIdFromParam)], this.controller.postVoter);
        this.router.get("/elections/:id/voters/:tag", this.controller.fetchVoter);
        this.router.delete("/elections/:id/voters/:tag", [requireElectionAdmin(electionIdFromParam)], this.controller.deleteVoter);
        this.router.get("/elections/:id/receipt/:tag", this.controller.fetchReceipt);
        this.router.post("/elections", [requireRole(EVS_ADMIN_ROLES)], this.controller.postElection);
        this.router.patch("/elections/:id", [requireRole(EVS_ADMIN_ROLES)], this.controller.updateElection);
        this.router.delete("/elections/:id", [requireRole(EVS_ADMIN_ROLES)], this.controller.deleteElection);
        // Action
        this.router.post("/action/reset", [requireElectionAdmin(electionIdFromBody)], this.controller.actionReset);
        // Grants/revokes per-election admin rights — must stay platform-gated,
        // otherwise a per-election admin could add themselves (or anyone) to
        // any other election's admin list.
        this.router.post("/action/admin", [requireRole(EVS_ADMIN_ROLES)], this.controller.actionAdmin);
        this.router.post("/action/voters", [requireElectionAdmin(electionIdFromBody)], this.controller.setupVoters);
        // Portfolios
        this.router.get("/portfolios/list", this.controller.fetchPortfolioList);
        this.router.get("/portfolios/:id", this.controller.fetchPortfolio);
        this.router.get("/portfolios/:id/candidates", this.controller.fetchCandidates);
        this.router.post("/portfolios", [requireElectionAdmin(electionIdFromBody)], this.controller.postPortfolio);
        this.router.patch("/portfolios/:id", [requireElectionAdmin(electionIdFromPortfolioParam)], this.controller.updatePortfolio);
        this.router.delete("/portfolios/:id", [requireElectionAdmin(electionIdFromPortfolioParam)], this.controller.deletePortfolio);
        // Candidates
        this.router.get("/candidates/:id", this.controller.fetchCandidate);
        this.router.post("/candidates", [requireElectionAdmin(electionIdFromCandidateBody)], this.controller.postCandidate);
        this.router.patch("/candidates/:id", [requireElectionAdmin(electionIdFromCandidateParam)], this.controller.updateCandidate);
        this.router.delete("/candidates/:id", [requireElectionAdmin(electionIdFromCandidateParam)], this.controller.deleteCandidate);
    }
}
exports.default = new EvsRoute().router;
