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
    const afterCount = yield client_1.prisma.graduate.count({ where: { graduateSessionId: session === null || session === void 0 ? void 0 : session.id } });
    console.log("graduate rows after:", afterCount);
    for (const idx of ["AUUG01220013", "AUUG01220033", "AUUG01220001"]) {
        const g = yield client_1.prisma.graduate.findUnique({ where: { indexno: idx } });
        console.log(`AFTER ${idx}:`, JSON.stringify(g));
    }
    // Cross-check: how many verified:false rows now carry "Untaken Resit(s)" remark
    const withResitRemark = yield client_1.prisma.graduate.count({ where: { graduateSessionId: session === null || session === void 0 ? void 0 : session.id, verifiedRemark: { contains: "Untaken Resit" } } });
    console.log("graduate rows flagged with Untaken Resit(s):", withResitRemark);
    const withICRemark = yield client_1.prisma.graduate.count({ where: { graduateSessionId: session === null || session === void 0 ? void 0 : session.id, verifiedRemark: { contains: "IC(s)" } } });
    console.log("graduate rows flagged with IC(s):", withICRemark);
    const verifiedTrue = yield client_1.prisma.graduate.count({ where: { graduateSessionId: session === null || session === void 0 ? void 0 : session.id, verified: true } });
    console.log("graduate rows verified=true:", verifiedTrue);
    process.exit(0);
}))();
