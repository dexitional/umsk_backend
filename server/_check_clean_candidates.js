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
    const candidates = yield client_1.prisma.sortedApplicant.findMany({
        where: { admitted: false, admission: { sessionId: { not: null } } },
        include: { profile: true, admission: { include: { session: true } } },
    });
    console.log("admittable-round candidates:", candidates.length);
    const noProfile = candidates.filter((c) => !c.profile);
    const noPhone = candidates.filter((c) => c.profile && !c.profile.phone);
    console.log("no profile:", noProfile.length, noProfile.slice(0, 3).map((c) => c.serial));
    console.log("no phone:", noPhone.length, noPhone.slice(0, 3).map((c) => c.serial));
    const clean = candidates.filter((c) => c.profile && c.profile.phone && c.profile.fname && c.profile.lname);
    console.log("clean (profile+phone+name ok):", clean.length);
    let noGuardianExample = null, noGuardianPhoneExample = null, fullyCleanExample = null;
    for (const c of clean) {
        const guardian = yield client_1.prisma.stepGuardian.findFirst({ where: { serial: c.serial } });
        if (!guardian && !noGuardianExample)
            noGuardianExample = c.serial;
        else if (guardian && !guardian.phone && !noGuardianPhoneExample)
            noGuardianPhoneExample = c.serial;
        else if (guardian && guardian.phone && !fullyCleanExample)
            fullyCleanExample = c.serial;
        if (noGuardianExample && noGuardianPhoneExample && fullyCleanExample)
            break;
    }
    console.log("no guardian example:", noGuardianExample);
    console.log("no guardian phone example:", noGuardianPhoneExample);
    console.log("fully clean (happy path) example:", fullyCleanExample);
    console.log("\n-- no session example --");
    const noSession = yield client_1.prisma.sortedApplicant.findFirst({ where: { admitted: false, admission: { sessionId: null } } });
    console.log(noSession === null || noSession === void 0 ? void 0 : noSession.serial);
    process.exit(0);
}))();
