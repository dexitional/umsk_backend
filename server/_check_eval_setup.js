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
    console.log("Questions:", questions.map((q) => ({ id: q.id, type: q.type, required: q.required })));
    const options = yield client_1.prisma.evaluationOption.findMany({ where: { status: true } });
    console.log("Options:", options.map((o) => ({ id: o.id, option: o.option })));
    const staff = yield client_1.prisma.staff.findFirst();
    console.log("A staff member:", staff === null || staff === void 0 ? void 0 : staff.staffNo, staff === null || staff === void 0 ? void 0 : staff.fname, staff === null || staff === void 0 ? void 0 : staff.lname);
    const st = yield client_1.prisma.student.findUnique({ where: { indexno: "AUBS01260025" } });
    console.log("Target student:", st === null || st === void 0 ? void 0 : st.id, st === null || st === void 0 ? void 0 : st.indexno, st === null || st === void 0 ? void 0 : st.fname, st === null || st === void 0 ? void 0 : st.lname);
    const assessRows = yield client_1.prisma.assessment.findMany({ where: { indexno: st.indexno }, include: { course: true } });
    console.log("Their assessment courses:", assessRows.map((a) => a.courseId));
    process.exit(0);
}))();
