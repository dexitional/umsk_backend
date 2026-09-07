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
    const docs = yield client_1.prisma.stepDocument.findMany({ where: { path: { not: null } }, select: { serial: true, path: true } });
    const serials = Array.from(new Set(docs.map((d) => d.serial)));
    const liveApplicants = yield client_1.prisma.applicant.findMany({ where: { serial: { in: serials } }, select: { serial: true, meta: true } });
    const withDocMeta = liveApplicants.filter((a) => Array.isArray(a.meta) && a.meta.some((m) => m.tag === "document"));
    console.log("live applicants with path-based docs + document meta:", withDocMeta.length);
    withDocMeta.slice(0, 5).forEach((a) => console.log(a.serial));
    process.exit(0);
}))();
