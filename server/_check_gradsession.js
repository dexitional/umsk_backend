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
    const gs = yield client_1.prisma.graduateSession.findFirst({ where: { default: true } });
    console.log("session", gs === null || gs === void 0 ? void 0 : gs.id, gs === null || gs === void 0 ? void 0 : gs.title);
    const g = yield client_1.prisma.graduate.findFirst({ where: { graduateSessionId: gs === null || gs === void 0 ? void 0 : gs.id }, include: { student: true } });
    console.log("sample graduate", g === null || g === void 0 ? void 0 : g.indexno, (_a = g === null || g === void 0 ? void 0 : g.student) === null || _a === void 0 ? void 0 : _a.fname, (_b = g === null || g === void 0 ? void 0 : g.student) === null || _b === void 0 ? void 0 : _b.lname);
    process.exit(0);
}))();
