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
const mysqlAdapter_1 = require("./drizzle/mysqlAdapter");
const schema_1 = require("./drizzle/schema");
const drizzle_orm_1 = require("drizzle-orm");
(() => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const e7 = yield mysqlAdapter_1.db.query.election.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.election.id, 7) });
    console.log("Election 7 status/action:", e7 === null || e7 === void 0 ? void 0 : e7.status, e7 === null || e7 === void 0 ? void 0 : e7.action, "admins:", e7 === null || e7 === void 0 ? void 0 : e7.admins);
    console.log("Election 7 voterData sample:", (_a = e7 === null || e7 === void 0 ? void 0 : e7.voterData) === null || _a === void 0 ? void 0 : _a.slice(0, 2));
    const e1 = yield mysqlAdapter_1.db.query.election.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.election.id, 1) });
    console.log("Election 1 status/action:", e1 === null || e1 === void 0 ? void 0 : e1.status, e1 === null || e1 === void 0 ? void 0 : e1.action);
    const c1 = yield mysqlAdapter_1.db.query.candidate.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.candidate.status, 1) });
    console.log("A candidate:", c1 === null || c1 === void 0 ? void 0 : c1.id, c1 === null || c1 === void 0 ? void 0 : c1.name, "portfolioId:", c1 === null || c1 === void 0 ? void 0 : c1.portfolioId);
    if (c1 === null || c1 === void 0 ? void 0 : c1.portfolioId) {
        const p = yield mysqlAdapter_1.db.query.portfolio.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.portfolio.id, c1.portfolioId) });
        console.log("That candidate's electionId:", p === null || p === void 0 ? void 0 : p.electionId);
    }
    process.exit(0);
}))();
