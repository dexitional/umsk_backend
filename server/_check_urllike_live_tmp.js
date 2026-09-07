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
    const brokenDocs = yield client_1.prisma.stepDocument.findMany({
        where: { path: null, base64: { startsWith: "http" } },
        select: { serial: true },
    });
    const serials = Array.from(new Set(brokenDocs.map((d) => d.serial)));
    // Check applicant existence regardless of category scope (raw check)
    const applicants = yield client_1.prisma.applicant.findMany({ where: { serial: { in: serials } }, select: { serial: true } });
    console.log("raw applicant rows (any) among broken serials:", applicants.length);
    process.exit(0);
}))();
