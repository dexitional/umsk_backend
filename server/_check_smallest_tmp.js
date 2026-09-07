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
    const sessions = yield client_1.prisma.session.findMany({ select: { id: true, title: true } });
    for (const s of sessions) {
        const registered = yield client_1.prisma.activityRegister.findMany({ where: { sessionId: s.id }, select: { indexno: true } });
        const eligible = yield client_1.prisma.student.count({
            where: {
                completeStatus: false, deferStatus: false, phone: { not: null },
                indexno: { notIn: registered.map(r => r.indexno).filter(Boolean) },
            },
        });
        if (eligible > 0 && eligible < 5)
            console.log(s.title, s.id, eligible);
    }
    process.exit(0);
}))();
