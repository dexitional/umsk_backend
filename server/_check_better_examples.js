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
    var _a;
    const candidates = yield client_1.prisma.student.findMany({
        where: { completeStatus: true, graduateStatus: false, indexno: { not: null }, semesterNum: 0 },
        include: { program: true },
    });
    let resitButCreditOk = null, icButCreditOk = null;
    for (const c of candidates) {
        const creditAgg = yield client_1.prisma.assessment.aggregate({ _sum: { credit: true }, where: { indexno: c.indexno } });
        const passesCreditGate = (creditAgg._sum.credit || 0) >= (((_a = c.program) === null || _a === void 0 ? void 0 : _a.creditTotal) || 0);
        if (!passesCreditGate)
            continue;
        if (!resitButCreditOk) {
            const rs = yield client_1.prisma.resit.count({ where: { indexno: c.indexno, taken: false } });
            if (rs > 0)
                resitButCreditOk = c.indexno;
        }
        if (!icButCreditOk) {
            const ic = yield client_1.prisma.assessment.count({ where: { indexno: c.indexno, totalScore: null } });
            const rs2 = yield client_1.prisma.resit.count({ where: { indexno: c.indexno, taken: false } });
            if (ic > 0 && rs2 === 0)
                icButCreditOk = c.indexno;
        }
        if (resitButCreditOk && icButCreditOk)
            break;
    }
    console.log("resitButCreditOk:", resitButCreditOk);
    console.log("icButCreditOk:", icButCreditOk);
    for (const idx of [resitButCreditOk, icButCreditOk].filter(Boolean)) {
        const g = yield client_1.prisma.graduate.findUnique({ where: { indexno: idx } });
        console.log(`CURRENT graduate row for ${idx}:`, JSON.stringify(g));
    }
    process.exit(0);
}))();
