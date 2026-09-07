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
    var _a, _b, _c, _d;
    const s = yield client_1.prisma.sortedApplicant.findFirst({
        where: { admitted: false, admission: { sessionId: { not: null } } },
        include: { profile: true, choice1: { include: { program: true } } },
        orderBy: { createdAt: 'desc' },
    });
    console.log(s === null || s === void 0 ? void 0 : s.serial, (_a = s === null || s === void 0 ? void 0 : s.profile) === null || _a === void 0 ? void 0 : _a.fname, (_b = s === null || s === void 0 ? void 0 : s.profile) === null || _b === void 0 ? void 0 : _b.lname, (_d = (_c = s === null || s === void 0 ? void 0 : s.choice1) === null || _c === void 0 ? void 0 : _c.program) === null || _d === void 0 ? void 0 : _d.longName, s === null || s === void 0 ? void 0 : s.categoryId);
    process.exit(0);
}))();
