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
    const notAdmitted = yield client_1.prisma.sortedApplicant.findMany({
        where: { admitted: false },
        include: { admission: true },
    });
    const byAdmission = new Map();
    notAdmitted.forEach((a) => {
        var _a, _b, _c;
        const key = ((_a = a.admission) === null || _a === void 0 ? void 0 : _a.title) || 'NO ADMISSION';
        const cur = byAdmission.get(key) || { title: key, count: 0, sessionId: (_c = (_b = a.admission) === null || _b === void 0 ? void 0 : _b.sessionId) !== null && _c !== void 0 ? _c : null };
        cur.count++;
        byAdmission.set(key, cur);
    });
    console.log("total not-admitted:", notAdmitted.length);
    Array.from(byAdmission.values()).forEach((v) => console.log(v.title, "count:", v.count, "sessionId:", v.sessionId));
    process.exit(0);
}))();
