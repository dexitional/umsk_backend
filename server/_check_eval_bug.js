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
    const sessions = yield client_1.prisma.session.findMany({ where: { default: true } });
    console.log("Default sessions:", sessions.map(s => ({ id: s.id, title: s.title, tag: s.tag, evalStart: s.evaluationStart, evalEnd: s.evaluationEnd })));
    const sessionIds = sessions.map(s => s.id);
    const assessmentCount = yield client_1.prisma.assessment.count({ where: { sessionId: { in: sessionIds } } });
    console.log("Total assessment rows in default session(s):", assessmentCount);
    const registerCount = yield client_1.prisma.activityRegister.count({ where: { sessionId: { in: sessionIds } } });
    console.log("Total activityRegister rows in default session(s):", registerCount);
    const courseEvalCount = yield client_1.prisma.courseEvaluation.count({ where: { sessionId: { in: sessionIds } } });
    console.log("Total courseEvaluation rows in default session(s):", courseEvalCount);
    const st = yield client_1.prisma.student.findUnique({ where: { id: "24090090" } });
    console.log("Test student:", st === null || st === void 0 ? void 0 : st.id, st === null || st === void 0 ? void 0 : st.indexno);
    const indexno = st === null || st === void 0 ? void 0 : st.indexno;
    const myAssess = yield client_1.prisma.assessment.count({ where: { sessionId: { in: sessionIds }, indexno } });
    console.log("Test student assessment rows in default session:", myAssess);
    const myReg = yield client_1.prisma.activityRegister.findFirst({ where: { sessionId: { in: sessionIds }, indexno } });
    console.log("Test student activityRegister row:", myReg === null || myReg === void 0 ? void 0 : myReg.id, myReg === null || myReg === void 0 ? void 0 : myReg.courses, myReg === null || myReg === void 0 ? void 0 : myReg.credits);
    const anyAssessRow = yield client_1.prisma.assessment.findFirst({ where: { sessionId: { in: sessionIds } } });
    console.log("Any assessment row exists in default session at all?", !!anyAssessRow, anyAssessRow === null || anyAssessRow === void 0 ? void 0 : anyAssessRow.indexno);
    process.exit(0);
}))();
