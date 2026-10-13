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
    for (const q of (process.env.Q || "").split(";;")) {
        if (!q.trim())
            continue;
        const r = yield db.$queryRawUnsafe(q);
        console.log("> " + q.slice(0, 120));
        console.log(JSON.stringify(r, (k, v) => typeof v === "bigint" ? Number(v) : v));
    }
    process.exit(0);
}))().catch((e) => { console.error("ERR", e.message); process.exit(1); });
