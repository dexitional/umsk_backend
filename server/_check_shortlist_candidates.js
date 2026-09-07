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
        where: { admitted: false },
        include: { profile: true, admission: { include: { session: true } } },
        take: 500,
    });
    console.log("total not-yet-admitted shortlisted:", candidates.length);
    const noAdmission = candidates.filter((c) => !c.admission);
    const noSession = candidates.filter((c) => c.admission && !c.admission.session);
    const noProfile = candidates.filter((c) => !c.profile);
    const noPhone = candidates.filter((c) => c.profile && !c.profile.phone);
    const noName = candidates.filter((c) => c.profile && (!c.profile.fname || !c.profile.lname));
    console.log("no admission:", noAdmission.length, noAdmission.slice(0, 3).map(c => c.serial));
    console.log("no session:", noSession.length, noSession.slice(0, 3).map(c => c.serial));
    console.log("no profile:", noProfile.length, noProfile.slice(0, 3).map(c => c.serial));
    console.log("no phone:", noPhone.length, noPhone.slice(0, 3).map(c => c.serial));
    console.log("no name:", noName.length, noName.slice(0, 3).map(c => c.serial));
    // Candidates that pass all the above (potential guardian-check / happy-path candidates)
    const clean = candidates.filter((c) => c.admission && c.admission.session && c.profile && c.profile.phone && c.profile.fname && c.profile.lname);
    console.log("clean (passes profile/admission/session/phone/name):", clean.length);
    for (const c of clean.slice(0, 20)) {
        const guardian = yield client_1.prisma.stepGuardian.findFirst({ where: { serial: c.serial } });
        if (!guardian) {
            console.log("NO GUARDIAN:", c.serial, c.categoryId);
            continue;
        }
        if (!guardian.phone) {
            console.log("NO GUARDIAN PHONE:", c.serial, c.categoryId);
            continue;
        }
    }
    console.log("done scanning guardians for first 20 clean candidates");
    process.exit(0);
}))();
