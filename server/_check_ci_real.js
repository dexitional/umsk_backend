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
    const real = yield client_1.prisma.user.findFirst({ select: { username: true, tag: true } });
    console.log("real username:", real === null || real === void 0 ? void 0 : real.username, "tag:", real === null || real === void 0 ? void 0 : real.tag);
    if (real === null || real === void 0 ? void 0 : real.username) {
        const upper = real.username.toUpperCase();
        const lower = real.username.toLowerCase();
        const foundUpper = yield client_1.prisma.user.findFirst({ where: { username: upper } });
        const foundLower = yield client_1.prisma.user.findFirst({ where: { username: lower } });
        console.log("found via UPPER variant:", !!foundUpper);
        console.log("found via lower variant:", !!foundLower);
    }
    process.exit(0);
}))();
