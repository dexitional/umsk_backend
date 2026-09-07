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
    const st = yield client_1.prisma.student.findUnique({ where: { indexno: "AUMB09250001" } });
    console.log("id:", st === null || st === void 0 ? void 0 : st.id, "indexno:", st === null || st === void 0 ? void 0 : st.indexno, "entryGroup:", st === null || st === void 0 ? void 0 : st.entryGroup, "fname:", st === null || st === void 0 ? void 0 : st.fname, "lname:", st === null || st === void 0 ? void 0 : st.lname);
    process.exit(0);
}))();
