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
    const rows = yield client_1.prisma.stepDocument.findMany({
        where: { path: null, base64: { not: null } },
        select: { id: true, serial: true, base64: true, mime: true },
    });
    const urlLike = rows.filter((r) => /^https?:\/\//i.test(r.base64));
    const realBase64 = rows.filter((r) => !/^https?:\/\//i.test(r.base64));
    console.log("total unmigrated:", rows.length, "urlLike:", urlLike.length, "realBase64:", realBase64.length);
    realBase64.slice(0, 5).forEach((r) => console.log({ id: r.id, mime: r.mime, prefix: r.base64.slice(0, 40), len: r.base64.length }));
    process.exit(0);
}))();
