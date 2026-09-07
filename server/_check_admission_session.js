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
    // Check admitted (already successful) applicants' admission.session state
    const admitted = yield client_1.prisma.sortedApplicant.findMany({
        where: { admitted: true },
        include: { admission: { include: { session: true } } },
        take: 20,
    });
    console.log("sample of ALREADY-ADMITTED applicants and their admission.session:");
    admitted.forEach((a) => { var _a, _b, _c, _d; return console.log(a.serial, "admissionId:", a.admissionId, "session:", (_c = (_b = (_a = a.admission) === null || _a === void 0 ? void 0 : _a.session) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : null, "sessionId on admission:", (_d = a.admission) === null || _d === void 0 ? void 0 : _d.sessionId); });
    // Check the admission model itself - how many admission rows have sessionId set vs null
    const allAdmissions = yield client_1.prisma.admission.findMany({ select: { id: true, title: true, sessionId: true } });
    const withSession = allAdmissions.filter((a) => a.sessionId);
    console.log("\ntotal admission rows:", allAdmissions.length, "with sessionId set:", withSession.length);
    allAdmissions.slice(0, 10).forEach((a) => console.log(a.id, a.title, "sessionId:", a.sessionId));
    process.exit(0);
}))();
