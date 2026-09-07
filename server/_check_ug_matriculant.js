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
    var _a, _b, _c;
    const m = yield client_1.prisma.fresher.findFirst({
        where: { category: { id: { not: "PG" } }, letterId: { not: null } },
        include: { student: true, category: true },
        orderBy: { createdAt: 'desc' },
    });
    console.log(m === null || m === void 0 ? void 0 : m.serial, (_a = m === null || m === void 0 ? void 0 : m.student) === null || _a === void 0 ? void 0 : _a.fname, (_b = m === null || m === void 0 ? void 0 : m.student) === null || _b === void 0 ? void 0 : _b.lname, (_c = m === null || m === void 0 ? void 0 : m.category) === null || _c === void 0 ? void 0 : _c.id);
    process.exit(0);
}))();
