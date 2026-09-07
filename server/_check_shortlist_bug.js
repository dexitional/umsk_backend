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
    const applicant = yield client_1.prisma.applicant.findFirst({ where: { serial: "26091034" } });
    console.log("live applicant row exists:", !!applicant);
    const sorted = yield client_1.prisma.sortedApplicant.findFirst({ where: { serial: "26091034" } });
    console.log("sortedApplicant (shortlist) row exists:", !!sorted, sorted === null || sorted === void 0 ? void 0 : sorted.id);
    process.exit(0);
}))();
