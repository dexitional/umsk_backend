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
    const brokenSerials = Array.from(new Set(brokenDocs.map((d) => d.serial)));
    const freshers = yield client_1.prisma.fresher.findMany({ where: { serial: { in: brokenSerials } }, select: { serial: true } });
    console.log("matching freshers:", freshers.length, freshers.map(f => f.serial));
    process.exit(0);
}))();
