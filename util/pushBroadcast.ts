// Push notifications to the AKATSICO student app go through akaweb (the
// website/CMS), which stores the app's device tokens and talks to Expo's
// push service. umsk only asks akaweb to broadcast a circular to an
// audience -- see akaweb apps/web/src/server/api/modules/public/route.ts.

// informer.receiver values that correspond to tagged student devices.
export const STUDENT_AUDIENCES = ["STUDENT", "FRESHER", "FINAL", "UNDERGRAD", "POSTGRAD", "ALUMNI"] as const;
export type StudentAudience = (typeof STUDENT_AUDIENCES)[number];

// The audiences a student belongs to -- mirrors exactly how sendNotice
// (aisController) selects SMS recipients for each receiver type, so the app
// shows and pushes the same circulars a student would have been texted.
export function studentAudiences(st: any): StudentAudience[] {
   const out: StudentAudience[] = [];
   const active = !st?.completeStatus && !st?.deferStatus;
   if (active) {
      out.push("STUDENT");
      if (st?.entrySemesterNum != null && (st.semesterNum == st.entrySemesterNum || st.semesterNum == st.entrySemesterNum + 1)) out.push("FRESHER");
      const total = st?.program?.semesterTotal;
      if (total != null && (st.semesterNum == total || st.semesterNum == total - 1)) out.push("FINAL");
      if (st?.program?.category == "UG") out.push("UNDERGRAD");
      if (st?.program?.category == "PG") out.push("POSTGRAD");
   }
   if (st?.completeStatus && st?.graduateStatus) out.push("ALUMNI");
   return out;
}

// Fire-and-forget: a push failure must never affect the SMS send.
export async function broadcastCircular(notice: { id: string; title: string; content?: string | null; smsContent?: string | null; receiver: string }) {
   const base = process.env.AKAWEB_URL;
   const secret = process.env.PUSH_BROADCAST_SECRET;
   if (!base || !secret) return { skipped: "AKAWEB_URL / PUSH_BROADCAST_SECRET not configured" };
   if (!(STUDENT_AUDIENCES as readonly string[]).includes(notice.receiver)) return { skipped: `receiver ${notice.receiver} is not an app audience` };
   const plain = (notice.smsContent || notice.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
   try {
      const res = await fetch(`${base.replace(/\/$/, "")}/api/public/push/broadcast`, {
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
      return await res.json().catch(() => ({ status: res.status }));
   } catch (error: any) {
      console.log("broadcastCircular failed:", error?.message);
      return { error: error?.message };
   }
}
