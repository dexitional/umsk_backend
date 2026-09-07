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
    var _a, _b, _c, _d, _e;
    const sorted = yield client_1.prisma.sortedApplicant.findFirst({
        where: { serial: "24091807" },
        include: { profile: true, admission: { include: { session: true } } },
    });
    console.log("sessionId:", (_b = (_a = sorted === null || sorted === void 0 ? void 0 : sorted.admission) === null || _a === void 0 ? void 0 : _a.session) === null || _b === void 0 ? void 0 : _b.id, "countryId:", (_c = sorted === null || sorted === void 0 ? void 0 : sorted.profile) === null || _c === void 0 ? void 0 : _c.countryId, "categoryId:", sorted === null || sorted === void 0 ? void 0 : sorted.categoryId);
    const bills = yield client_1.prisma.bill.findMany({
        where: { sessionId: (_e = (_d = sorted === null || sorted === void 0 ? void 0 : sorted.admission) === null || _d === void 0 ? void 0 : _d.session) === null || _e === void 0 ? void 0 : _e.id },
        take: 5,
    });
    console.log("sample bills for this session:", bills.map((b) => ({ id: b.id, programId: b.programId, type: b.type, mainGroupCode: b.mainGroupCode })));
    process.exit(0);
}))();
