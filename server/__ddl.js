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
const client_1 = require("./prisma/client");
const db = client_1.prisma;
(() => __awaiter(void 0, void 0, void 0, function* () {
    for (const t of (process.env.TABLES || "").split(",")) {
        const r = yield db.$queryRawUnsafe(`SHOW CREATE TABLE \`${t}\``);
        console.log(`-- ${t}\n${r[0]["Create Table"]};\n`);
    }
    process.exit(0);
}))().catch((e) => { console.error("ERR", e.message); process.exit(1); });
