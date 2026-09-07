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
    const a = yield client_1.prisma.applicant.findFirst({ where: { serial: "21091036" }, include: { stage: true } });
    console.log({ serial: a === null || a === void 0 ? void 0 : a.serial, stageId: (_a = a === null || a === void 0 ? void 0 : a.stage) === null || _a === void 0 ? void 0 : _a.categoryId, meta: a === null || a === void 0 ? void 0 : a.meta });
    process.exit(0);
}))();
