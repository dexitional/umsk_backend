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
    const sessions = yield client_1.prisma.session.findMany({ where: { default: true } });
    const sessionIds = sessions.map(s => s.id);
    const registered = yield client_1.prisma.activityRegister.findMany({ where: { sessionId: { in: sessionIds } }, include: { student: true } });
    console.log("Registered students in default session(s):", registered.map((r) => { var _a; return ({ indexno: r.indexno, id: (_a = r.student) === null || _a === void 0 ? void 0 : _a.id, courses: r.courses }); }));
    for (const r of registered) {
        const assessCount = yield client_1.prisma.assessment.count({ where: { sessionId: { in: sessionIds }, indexno: r.indexno } });
        console.log(`${r.indexno} (id=${(_a = r.student) === null || _a === void 0 ? void 0 : _a.id}): activityRegister courses=${r.courses}, assessment rows=${assessCount}`);
    }
    process.exit(0);
}))();
