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
    const total = yield client_1.prisma.resit.count();
    const untaken = yield client_1.prisma.resit.count({ where: { taken: false } });
    console.log("total resit rows:", total, "untaken:", untaken);
    const st = yield client_1.prisma.student.findUnique({ where: { id: "24090090" } });
    console.log("fine student:", st === null || st === void 0 ? void 0 : st.id, st === null || st === void 0 ? void 0 : st.indexno, st === null || st === void 0 ? void 0 : st.entryGroup, st === null || st === void 0 ? void 0 : st.fname, st === null || st === void 0 ? void 0 : st.lname);
    process.exit(0);
}))();
