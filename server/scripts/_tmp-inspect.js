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
require("dotenv/config");
const client_1 = require("../prisma/client");
(() => __awaiter(void 0, void 0, void 0, function* () {
    const student = yield client_1.prisma.student.findFirst({ where: { id: "26090001" }, select: { indexno: true } });
    console.log("student.indexno:", student === null || student === void 0 ? void 0 : student.indexno);
    const rows = yield client_1.prisma.courseEvaluation.findMany({
        where: { indexno: (student === null || student === void 0 ? void 0 : student.indexno) || undefined },
        select: { id: true, courseId: true, formId: true, status: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    });
    console.log("rows:", JSON.stringify(rows, null, 2));
    yield client_1.prisma.$disconnect();
}))();
