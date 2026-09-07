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
    const questions = yield client_1.prisma.evaluationQuestion.findMany({ where: { status: true } });
    console.log("QUESTIONS:");
    questions.forEach((q) => { var _a; return console.log(q.id, "|", q.type, "|", q.required, "|", (_a = q.question) === null || _a === void 0 ? void 0 : _a.slice(0, 40)); });
    const sessions = yield client_1.prisma.session.findMany({ where: { default: true } });
    const sessionIds = sessions.map((s) => s.id);
    const st = yield client_1.prisma.student.findUnique({ where: { indexno: "AUBS01260025" } });
    const rows = yield client_1.prisma.assessment.findMany({ where: { indexno: st.indexno, sessionId: { in: sessionIds } }, select: { courseId: true } });
    console.log("ACTIVE SESSION COURSES:", rows.map((r) => r.courseId));
    process.exit(0);
}))();
