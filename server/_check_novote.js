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
    const rs = yield mysqlAdapter_1.db.query.elector.findFirst({ where: (0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_1.elector.electionId, 7), (0, drizzle_orm_1.eq)(schema_1.elector.tag, "41329275")) });
    console.log("Elector row for 41329275 in election 7 (should be undefined/none):", rs);
    process.exit(0);
}))();
