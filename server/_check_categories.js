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
    const s1 = yield client_1.prisma.sortedApplicant.findFirst({ where: { serial: "22090055" }, select: { categoryId: true } });
    const s2 = yield client_1.prisma.sortedApplicant.findFirst({ where: { serial: "24091807" }, select: { categoryId: true } });
    const s3 = yield client_1.prisma.sortedApplicant.findFirst({ where: { serial: "26090007" }, select: { categoryId: true } });
    console.log("22090055 (no session):", s1 === null || s1 === void 0 ? void 0 : s1.categoryId);
    console.log("24091807 (no guardian phone):", s2 === null || s2 === void 0 ? void 0 : s2.categoryId);
    console.log("26090007 (fully clean):", s3 === null || s3 === void 0 ? void 0 : s3.categoryId);
    process.exit(0);
}))();
