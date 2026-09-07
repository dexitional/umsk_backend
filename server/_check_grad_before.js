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
    const session = yield client_1.prisma.graduateSession.findFirst({ where: { default: true } });
    console.log("default graduate session:", session === null || session === void 0 ? void 0 : session.id, session === null || session === void 0 ? void 0 : session.title);
    const beforeCount = yield client_1.prisma.graduate.count({ where: { graduateSessionId: session === null || session === void 0 ? void 0 : session.id } });
    console.log("graduate rows before (this session):", beforeCount);
    const totalGraduateRows = yield client_1.prisma.graduate.count();
    console.log("graduate rows before (all sessions, since indexno is globally unique):", totalGraduateRows);
    // Pick one candidate with an untaken resit
    const candidates = yield client_1.prisma.student.findMany({
        where: { completeStatus: true, graduateStatus: false, indexno: { not: null }, semesterNum: 0 },
        select: { indexno: true },
    });
    let resitExample = null, icExample = null, cleanExample = null;
    for (const c of candidates) {
        if (!resitExample) {
            const rs = yield client_1.prisma.resit.count({ where: { indexno: c.indexno, taken: false } });
            if (rs > 0)
                resitExample = c.indexno;
        }
        if (!icExample) {
            const ic = yield client_1.prisma.assessment.count({ where: { indexno: c.indexno, totalScore: null } });
            if (ic > 0)
                icExample = c.indexno;
        }
        if (!cleanExample) {
            const rs = yield client_1.prisma.resit.count({ where: { indexno: c.indexno, taken: false } });
            const ic = yield client_1.prisma.assessment.count({ where: { indexno: c.indexno, totalScore: null } });
            if (rs === 0 && ic === 0)
                cleanExample = c.indexno;
        }
        if (resitExample && icExample && cleanExample)
            break;
    }
    console.log("resitExample:", resitExample);
    console.log("icExample:", icExample);
    console.log("cleanExample:", cleanExample);
    for (const idx of [resitExample, icExample, cleanExample].filter(Boolean)) {
        const g = yield client_1.prisma.graduate.findUnique({ where: { indexno: idx } });
        console.log(`BEFORE ${idx}:`, JSON.stringify(g));
    }
    process.exit(0);
}))();
