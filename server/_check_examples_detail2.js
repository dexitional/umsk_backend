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
    var _a, _b;
    const results = [];
    for (const idx of ["AUUG01220013", "AUUG01220033", "AUUG01220001"]) {
        const st = yield client_1.prisma.student.findFirst({ where: { indexno: idx }, include: { program: true } });
        const creditAgg = yield client_1.prisma.assessment.aggregate({ _sum: { credit: true }, where: { indexno: idx } });
        const untakenResits = yield client_1.prisma.resit.count({ where: { indexno: idx, taken: false } });
        const icCount = yield client_1.prisma.assessment.count({ where: { indexno: idx, totalScore: null } });
        results.push({
            idx,
            creditEarned: creditAgg._sum.credit,
            programCreditTotal: (_a = st === null || st === void 0 ? void 0 : st.program) === null || _a === void 0 ? void 0 : _a.creditTotal,
            passesCreditGate: (creditAgg._sum.credit || 0) >= (((_b = st === null || st === void 0 ? void 0 : st.program) === null || _b === void 0 ? void 0 : _b.creditTotal) || 0),
            untakenResits,
            icCount,
        });
    }
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
}))();
