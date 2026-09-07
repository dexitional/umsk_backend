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
    var _a, _b, _c, _d;
    const a = yield client_1.prisma.applicant.findFirst({
        where: { submitted: true, sorted: false },
        include: { profile: true, stage: true },
    });
    console.log(a === null || a === void 0 ? void 0 : a.serial, (_a = a === null || a === void 0 ? void 0 : a.profile) === null || _a === void 0 ? void 0 : _a.fname, (_b = a === null || a === void 0 ? void 0 : a.profile) === null || _b === void 0 ? void 0 : _b.lname, (_c = a === null || a === void 0 ? void 0 : a.profile) === null || _c === void 0 ? void 0 : _c.phone, (_d = a === null || a === void 0 ? void 0 : a.stage) === null || _d === void 0 ? void 0 : _d.categoryId);
    process.exit(0);
}))();
