"use strict";
// Push notifications to the AKATSICO student app go through akaweb (the
// website/CMS), which stores the app's device tokens and talks to Expo's
// push service. umsk only asks akaweb to broadcast a circular to an
// audience -- see akaweb apps/web/src/server/api/modules/public/route.ts.
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
exports.STUDENT_AUDIENCES = void 0;
exports.studentAudiences = studentAudiences;
exports.broadcastCircular = broadcastCircular;
// informer.receiver values that correspond to tagged student devices.
exports.STUDENT_AUDIENCES = ["STUDENT", "FRESHER", "FINAL", "UNDERGRAD", "POSTGRAD", "ALUMNI"];
// The audiences a student belongs to -- mirrors exactly how sendNotice
// (aisController) selects SMS recipients for each receiver type, so the app
// shows and pushes the same circulars a student would have been texted.
function studentAudiences(st) {
    var _a, _b, _c;
    const out = [];
    const active = !(st === null || st === void 0 ? void 0 : st.completeStatus) && !(st === null || st === void 0 ? void 0 : st.deferStatus);
    if (active) {
        out.push("STUDENT");
        if ((st === null || st === void 0 ? void 0 : st.entrySemesterNum) != null && (st.semesterNum == st.entrySemesterNum || st.semesterNum == st.entrySemesterNum + 1))
            out.push("FRESHER");
        const total = (_a = st === null || st === void 0 ? void 0 : st.program) === null || _a === void 0 ? void 0 : _a.semesterTotal;
        if (total != null && (st.semesterNum == total || st.semesterNum == total - 1))
            out.push("FINAL");
        if (((_b = st === null || st === void 0 ? void 0 : st.program) === null || _b === void 0 ? void 0 : _b.category) == "UG")
            out.push("UNDERGRAD");
        if (((_c = st === null || st === void 0 ? void 0 : st.program) === null || _c === void 0 ? void 0 : _c.category) == "PG")
            out.push("POSTGRAD");
    }
    if ((st === null || st === void 0 ? void 0 : st.completeStatus) && (st === null || st === void 0 ? void 0 : st.graduateStatus))
        out.push("ALUMNI");
    return out;
}
// Fire-and-forget: a push failure must never affect the SMS send.
function broadcastCircular(notice) {
    return __awaiter(this, void 0, void 0, function* () {
        const base = process.env.AKAWEB_URL;
        const secret = process.env.PUSH_BROADCAST_SECRET;
        if (!base || !secret)
            return { skipped: "AKAWEB_URL / PUSH_BROADCAST_SECRET not configured" };
        if (!exports.STUDENT_AUDIENCES.includes(notice.receiver))
            return { skipped: `receiver ${notice.receiver} is not an app audience` };
        const plain = (notice.smsContent || notice.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        try {
            const res = yield fetch(`${base.replace(/\/$/, "")}/api/public/push/broadcast`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-push-secret": secret },
                body: JSON.stringify({
                    topic: "circular",
                    audience: notice.receiver,
                    title: `Circular: ${notice.title}`.slice(0, 120),
                    body: plain.slice(0, 400),
                    data: { id: notice.id },
                }),
            });
            return yield res.json().catch(() => ({ status: res.status }));
        }
        catch (error) {
            console.log("broadcastCircular failed:", error === null || error === void 0 ? void 0 : error.message);
            return { error: error === null || error === void 0 ? void 0 : error.message };
        }
    });
}
