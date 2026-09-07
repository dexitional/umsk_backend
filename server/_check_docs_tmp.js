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
    const docs = yield client_1.prisma.stepDocument.findMany({
        take: 10,
        select: { id: true, serial: true, path: true, mime: true, base64: true, documentCategory: { select: { title: true } } },
    });
    docs.forEach((d) => { var _a; return console.log({ id: d.id, serial: d.serial, path: d.path, mime: d.mime, hasBase64: !!d.base64, base64Prefix: (_a = d.base64) === null || _a === void 0 ? void 0 : _a.slice(0, 30) }); });
    process.exit(0);
}))();
