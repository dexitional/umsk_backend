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
    var _a;
    const letter = yield client_1.prisma.admissionLetter.findUnique({ where: { id: "98db1730-cdf1-4382-be76-207ebf561197" }, select: { template: true } });
    console.log((_a = letter === null || letter === void 0 ? void 0 : letter.template) === null || _a === void 0 ? void 0 : _a.slice(0, 400));
    process.exit(0);
}))();
