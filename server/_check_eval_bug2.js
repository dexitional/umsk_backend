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
    const st = yield client_1.prisma.student.findUnique({ where: { indexno: "AUMB09250001" } });
    console.log("Student with real assessment data:", st === null || st === void 0 ? void 0 : st.id, st === null || st === void 0 ? void 0 : st.indexno, st === null || st === void 0 ? void 0 : st.fname, st === null || st === void 0 ? void 0 : st.lname);
    const sessions = yield client_1.prisma.session.findMany({ where: { default: true } });
    const sessionIds = sessions.map(s => s.id);
    // Replicate fetchForms logic exactly
    const options = yield client_1.prisma.assessment.findMany({
        where: { sessionId: { in: sessionIds }, indexno: st.indexno },
        select: { course: { select: { id: true, title: true } } },
    });
    const courseList = options.map((r) => r.course);
    console.log("Courses this student has assessment rows for:", courseList);
    const takenEvals = yield client_1.prisma.courseEvaluation.findMany({
        where: { courseId: { in: courseList.map((r) => r.id) }, sessionId: { in: sessionIds }, indexno: st.indexno },
    });
    console.log("Taken evals count:", takenEvals.length, "vs course count:", courseList.length);
    const status = (courseList.length && takenEvals.length == courseList.length) ? 'completed' : 'started';
    console.log("Computed status:", status);
    process.exit(0);
}))();
