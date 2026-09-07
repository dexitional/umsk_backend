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
    const applicants = yield client_1.prisma.applicant.findMany({
        select: { serial: true, meta: true },
    });
    const withDocMeta = applicants.filter((a) => Array.isArray(a.meta) && a.meta.some((m) => m.tag === "document"));
    console.log("applicants with document meta:", withDocMeta.length);
    for (const a of withDocMeta.slice(0, 200)) {
        const docs = yield client_1.prisma.stepDocument.findMany({ where: { serial: a.serial }, select: { path: true, base64: true } });
        const broken = docs.filter((d) => d.base64 && /^https?:\/\//i.test(d.base64));
        if (broken.length)
            console.log(a.serial, "broken:", broken.length, "total:", docs.length);
    }
    process.exit(0);
}))();
