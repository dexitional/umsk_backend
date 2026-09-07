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
    const e7 = yield mysqlAdapter_1.db.query.election.findFirst({ where: (0, drizzle_orm_1.eq)(schema_1.election.id, 7) });
    const voters = (e7 === null || e7 === void 0 ? void 0 : e7.voterData) || [];
    const votedRows = yield mysqlAdapter_1.db.select({ tag: schema_1.elector.tag }).from(schema_1.elector).where((0, drizzle_orm_1.eq)(schema_1.elector.electionId, 7));
    const votedTags = new Set(votedRows.map((r) => r.tag));
    const notVoted = voters.filter((v) => !votedTags.has(v.tag));
    console.log("Total eligible:", voters.length, "voted:", votedTags.size, "not voted:", notVoted.length);
    console.log("First few not-voted:", notVoted.slice(0, 3).map((v) => ({ tag: v.tag, name: v.name })));
    process.exit(0);
}))();
