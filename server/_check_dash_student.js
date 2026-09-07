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
    var _a, _b;
    const resitRow = yield client_1.prisma.resit.findFirst({ where: { taken: false }, include: { student: true, course: true, trailSession: true } });
    console.log("Resit candidate:", resitRow === null || resitRow === void 0 ? void 0 : resitRow.indexno, (_a = resitRow === null || resitRow === void 0 ? void 0 : resitRow.student) === null || _a === void 0 ? void 0 : _a.id, "course:", resitRow === null || resitRow === void 0 ? void 0 : resitRow.courseId, "trail:", (_b = resitRow === null || resitRow === void 0 ? void 0 : resitRow.trailSession) === null || _b === void 0 ? void 0 : _b.title);
    const fineCharge = yield client_1.prisma.charge.findFirst({ where: { type: 'FINE' }, include: { student: true } });
    console.log("Fine candidate:", fineCharge === null || fineCharge === void 0 ? void 0 : fineCharge.studentId, fineCharge === null || fineCharge === void 0 ? void 0 : fineCharge.amount, fineCharge === null || fineCharge === void 0 ? void 0 : fineCharge.currency);
    const defaultSession = yield client_1.prisma.session.findFirst({ where: { default: true } });
    console.log("Default session:", defaultSession === null || defaultSession === void 0 ? void 0 : defaultSession.title, defaultSession === null || defaultSession === void 0 ? void 0 : defaultSession.registerEnd, defaultSession === null || defaultSession === void 0 ? void 0 : defaultSession.registerEndLate);
    process.exit(0);
}))();
