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
function getGradePoint(num, grades) {
    if (num == null)
        return 0;
    num = parseFloat(num);
    const vs = grades && grades.find((row) => parseFloat(row.min) <= num && num <= parseFloat(row.max));
    return (vs && vs.gradepoint) || 0;
}
(() => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const idx = "AUUG01220009";
    const ax = yield client_1.prisma.assessment.findMany({ where: { indexno: idx }, include: { scheme: true } });
    let gradedCredit = 0, az_new = 0, incompleteCount = 0;
    let allCredit = 0, az_old = 0;
    for (const r of ax) {
        allCredit += r.credit;
        const grades = (_a = r.scheme) === null || _a === void 0 ? void 0 : _a.gradeMeta;
        if (r.totalScore === undefined || r.totalScore == null) {
            incompleteCount++;
            az_old += getGradePoint(0, grades) * r.credit; // old behavior: zero-fill
            continue; // new behavior: excluded entirely
        }
        const gv = getGradePoint(r.totalScore, grades);
        gradedCredit += r.credit;
        az_new += gv * r.credit;
        az_old += gv * r.credit;
    }
    console.log("total assessment rows:", ax.length, "IC rows:", incompleteCount);
    console.log("OLD cgpa (zero-fill IC, denom = all credit):", (az_old / (allCredit || 1)).toFixed(2));
    console.log("NEW cgpa (exclude IC, denom = graded credit only):", (az_new / (gradedCredit || 1)).toFixed(2));
    console.log("stored graduate.cgpa (from live run):", (_b = (yield client_1.prisma.graduate.findUnique({ where: { indexno: idx } }))) === null || _b === void 0 ? void 0 : _b.cgpa);
    process.exit(0);
}))();
