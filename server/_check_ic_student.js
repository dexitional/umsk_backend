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
    var _a;
    const ic = yield client_1.prisma.assessment.findFirst({
        where: { totalScore: null },
        include: { session: true },
    });
    console.log("IC row:", ic === null || ic === void 0 ? void 0 : ic.indexno, ic === null || ic === void 0 ? void 0 : ic.courseId, "session:", (_a = ic === null || ic === void 0 ? void 0 : ic.session) === null || _a === void 0 ? void 0 : _a.title);
    const st = yield client_1.prisma.student.findFirst({ where: { indexno: ic === null || ic === void 0 ? void 0 : ic.indexno } });
    console.log("student id (for /ais/students/:id/transcript):", st === null || st === void 0 ? void 0 : st.id, st === null || st === void 0 ? void 0 : st.indexno, st === null || st === void 0 ? void 0 : st.fname, st === null || st === void 0 ? void 0 : st.lname);
    process.exit(0);
}))();
