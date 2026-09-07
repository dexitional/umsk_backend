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
    var _a, _b, _c;
    const sorted = yield client_1.prisma.sortedApplicant.findFirst({
        where: { serial: "24091807" },
        include: { profile: true, admission: { include: { session: true } } },
    });
    const sessionId = (_b = (_a = sorted === null || sorted === void 0 ? void 0 : sorted.admission) === null || _a === void 0 ? void 0 : _a.session) === null || _b === void 0 ? void 0 : _b.id;
    console.log("sessionId:", sessionId, "countryId:", (_c = sorted === null || sorted === void 0 ? void 0 : sorted.profile) === null || _c === void 0 ? void 0 : _c.countryId);
    const programId = "a00f668e-2a3a-4ad5-b3fb-a803cc5406d1";
    const codes = {
        1: ['1000', '1001', '1010', '1100', '1101', '1110', '1111'],
        3: ['0100', '0101', '0110', '0111', '1111', '1110', '1100'],
        5: ['0010', '0011', '1010', '1011', '1111', '0110', '0111'],
    };
    for (const sem of [1, 3, 5]) {
        const bills = yield client_1.prisma.bill.findMany({ where: { programId, sessionId, type: 'GH', mainGroupCode: { in: codes[sem] } } });
        console.log(`semesterNum ${sem}: bills found =`, bills.length, bills.map((b) => b.mainGroupCode));
    }
    // Check across ALL programs in this session for gaps at semesterNum 5
    const allPrograms = yield client_1.prisma.program.findMany({ select: { id: true, longName: true } });
    let gapCount = 0;
    for (const p of allPrograms.slice(0, 60)) {
        const bills = yield client_1.prisma.bill.findMany({ where: { programId: p.id, sessionId, type: 'GH', mainGroupCode: { in: codes[5] } } });
        if (!bills.length)
            gapCount++;
    }
    console.log(`programs (of first 60) missing a semesterNum-5 GH bill for this session:`, gapCount);
    process.exit(0);
}))();
