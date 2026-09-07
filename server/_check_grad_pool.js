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
(() => __awaiter(void 0, void 0, void 0, function* () {
    const candidates = yield client_1.prisma.student.findMany({
        where: { completeStatus: true, graduateStatus: false, indexno: { not: null }, semesterNum: 0 },
        select: { indexno: true, programId: true },
    });
    console.log("candidate pool size:", candidates.length);
    let withUntakenResit = 0;
    let withIC = 0;
    for (const c of candidates) {
        const rs = yield client_1.prisma.resit.count({ where: { indexno: c.indexno, taken: false } });
        if (rs > 0)
            withUntakenResit++;
        const ic = yield client_1.prisma.assessment.count({ where: { indexno: c.indexno, totalScore: null } });
        if (ic > 0)
            withIC++;
    }
    console.log("candidates with >=1 untaken resit:", withUntakenResit);
    console.log("candidates with >=1 IC (null totalScore) assessment:", withIC);
    process.exit(0);
}))();
