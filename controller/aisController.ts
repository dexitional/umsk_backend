import { ResidenceError, initialAffiliation, recordAdmissionHall, lockStudent, genderOf, academicYear, transactionOptions } from "../util/residence";
import { academicTotals, assessmentGrade, transcriptGroups } from "../util/academic";
import { CurriculumSchemeError, curriculumRows, selectCurriculum, registrationCourses, curriculumClassMeta, curriculumSchemeId } from "../util/curriculumScheme";
import { Request, Response } from "express";
import moment from "moment";
import { prisma, prismaBase } from "../prisma/client";
import { withBufferedAudit } from "../prisma/auditAssessment";
import { broadcastCircular, studentAudiences } from "../util/pushBroadcast";

import fs from "fs";
import path from "path";
import { errorMessage, friendlyDbError, getBillCodePrisma, getClass, getGrade, getGradePoint, getOrSetCache, gradeFor, gradePointFor, isIncomplete, stripBlank, toDate } from "../util/helper";
import { paramStr } from "../util/paramStr";
import { buildStatutoryReport, StatutoryReportError } from "../util/statutoryReport";
import { isSheetAdmin, isSheetInScope, sheetScopeWhere } from "../util/sheetScope";
import { isResitInScope, resitScopeWhere } from "../util/resitScope";
import { completeType } from "@prisma/client";
import { graduateSession } from "../drizzle/schema";
const ais: any = prisma;

// Exam Score Manager: exam scores are capped at 40 marks -- any upload or
// edit containing a row above this is rejected outright.
const EXAM_SCORE_MAX = 40;

// Carries which student record broke a batch commit (e.g. backlog approval)
// so callers can report the specific row instead of a generic 500.
class BacklogRecordError extends Error {
  indexno?: string;
  reason: string;
  constructor(indexno: string | undefined, reason: string) {
    super(`Record for student ${indexno || 'unknown'} failed: ${reason}`);
    this.indexno = indexno;
    this.reason = reason;
  }
}

// Display details for role holders (Access Control): staff by staffNo,
// students by student id -- both are the sso user's tag.
async function accessPeople(users: { tag: string; groupId?: number | null }[]) {
   const tags = [...new Set(users.map((u) => u.tag).filter(Boolean))];
   const out = new Map<string, { name?: string; detail?: string; unit?: string }>();
   if (!tags.length) return out;
   const [staff, students] = await Promise.all([
      ais.staff.findMany({ where: { staffNo: { in: tags } }, select: { staffNo: true, fname: true, mname: true, lname: true, job: { select: { title: true } }, unit: { select: { title: true } } } }),
      ais.student.findMany({ where: { id: { in: tags } }, select: { id: true, fname: true, mname: true, lname: true, program: { select: { shortName: true } } } }),
   ]);
   const full = (p: any) => [p.fname, p.mname, p.lname].filter(Boolean).join(' ');
   for (const s of staff) out.set(s.staffNo, { name: full(s), detail: s.job?.title || 'Staff', unit: s.unit?.title });
   for (const s of students) if (!out.has(s.id)) out.set(s.id, { name: full(s), detail: 'Student', unit: s.program?.shortName });
   return out;
}

// Backlog assessment scores, from the entry form or an upload row. Class
// is the sum of Quiz + Midsem + Assignment (as on score sheets: scoreA /
// scoreC / scoreB) -- an older entry with no breakdown keeps its class
// score -- and Total is Class + Exam. A legacy row with neither class nor
// exam keeps whatever total it was given.
const scoreNum = (v: any) => (v === '' || v == null || Number.isNaN(parseFloat(v)) ? null : parseFloat(v));
function backlogScores(raw: { quiz?: any; midsem?: any; assignment?: any; classScore?: any; examScore?: any; totalScore?: any }) {
   const scoreQuiz = scoreNum(raw.quiz), scoreMidsem = scoreNum(raw.midsem), scoreAssignment = scoreNum(raw.assignment);
   const parts = [scoreQuiz, scoreMidsem, scoreAssignment];
   const scoreClass = parts.every((x) => x == null) ? scoreNum(raw.classScore) : parts.reduce((a: number, x) => a + (x ?? 0), 0);
   const scoreExam = scoreNum(raw.examScore);
   const scoreTotal = scoreClass == null && scoreExam == null ? scoreNum(raw.totalScore) : (scoreClass ?? 0) + (scoreExam ?? 0);
   return { scoreQuiz, scoreMidsem, scoreAssignment, scoreClass, scoreExam, scoreTotal };
}
// Form fields for row i of the backlog entry form.
const backlogFormScores = (body: any, i: number) => backlogScores({
   quiz: body[`${i}_scoreQuiz`], midsem: body[`${i}_scoreMidsem`], assignment: body[`${i}_scoreAssignment`],
   classScore: body[`${i}_scoreClass`], examScore: body[`${i}_scoreExam`], totalScore: body[`${i}_scoreTotal`],
});
import { hashPassword, generateStrongPassword } from "../util/password";
const { customAlphabet } = require("nanoid");
const pwdgen = customAlphabet("1234567890abcdefghijklmnopqrstuvwzyx", 6);
// unlockPin is a VarChar(4) column (a short quick-access PIN, distinct from
// the full login password) — must stay 4 digits, not pwdgen's 6 characters.
const pin = customAlphabet("1234567890", 4);
const sms = require('../config/sms');
const ExcelJS = require('exceljs');
import { createGsuiteUser, updateGsuitePassword } from '../config/gsuite';

// Students who have no ais_activity_register row for this session — the
// same "unregistered" semantics as the loadDashboard stats block below,
// scoped to a single session instead of branching by MAIN/sub-stream tag.
// Plain function (not a class method) since AisController's methods are
// passed to Express as detached references (no `.bind`) — a `this.` call
// from inside another method would find `this` undefined at request time.
async function unregisteredStudentsForSession(sessionId: string) {
   const registered = await ais.activityRegister.findMany({ where: { sessionId }, select: { indexno: true } });
   return ais.student.findMany({
      where: {
         completeStatus: false,
         deferStatus: false,
         phone: { not: null },
         indexno: { notIn: registered.map((r: any) => r.indexno).filter(Boolean) as string[] },
      },
      select: { indexno: true, phone: true },
   });
}


// A student may have several outstanding resit courses tied to this
// session — dedupe by indexno so each student is reminded once, not once
// per course row.
async function unresolvedResitStudentsForSession(trailSessionId: string) {
   const rows = await ais.resit.findMany({
      where: { trailSessionId, registeredAt: null, taken: false },
      include: { student: { select: { indexno: true, phone: true } } },
   });
   const uniqueStudents = new Map<string, string>();
   rows.forEach((r: any) => {
      if (r.student?.phone && r.student?.indexno) uniqueStudents.set(r.student.indexno, r.student.phone);
   });
   return uniqueStudents;
}

// Core of the stageStudent route handler below -- module-level like the
// helpers above, since it's also called directly from uploadStudent and
// `this.` inside a detached route handler is undefined.
// `sendSms` is skipped when called from the bulk upload pipeline (see
// uploadStudent) since generateStudentEmail runs right after and sends
// its own SMS with the real institute email -- sending this one first
// would text a username (the bare studentId) that's overwritten a moment
// later, misleading the student.
async function stageStudentAccess(studentId: string, userId?: string, sendSms: boolean = true, smsText?: (username: string, password: string) => string) {
   const password = generateStrongPassword();
   const isUser = await ais.user.findFirst({ where: { tag: studentId } })
   if (isUser) throw new Error("Student Portal Account Exists!")
   const ssoData = { tag: studentId, username: studentId, password: hashPassword(password), unlockPin: pin() }  // AKATSICO only
   // Populate SSO Account
   const resp = await ais.user.create({
      data: {
         ...ssoData,
         group: { connect: { id: 1 } },
      },
   })
   if (sendSms) {
      const st = await ais.student.findFirst({ where: { id: studentId } });
      if (st?.phone) {
         try {
            // Quote the username just stored (login matches on it), not instituteEmail.
            await sms(st.phone, smsText ? smsText(resp.username, password) : `Hi! Your new credentials is username: ${resp.username}, password: ${password}`)
         } catch (smsError: any) {
            console.log('stageStudentAccess SMS send failed:', smsError?.message)
         }
      }
   }
   // Log Login Response
   // Never log credentials (ssoData carries the hash + unlock PIN).
   await ais.log.create({ data: { action: `STUDENT_ACCOUNT_STAGED`, user: userId, student: studentId, meta: { studentId, username: studentId } } })
   return resp;
}

// Core of the generateEmail route handler below -- see stageStudentAccess
// above for why this is a module-level function. `smsText` replaces the
// default credentials SMS (Activate Admission folds the admission notice
// into it, so a fresher gets one text instead of two).
async function generateStudentEmail(studentId: string, userId?: string, sendSms: boolean = true, smsText?: (instituteEmail: string, password: string) => string) {
   let count = 1;
   let isNew = true;
   const st = await ais.student.findFirst({ where: { id: studentId }, include: { program: { select: { longName: true } } } });
   if (st?.instituteEmail) {
      await ais.user.updateMany({ where: { tag: studentId }, data: { username: st?.instituteEmail } });
      throw new Error("mail already exists !");
   }
   // Username = initials of fname + initials of every word in mname +
   // full lname -- e.g. fname "Ebenezer", mname "Kwabena Blay", lname
   // "Ackah" -> "ekbackah".
   const initials = (name?: string | null) => (name || '').trim().split(/\s+/).filter(Boolean).map((w) => w[0]).join('');
   let username = `${initials(st?.fname)}${initials(st?.mname)}${st?.lname?.replaceAll(' ', '')}`.toLowerCase();

   while (isNew) {
      const ck = await ais.student.findFirst({ where: { instituteEmail: { startsWith: `${username}${count > 1 ? count : ''}` } } });
      if (ck) count = count + 1;
      else isNew = false;
   }
   // Update Student Email -- append the collision-avoidance count from
   // the loop above (previously computed but never actually used,
   // silently letting two students land on the exact same email).
   const instituteEmail = `${username}${count > 1 ? count : ''}@${process.env.UMS_MAIL}`;
   // A fresh password is issued here (rather than leaving the portal
   // password untouched, as this endpoint previously did) because it's
   // the only point where we have a plaintext password to hand to the
   // new Google Workspace account below -- the portal only ever stores
   // a hash, so there's nothing to "pipe in" otherwise.
   const password = generateStrongPassword();
   const resp = await ais.student.update({ where: { id: studentId }, data: { instituteEmail } });
   if (resp) {
      // Update SSO User
      await ais.user.updateMany({ where: { tag: studentId }, data: { username: instituteEmail, password: hashPassword(password) } });
      // Log Login Response
      await ais.log.create({ data: { action: `STUDENT_EMAIL_GENERATED`, user: userId, meta: { instituteEmail } } })

      // Provision the Google Workspace account -- best-effort: this
      // never blocks or fails the email-generation response itself.
      // gsuiteSynced/gsuiteSyncedAt let staff see (and retry, via
      // retryGsuiteSync) accounts that failed to provision.
      try {
         const admissionYear = (st?.entryDate ? moment(st.entryDate) : moment()).format('YYYY');
         const gs = await createGsuiteUser({
            email: instituteEmail, password, year: admissionYear,
            firstName: st?.fname, middleName: st?.mname, lastName: st?.lname,
            phone: st?.phone, personalEmail: st?.email,
            studentId: st?.id, indexno: st?.indexno,
            program: st?.program?.longName,
         });
         if (gs.ok) {
            await ais.student.update({ where: { id: studentId }, data: { gsuiteSynced: true, gsuiteSyncedAt: new Date() } });
            await ais.log.create({ data: { action: `STUDENT_GSUITE_ACCOUNT_CREATED`, user: userId, meta: { instituteEmail } } });
         } else if (!gs.skipped) {
            await ais.log.create({ data: { action: `STUDENT_GSUITE_SYNC_FAILED`, user: userId, meta: { instituteEmail, error: gs.error } } });
            console.log('generateStudentEmail GSuite provisioning failed:', gs.error)
         }
      } catch (gsError: any) {
         console.log('generateStudentEmail GSuite provisioning threw:', gsError?.message)
      }

      // Send Credentials By SMS — isolated in its own try/catch (matching
      // stageStudentAccess/resetStudent): a gateway hiccup shouldn't turn
      // an already-successful email generation into a 500.
      if (sendSms && st?.phone) {
         try {
            await sms(st.phone, smsText ? smsText(instituteEmail, password) : `Hi! Your institutional email has been created: ${instituteEmail}, password: ${password}`)
         } catch (smsError: any) {
            console.log('generateStudentEmail SMS send failed:', smsError?.message)
         }
      }
   }
   return resp;
}

// A student editing their own record (student portal web form, Akatsico
// mobile app) via PATCH /students/:id. Only these fields are accepted --
// anything else in the body (status flags, programme, entryDate, admission
// type, scholarship...) is ignored, since those stay admin-only. `email` is
// the personal email; the institutional email is admin-only.
const STUDENT_SELF_TEXT_FIELDS = ['phone', 'email', 'hometown', 'address', 'ghcardNo', 'guardianName', 'guardianPhone'];
const STUDENT_SELF_RELATIONS: Record<string, string> = { titleId: 'title', religionId: 'religion', regionId: 'region', countryId: 'country' };
const RESIDENTIAL_STATUSES = ['RESIDENTIAL', 'NON_RESIDENTIAL'];

class StudentSelfEditError extends Error {}

// NHIS number, admission type and scholarship from the AIS (admin) student
// form. Admission type is REGULAR or FEE_PAYING; the scholarship institution
// is only kept while the student is on a scholarship.
const ADMIT_TYPES = ['REGULAR', 'FEE_PAYING'];
function normaliseAdmissionFields(body: any) {
   if (body.nhisNo !== undefined) body.nhisNo = body.nhisNo?.toString()?.trim() || null;
   if (body.admitType !== undefined) body.admitType = ADMIT_TYPES.includes(body.admitType) ? body.admitType : null;
   if (body.scholar !== undefined) body.scholar = [true, 1, 'true', '1', 'YES', 'yes'].includes(body.scholar);
   if (body.scholarBody !== undefined) body.scholarBody = body.scholarBody?.toString()?.trim() || null;
   if (body.scholar === false) body.scholarBody = null;
}

async function updateOwnStudentProfile(studentId: string, body: any) {
   return ais.$transaction(async (tx: any) => {
      // Serialize one-time confirmations so concurrent saves cannot choose two halls.
      await tx.$queryRaw`SELECT id FROM ais_student WHERE id = ${studentId} FOR UPDATE`;
      const st = await tx.student.findUnique({ where: { id: studentId } });
      if (!st) throw new StudentSelfEditError('Student record not found!');

      const data: any = {};
      const changed: string[] = [];
      for (const k of STUDENT_SELF_TEXT_FIELDS) {
         if (body[k] === undefined) continue;
         data[k] = body[k]?.toString()?.trim() || null;
      }
      for (const [k, rel] of Object.entries(STUDENT_SELF_RELATIONS)) {
         if (body[k]) data[rel] = { connect: { id: body[k] } };
      }
      if (body.majorId) data.major = body.majorId == 'NONE' ? { disconnect: true } : { connect: { id: body.majorId } };
      // Disability: "NONE" (or empty) clears it.
      if (body.disabilityId !== undefined) {
         data.disability = !body.disabilityId || body.disabilityId == 'NONE' ? { disconnect: true } : { connect: { id: body.disabilityId } };
      }
      if (body.residentialStatus) {
         if (!RESIDENTIAL_STATUSES.includes(body.residentialStatus)) throw new StudentSelfEditError('Invalid Residential Status!');
         data.residentialStatus = body.residentialStatus;
      }

      // Date of Birth -- self-editable once. Re-submitting the current value
      // (the form always posts it) is not an edit and doesn't use it up.
      if (body.dob) {
         const ymd = body.dob.toString().slice(0, 10);
         const dob = new Date(`${ymd}T00:00:00.000Z`);
         if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || isNaN(dob.getTime())) throw new StudentSelfEditError('Invalid Date of Birth!');
         if (st.dob?.toISOString()?.slice(0, 10) !== ymd) {
            if (st.dobEditedAt) throw new StudentSelfEditError('Date of Birth has already been changed once. Contact the College Registry for further corrections.');
            const age = moment().diff(moment.utc(ymd), 'years');
            if (age < 10 || age > 100) throw new StudentSelfEditError('Date of Birth is out of range!');
            data.dob = dob;
            data.dobEditedAt = new Date();
            changed.push('dob');
         }
      }

      // Existing affiliation is confirmed, never replaced through a profile save.
      const hallName = typeof body.instituteAffliate === 'string' ? body.instituteAffliate.trim() : '';
      if (!st.affiliateEditedAt && (st.originalHallId || st.semesterNum === 1)) {
         if (!hallName) throw new StudentSelfEditError('Confirm your original Hall of Affiliation before saving your profile.');
         if (st.originalHallId) {
            const original = await tx.residenceHall.findUnique({ where: { id: st.originalHallId } });
            if (![st.instituteAffliate, original?.name].some(n => n?.trim().toUpperCase() === hallName.toUpperCase())) throw new StudentSelfEditError('Your original hall is already recorded. Room transfers are managed in the Hall Module.');
         } else {
            const hall = await tx.residenceHall.findUnique({ where: { name: hallName } });
            await initialAffiliation(tx, st, hall, studentId, 'SELF', 'Fresher profile confirmation');
            changed.push('instituteAffliate');
         }
         data.affiliateEditedAt = new Date();
      } else if (body.instituteAffliate !== undefined && hallName.toUpperCase() !== (st.instituteAffliate || '').trim().toUpperCase()) {
         throw new StudentSelfEditError('Your original hall cannot be changed here. Contact the College Registry.');
      }

      const resp = await tx.student.update({ where: { id: studentId }, data });
      await tx.log.create({
         data: {
            action: `STUDENT_PROFILE_SELF_UPDATED`, user: studentId, student: studentId, meta: {
               fields: Object.keys(data),
               ...changed.includes('dob') && ({ dob: { from: st.dob, to: data.dob } }),
               ...changed.includes('instituteAffliate') && ({ instituteAffliate: { from: st.instituteAffliate, to: data.instituteAffliate } }),
            }
         }
      });
      return resp;
   });
}

// Service letters: only the letter's own fields are saved. Letters are
// fetched by category tag (e.g. 'def', 'vc'), so a tag may be used once.
const LETTER_FIELDS = ['title', 'tag', 'signatory', 'signature', 'template', 'cc'];
function letterFields(body: any) {
   const data: any = {};
   for (const k of LETTER_FIELDS) if (body?.[k] !== undefined) data[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
   if (body?.status !== undefined) data.status = body.status === true || body.status === 'true' || body.status == 1;
   return data;
}
const letterTagClash = (tag: string, exceptId?: string) =>
   ais.letter.findFirst({ where: { tag, ...(exceptId && { id: { not: exceptId } }) }, select: { title: true } });

// Admission letters (ams_letter): one active template per programme,
// printed for its newly admitted first years (Year 1, not completed or
// graduated). Each printed letter carries the student, the default session
// and the programme's first-year bill for that session (for ::fee_amount).
const ADMISSION_LETTER_FIELDS = ['title', 'programId', 'category', 'signatory', 'signature', 'template', 'smsTemplate'];
function admissionLetterFields(body: any) {
   const data: any = {};
   for (const k of ADMISSION_LETTER_FIELDS) if (body?.[k] !== undefined) data[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
   if (body?.status !== undefined) data.status = body.status === true || body.status === 'true' || body.status == 1;
   if (data.programId === '') data.programId = null;
   if (data.smsTemplate === '') data.smsTemplate = null;
   if (body?.year !== undefined) {
      const y = parseInt(String(body.year), 10);
      data.year = Number.isNaN(y) ? null : y;
   }
   return data;
}
const ADMISSION_STUDENT_SELECT = {
   id: true, indexno: true, fname: true, mname: true, lname: true, gender: true, semesterNum: true,
   entryDate: true, entryGroup: true, residentialStatus: true, address: true, hometown: true, phone: true, email: true,
   deferStatus: true, programId: true,
   title: { select: { label: true } },
   program: { select: { id: true, longName: true, shortName: true, category: true, semesterTotal: true } },
   major: { select: { longName: true, shortName: true } },
};
const FIRST_YEAR_WHERE = { semesterNum: { in: [1, 2] }, completeStatus: false, graduateStatus: false };

// A fresher with an admission offer only gets the admission/profile/fees
// part of the portal until they've ACCEPTED and cleared their fees
// (accountNet <= 0 -- positive means owing, as on the debtors list -- or a
// fee pardon). Continuing students (no offer) are never locked. The
// portal's AISPLayout applies the same rule (frontend utils/admission.ts).
const admissionLocked = (st: any) =>
   st?.semesterNum == 1 && !!st?.admissionStatus
   && (st.admissionStatus !== 'ACCEPTED' || !((Number(st.accountNet) || 0) <= 0 || st.flagPardon));

// Admission notice SMS from the letter's smsTemplate (the admission letter
// form lists the same ::tokens). ::login is the new account's username +
// password, or a pointer to the existing login -- appended when the
// template leaves it out, so credentials are never dropped.
// Title case like the letter's ::program_name (frontend util capitalise):
// programme names are stored in capitals.
const SMS_SMALL_WORDS = new Set(['of', 'in', 'and', 'the', 'for', 'to', 'a', 'an', 'on', 'at', 'with']);
const capitalise = (s?: string | null) =>
   (s || '').toLowerCase().split(/(\s+)/)
      .map((w, i) => (i > 0 && SMS_SMALL_WORDS.has(w) ? w : w.replace(/(^|[-'’])([a-z])/g, (_m, p, c) => p + c.toUpperCase())))
      .join('');
const DEFAULT_ADMISSION_SMS = 'Congratulations ::first_name! You have been admitted into ::program. Log in to the student portal (::portal_url) to view your admission letter and accept or reject the offer. ::login';
function admissionSmsText(template: string | null | undefined, st: any, letter: any, login: string) {
   const tpl = template?.trim() || DEFAULT_ADMISSION_SMS;
   const first = (st?.fname || '').trim().split(/\s+/)[0] || '';
   const tokens: Record<string, string> = {
      // Names/programme are title-cased; ::login (username + password) is
      // passed through untouched -- the password is case-sensitive.
      '::first_name': capitalise(first),
      '::full_name': capitalise([st?.fname, st?.mname, st?.lname].filter(Boolean).join(' ')),
      '::student_id': st?.id || '',
      '::program': capitalise(letter?.program?.longName) || 'your programme',
      '::session_year': letter?.year ? `${letter.year}/${letter.year + 1}` : '',
      '::portal_url': process.env.UMS_DOMAIN || 'the student portal',
      '::login': login,
   };
   const text = tpl.includes('::login') ? tpl : `${tpl} ::login`;
   return text.replace(/::[a-z_]+/g, (t) => tokens[t] ?? t).replace(/\s+/g, ' ').replace(/\s+([!.,])/g, '$1').trim();
}

const activeAdmissionLetter = (programId: string) =>
   ais.admissionLetter.findFirst({ where: { programId, status: true }, orderBy: { updatedAt: 'desc' } });

// Students a letter is for: admitted (entryDate) in the letter's year, or --
// for a letter without a year -- the current Year 1.
const admissionCohortWhere = (letter: any) =>
   letter?.year
      ? { entryDate: { gte: new Date(Date.UTC(letter.year, 0, 1)), lt: new Date(Date.UTC(letter.year + 1, 0, 1)) }, completeStatus: false, graduateStatus: false }
      : FIRST_YEAR_WHERE;

async function admissionPrintBundle(programId: string, students: any[], knownLetter?: any) {
   const [letter, session] = await Promise.all([
      knownLetter !== undefined ? knownLetter : activeAdmissionLetter(programId),
      ais.session.findFirst({ where: { default: true } }),
   ]);
   const bills = session ? await ais.bill.findMany({
      where: { sessionId: session.id, programId, status: true, OR: getBillCodePrisma(1) },
      include: { bankacc: true },
      orderBy: { createdAt: 'desc' },
   }) : [];
   const billFor = (s: any) => bills.find((b: any) => b.type === (s.entryGroup || 'GH')) || bills[0] || null;
   return { letter, session, students: students.map((s: any) => ({ ...s, bill: billFor(s) })) };
}

// Shared tail of the bulk student uploads (uploadStudent, uploadFresher):
// rejects ids/index numbers that already exist, creates the whole batch
// all-or-nothing, then (if `provision`) sets up portal access + institute
// email per student. Returns the HTTP status/body for the caller to send.
// Every failure body carries `stage` (where it came from: 'existing' =
// clashes with records already in the system, 'database' = the save
// itself) and `errors` [{ id, row?, column?, value?, reason }] for the
// upload dialog's problem table.
// `skipExisting`: save the students who don't exist yet and report the
// ones already in the system as `skipped`, instead of rejecting the batch.
async function createStudentBatch(allStudents: any[], createdBy: string, action: string, opts: { provision?: boolean; idLabel?: string; rowOf?: Map<string, number>; skipExisting?: boolean } = {}) {
   const { provision = true, idLabel = 'ApplicantID', rowOf, skipExisting = false } = opts;
   let students = allStudents;
   let skipped: { id: string; row?: number; column: string; value: string; reason: string }[] = [];
   const existing = await ais.student.findMany({ where: { id: { in: students.map((s) => s.id) } }, select: { id: true } });
   if (existing.length && skipExisting) {
      const ids = new Set<string>(existing.map((s: any) => s.id));
      skipped = [...ids].map((id) => ({ id, row: rowOf?.get(id), column: idLabel, value: id, reason: `${idLabel} already exists in the system, skipped` }));
      students = students.filter((s) => !ids.has(s.id));
      if (!students.length) {
         return {
            status: 400, body: {
               stage: 'existing',
               message: `Nothing was saved: all ${allStudents.length} ${idLabel}(s) in the sheet already exist in the system (already uploaded?).`,
               failedCount: skipped.length,
               totalCount: allStudents.length,
               errors: skipped,
            }
         };
      }
   } else if (existing.length) {
      const ids = existing.map((s: any) => s.id);
      return {
         status: 400, body: {
            stage: 'existing',
            message: `Upload rejected, nothing was saved: ${ids.length} of ${students.length} ${idLabel}(s) already exist in the system (already uploaded?): ${ids.join(', ')}.`,
            failedCount: ids.length,
            totalCount: students.length,
            errors: ids.map((id: any) => ({ id, row: rowOf?.get(id), column: idLabel, value: id, reason: `${idLabel} already exists in the system` })),
         }
      };
   }

   // Index numbers already held by another student would fail the
   // unique constraint mid-transaction -- reject up front instead.
   const indexnos = students.map((s) => s.indexno).filter(Boolean);
   const takenIndex = indexnos.length ? await ais.student.findMany({ where: { indexno: { in: indexnos } }, select: { id: true, indexno: true } }) : [];
   if (takenIndex.length) {
      return {
         status: 400, body: {
            stage: 'existing',
            message: `Upload rejected, nothing was saved: ${takenIndex.length} index number(s) already belong to existing students: ${takenIndex.map((s: any) => s.indexno).join(', ')}.`,
            failedCount: takenIndex.length,
            totalCount: students.length,
            errors: takenIndex.map((s: any) => ({ id: s.indexno, reason: `Index number already used by student ${s.id}` })),
         }
      };
   }

   // All-or-nothing so a bad row (e.g. an invalid programId/majorId)
   // doesn't leave the batch half-created. A failed insert is tagged with
   // its student so the error says which row broke the batch.
   let resp: any[];
   try {
      resp = await ais.$transaction(async (tx: any) => {
         const created = [];
         for (const s of students) {
            const { programId, majorId, ...rest } = s;
            try {
               const row = await tx.student.create({
                  data: {
                     ...rest,
                     ...programId && ({ program: { connect: { id: programId } } }),
                     ...majorId && ({ major: { connect: { id: majorId } } }),
                  },
               });
               created.push(await recordAdmissionHall(tx, row, createdBy));
            } catch (rowError: any) {
               rowError.studentId = s.id;
               throw rowError;
            }
         }
         await tx.log.create({ data: { action, user: createdBy, meta: { count: created.length, ids: created.map((c: any) => c.id), skipped: skipped.map((k) => k.id) } } });
         return created;
         // Prisma's default 5s interactive-transaction timeout is too short
         // for a full cohort (1,000+ inserts); give large uploads room.
      }, { maxWait: 10000, timeout: 300000 });
   } catch (txError: any) {
      console.log(`${action} failed${txError?.studentId ? ` at ${txError.studentId}` : ''}:`, txError);
      const id = txError?.studentId;
      const reason = errorMessage(txError, 'The database could not save the students.');
      return {
         // Known Prisma request errors (bad reference, duplicate, missing
         // column...) are the data's/setup's fault; anything else is ours.
         status: txError?.code ? 400 : 500, body: {
            stage: 'database',
            message: `Upload rolled back, nothing was saved. ${id ? `Saving ${idLabel} ${id}${rowOf?.get(id) ? ` (row ${rowOf.get(id)})` : ''} failed: ` : ''}${reason}`,
            totalCount: students.length,
            errors: id ? [{ id, row: rowOf?.get(id), reason }] : [{ reason }],
         }
      };
   }

   // Auto-provision portal access + institute email (and, through it,
   // the Google Workspace account) for every newly created student --
   // mirrors the "Stage Account" then "Generate Email" buttons on
   // AISAccountCard, so an uploaded student is immediately usable
   // instead of needing 2 manual clicks each. Run outside the DB
   // transaction above (these calls touch SMS/Google APIs, not just
   // the database) and per-student, so one student's failure here
   // can't undo another's already-committed account -- staff can
   // finish provisioning any listed failures manually via that
   // student's Account tab.
   const provisioned: string[] = [];
   const provisionErrors: { id: string; reason: string }[] = [];
   for (const s of (provision ? resp : [])) {
      try {
         await stageStudentAccess(s.id, createdBy, false);
         await generateStudentEmail(s.id, createdBy);
         provisioned.push(s.id);
      } catch (provisionError: any) {
         provisionErrors.push({ id: s.id, reason: provisionError?.message || 'Failed to stage account / generate email' });
      }
   }

   return { status: 200, body: { success: true, count: resp.length, totalCount: allStudents.length, data: resp, provisioned: provisioned.length, provisionErrors, skipped } };
}

export default class AisController {

   async fetchTest(req: Request, res: Response) {
      try {
         const tag = '24010001';
         const resp = await ais.election.findMany({
            // where: { voterList: { array_contains: tag }},
            where: { voterData: { path: '$[*].tag', array_contains: tag } },
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Reports */
   // GTEC statutory return: one table per request, as its own Excel file
   // laid out exactly like GTEC's sample (see util/statutoryReport.ts).
   async exportStatutoryReport(req: Request, res: Response) {
      try {
         const { table, gsession } = req.body;
         const { file, workbook } = await buildStatutoryReport(String(table || ''), { gsession: gsession || undefined });
         res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
         res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"`);
         res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
         await workbook.xlsx.write(res);
         res.end();
      } catch (error: any) {
         console.log(error)
         return res.status(error instanceof StatutoryReportError ? 400 : 500).json({ message: error.message || 'Report generation failed' })
      }
   }

   async loadReport(req: Request, res: Response) {
      try {
         let { type, program, major, year, session, gsession, rsession, category } = req.body;
         let resp: any = { type };

         if (type == 'student_registration') {
            let regs = await ais.activityRegister.findMany({
               where: {
                  session: { default: true },
                  ...program && ({ student: { programId: program } }),
                  ...major && ({ student: { majorId: major } }),
                  ...year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } }),
               },
               include: { student: { include: { program: true, major: true } }, session: true },
               orderBy: [
                  { session: { createdAt: 'asc' } },
                  { student: { programId: 'asc' } },
                  { student: { majorId: 'asc' } },
                  { student: { semesterNum: 'asc' } },
                  { student: { lname: 'asc' } },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.student?.lname?.toUpperCase(),
                  'FIRST NAME': r.student?.fname?.toUpperCase(),
                  'MIDDLE NAME(S)': r.student?.mname?.toUpperCase(),
                  'INDEX NUMBER': r.student?.indexno,
                  'STUDENT ID': r.student?.id,
                  'GENDER': r.student?.gender,
                  'YEAR': Math.ceil(r.semesterNum / 2),
                  'ACADEMIC SESSION': r.session?.title,
                  'PROGRAM': r.student?.program?.shortName,
                  'MAJOR': r.student?.major?.shortName,
                  'COURSES': r.courses,
                  'REGISTRATION DATE': r.createdAt
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'student_deferment') {
            let regs = await ais.activityDefer.findMany({
               where: {
                  ...program && ({ student: { programId: program } }),
                  ...major && ({ student: { majorId: major } }),
                  ...year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } }),
               },
               include: { student: { include: { program: true, major: true } } },
               orderBy: [
                  { student: { programId: 'asc' } },
                  { student: { majorId: 'asc' } },
                  { student: { semesterNum: 'asc' } },
                  { student: { lname: 'asc' } },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.student?.lname?.toUpperCase(),
                  'FIRST NAME': r.student?.fname?.toUpperCase(),
                  'MIDDLE NAME(S)': r.student?.mname?.toUpperCase(),
                  'INDEX NUMBER': r.student?.indexno,
                  'STUDENT ID': r.student?.id,
                  'GENDER': r.student?.gender,
                  'YEAR': Math.ceil(r.semesterNum / 2),
                  'PROGRAM': r.student?.program?.shortName,
                  'MAJOR': r.student?.major?.shortName,
                  'DURATION': r.durationInYears,
                  'RESUMPTION DATE': r.end
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'student_debtor') {
            let regs = await ais.student.findMany({
               where: {
                  //completeStatus: false,
                  accountNet: { gt: 0 },
                  ...program && ({ programId: program }),
                  ...major && ({ majorId: major }),
                  ...year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } }),
               },
               include: { program: true, major: true },
               orderBy: [
                  { programId: 'asc' },
                  { majorId: 'asc' },
                  { semesterNum: 'asc' },
                  { lname: 'asc' },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.lname?.toUpperCase(),
                  'FIRST NAME': r.fname?.toUpperCase(),
                  'MIDDLE NAME(S)': r.mname?.toUpperCase(),
                  'INDEX NUMBER': r.indexno,
                  'STUDENT ID': r.id,
                  'GENDER': r.gender,
                  'YEAR': Math.ceil(r.semesterNum / 2),
                  'PROGRAM': r.program?.shortName,
                  'MAJOR': r.major?.shortName,
                  'STUDENT ACCOUNT NET': r.accountNet,
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'student_profile') {
            let regs = await ais.student.findMany({
               where: {
                  completeStatus: false,
                  ...program && ({ programId: program }),
                  ...major && ({ majorId: major }),
                  ...year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } }),
               },
               include: { program: true, major: true },
               orderBy: [
                  { programId: 'desc' },
                  { majorId: 'asc' },
                  { semesterNum: 'asc' },
                  { lname: 'asc' },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.lname?.toUpperCase(),
                  'FIRST NAME': r.fname?.toUpperCase(),
                  'MIDDLE NAME(S)': r.mname?.toUpperCase(),
                  'INDEX NUMBER': r.indexno,
                  'STUDENT ID': r.id,
                  'GENDER': r.gender,
                  'YEAR': Math.ceil(r.semesterNum / 2),
                  'PROGRAM': r.program?.shortName,
                  'MAJOR': r.major?.shortName,
                  'STATUS': r.deferStatus == 1 ? 'DEFERRED' : 'ACTIVE',
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'exam_eligible') {
            let regs = await ais.student.findMany({
               where: {
                  OR: [
                     { accountNet: { lte: 0 } },
                     { flagPardon: true },
                  ],
                  AND: [
                     { completeStatus: false },
                     { ...program && ({ programId: program }) },
                     { ...major && ({ majorId: major }) },
                     { ...year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } }) },
                  ],
               },
               include: { program: true, major: true },
               orderBy: [
                  { programId: 'desc' },
                  { majorId: 'asc' },
                  { semesterNum: 'asc' },
                  { lname: 'asc' },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.lname?.toUpperCase(),
                  'FIRST NAME': r.fname?.toUpperCase(),
                  'MIDDLE NAME(S)': r.mname?.toUpperCase(),
                  'INDEX NUMBER': r.indexno,
                  'STUDENT ID': r.id,
                  'GENDER': r.gender,
                  'YEAR': Math.ceil(r.semesterNum / 2),
                  'PROGRAM': r.program?.shortName,
                  'MAJOR': r.major?.shortName,
                  'STATUS': r.deferStatus == 1 ? 'DEFERRED' : 'ACTIVE',
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'resit') {
            let regs = await ais.resit.findMany({
               where: {
                  OR: [
                     { ...session && ({ session: { default: true } }) },
                     { ...rsession && ({ trailSession: { default: true } }) },
                  ]
               },
               include: { course: true, student: { include: { program: true, major: true } } },
               orderBy: [
                  { student: { programId: 'asc' } },
                  { student: { majorId: 'asc' } },
                  { student: { semesterNum: 'asc' } },
                  { student: { lname: 'asc' } },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.student.lname?.toUpperCase(),
                  'FIRST NAME': r.student.fname?.toUpperCase(),
                  'MIDDLE NAME(S)': r.student.mname?.toUpperCase(),
                  'INDEX NUMBER': r.student?.indexno,
                  'STUDENT ID': r.student?.id,
                  'GENDER': r.student.gender,
                  'YEAR': Math.ceil(r.student.semesterNum / 2),
                  'PROGRAM': r.student.program?.shortName,
                  'COURSE': `${r.course?.title} - ${r.course?.id}`,
                  'REGISTRATION DATE': r.registeredAt ? 'YES' : 'NO',
                  'PAYMENT STATUS': r.paid ? 'YES' : 'NO',
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'graduate_list') {
            let regs = await ais.graduate.findMany({
               where: {
                  ...gsession && ({ graduateSession: { default: true } }),
               },
               include: { graduateSession: true, student: { include: { program: true, major: true } } },
               orderBy: [
                  { student: { programId: 'asc' } },
                  { student: { majorId: 'asc' } },
                  { student: { semesterNum: 'asc' } },
                  { student: { lname: 'asc' } },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.student.lname?.toUpperCase(),
                  'FIRST NAME': r.student.fname?.toUpperCase(),
                  'MIDDLE NAME(S)': r.student.mname?.toUpperCase(),
                  'INDEX NUMBER': r.student?.indexno,
                  'STUDENT ID': r.student?.id,
                  'GENDER': r.student.gender,
                  'PROGRAM': r.student.program?.shortName,
                  'MAJOR': r.student.major?.shortName,
                  'SESSION': r.graduateSession?.title?.toUpperCase(),
                  'CGPA': r.cgpa,
                  'CLASS': r.class,
               }))
               resp = { ...resp, data: regs }
            }

         } else if (type == 'staff') {
            let regs = await ais.staff.findMany({
               where: {
                  ...category && ({ unit: { type: category } }),
               },
               include: { job: true, unit: true },
               orderBy: [
                  { staffNo: 'asc' },
               ]
            })
            if (regs.length) {
               regs = regs.map((r: any) => ({
                  'LAST NAME': r.lname?.toUpperCase(),
                  'FIRST NAME': r.fname?.toUpperCase(),
                  'MIDDLE NAME(S)': r.mname?.toUpperCase(),
                  'STAFF NUMBER': r.staffNo,
                  'PHONE NUMBER': r.phone,
                  'EMAIL': r?.email,
                  'INSTITUTIONAL EMAIL': r.instituteEmail,
                  'UNIT': r.unit?.title?.toUpperCase(),
                  'DESIGNATION': r.job?.title?.toUpperCase(),
                  'STAFF STATUS': r.staffStatus,
               }))
               resp = { ...resp, data: regs }
            }
         }

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Dashboard & Statistics */
   async loadDashboard(req: Request, res: Response) {
      try {
         // Main Statistics
         // const students:any = await ais.student.findMany({ where: { default: true } }); // students

         // Academic Session Statistics
         const sessions: any = await ais.session.findMany({ where: { default: true } }); // Sessions
         const academic = await Promise.all(sessions.map(async (s: any) => {
            // Registered
            const reg: any = await ais.activityRegister.findMany({ where: { sessionId: s.id } });
            // const unregister:any = await ais.activityRegister.findMany({ where: { sessionId: s.id, student: { gender: 'F' }} });
            // No more MAIN/January-SUB stream split -- every active student.
            const unreg: any = await ais.$queryRaw`select id from ais_student s where completeStatus = 0 and deferStatus = 0 and indexno not in (select indexno from ais_activity_register where sessionId = ${s.id})`;
            return ({
               label: s.title,
               register: reg?.length,
               unregister: unreg?.length
            })
         }));

         // Resit Session Statistics
         const rsession: any = await ais.resitSession.findFirst({ where: { default: true } }); // Resit Sessions
         const reg_resit: any = await ais.resit.count({ where: { resitSession: { default: true }, registeredAt: { not: null }, taken: false } }); // Registered Resits
         const all_resit: any = await ais.resit.count({ where: { resitSessionId: null } }); // All Students Resits
         const cs_resit: any = await ais.resit.groupBy({
            by: ['courseId'],
            where: { resitSession: { default: true }, registeredAt: { not: null }, taken: false },
            _count: {
               courseId: true
            }
         });

         // const cs_resit:any = await ais.student.groupBy({ 
         //    by: ['programId'], 
         //    where: { programId: 'dcd0771d-a587-4242-a46e-8ee2bf0bad31' },
         //    _count:{
         //       programId: true,
         //    }, 
         // }); 

         //console.log("text", cs_resit);
         const resit = {
            label: rsession?.title,
            register: reg_resit,
            estimate: all_resit,
            courses: cs_resit?.length || 0,
         }

         // Graduation Session Statistics
         const gsession: any = await ais.graduateSession.findFirst({ where: { default: true } }); // Resit Sessions
         const graduand: any = await ais.graduate.count({ where: { graduateSession: { default: true } } }); // Registered Resits
         const completed: any = await ais.student.count({ where: { completeStatus: true, graduateStatus: false } }); // All Students Resits
         const graduation = {
            label: gsession?.title,
            graduand,
            complete: completed,
         }

         // Student Statistics
         const mactive: any = await ais.student.count({ where: { completeStatus: false, deferStatus: false, gender: 'M' } });
         const factive: any = await ais.student.count({ where: { completeStatus: false, deferStatus: false, gender: 'F' } });
         const mdefer: any = await ais.student.count({ where: { completeStatus: false, deferStatus: true, gender: 'M' } });
         const fdefer: any = await ais.student.count({ where: { completeStatus: false, deferStatus: true, gender: 'F' } });
         const mcomplete: any = await ais.student.count({ where: { completeStatus: true, deferStatus: false, gender: 'M' } });
         const fcomplete: any = await ais.student.count({ where: { completeStatus: true, deferStatus: false, gender: 'F' } });
         const mgraduate: any = await ais.student.count({ where: { completeStatus: true, deferStatus: false, graduateStatus: true, gender: 'M' } });
         const fgraduate: any = await ais.student.count({ where: { completeStatus: true, deferStatus: false, graduateStatus: true, gender: 'F' } });
         // Students with no (or a non-M/F) gender recorded -- previously left
         // out of every status count, so totals undercounted. `u` per status.
         const noGender = { OR: [{ gender: null }, { gender: { notIn: ['M', 'F'] } }] };
         const uactive: any = await ais.student.count({ where: { completeStatus: false, deferStatus: false, ...noGender } });
         const udefer: any = await ais.student.count({ where: { completeStatus: false, deferStatus: true, ...noGender } });
         const ucomplete: any = await ais.student.count({ where: { completeStatus: true, deferStatus: false, ...noGender } });
         const ugraduate: any = await ais.student.count({ where: { completeStatus: true, deferStatus: false, graduateStatus: true, ...noGender } });



         // Department Statistics -- programmes aren't linked to departments;
         // a department's courses are those assigned to it in the curriculum
         // (structure.unitId), counted once each.
         const depts = await ais.unit.findMany({ where: { type: 'ACADEMIC', levelNum: 2 } });
         const department = await Promise.all(depts.map(async (r: any) => {
            const courses = (await ais.structure.findMany({ where: { unitId: r.id }, distinct: ['courseId'], select: { courseId: true } })).length;
            const staff = await ais.staff.count({ where: { unitId: r.id, status: true } });
            return ({
               label: r.title,
               courses,
               staff
            })
         }));

         // Program Statistics
         const progs = await ais.program.findMany();
         const program = await Promise.all(progs.map(async (r: any) => {
            // // Applicant
            // const m_applicant:any = await ais.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;
            // const f_applicant:any = await ais.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;
            const y1 = await ais.student.count({ where: { programId: r.id, completeStatus: false, semesterNum: { in: [1, 2] } } });
            const y2 = await ais.student.count({ where: { programId: r.id, completeStatus: false, semesterNum: { in: [3, 4] } } });
            const y3 = await ais.student.count({ where: { programId: r.id, completeStatus: false, semesterNum: { in: [5, 6] } } });
            const y4 = await ais.student.count({ where: { programId: r.id, completeStatus: false, semesterNum: { in: [7, 8] } } });

            return ({
               label: r.code,
               y1,
               y2,
               y3,
               y4,
            })
         }));



         let data = {
            sessions: {
               academic,
               resit,
               graduation
            },
            student: {
               active: { f: factive, m: mactive, u: uactive },
               defer: { f: fdefer, m: mdefer, u: udefer },
               complete: { f: fcomplete, m: mcomplete, u: ucomplete },
               graduate: { f: fgraduate, m: mgraduate, u: ugraduate }
            },
            department,
            program,
         }

         if (data) {
            res.status(200).json(data)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Session */
   async fetchSessionList(req: Request, res: Response) {
      try {
         const resp = await ais.session.findMany({ where: { status: true }, orderBy: { createdAt: 'desc' } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchSessions(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = { orderBy: { createdAt: 'desc' } }
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
                  { id: { contains: keyword } },
               ],
            },
            orderBy: { createdAt: 'desc' }
         }
         const resp = await ais.$transaction([
            ais.session.count({
               ...(searchCondition),
            }),
            ais.session.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchSession(req: Request, res: Response) {
      try {
         const resp = await ais.session.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async activateSession(req: Request, res: Response) {
      try {
         const { sessionId } = req.body;

         // Only one session can be the default at a time (no more per-tag
         // defaults now that MAIN/January-SUB stream is gone).
         const resx = await ais.session.updateMany({ where: { NOT: { id: sessionId } }, data: { default: false } })
         const resp = await ais.session.update({ where: { id: sessionId }, data: { default: true } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchRegistrationReminderCount(req: Request & any, res: Response) {
      try {
         const session = await ais.session.findUnique({ where: { id: paramStr(req.params.id) } });
         if (!session) return res.status(202).json({ message: `no record found` });
         const eligible = await unregisteredStudentsForSession(session.id);
         res.status(200).json({ count: eligible.length, session: { title: session.title } });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async sendRegistrationReminder(req: Request & any, res: Response) {
      try {
         const session = await ais.session.findUnique({ where: { id: paramStr(req.params.id) } });
         if (!session) return res.status(202).json({ message: `no record found` });
         const eligible = await unregisteredStudentsForSession(session.id);
         const message = `Hi! Reminder: You have not yet registered for the ${session.title} semester. As a GTEC requirement, all students must register each semester or risk automatic deferment of their programme. Please register promptly.`;
         const sent = await Promise.all(eligible.map(async (st: any) => {
            try {
               const phone = st.phone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();
               await sms(phone, message);
               return true;
            } catch (smsError: any) {
               console.log('sendRegistrationReminder SMS send failed:', smsError?.message)
               return false;
            }
         }));
         const count = sent.filter(Boolean).length;
         await ais.log.create({ data: { action: `SEND_REGISTRATION_REMINDER`, user: req?.userId, meta: { sessionId: session.id, count } } });
         res.status(200).json({ count: eligible.length, sent: count });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchResitReminderCount(req: Request & any, res: Response) {
      try {
         const uniqueStudents = await unresolvedResitStudentsForSession(paramStr(req.params.id));
         res.status(200).json({ count: uniqueStudents.size });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async sendResitReminder(req: Request & any, res: Response) {
      try {
         const sessionId = paramStr(req.params.id);
         const uniqueStudents = await unresolvedResitStudentsForSession(sessionId);
         const message = `Hi! Reminder: You have an outstanding resit course that has not been registered or paid for. As a GTEC requirement, please complete your resit registration and payment promptly to avoid automatic deferment of your programme.`;
         const sent = await Promise.all(Array.from(uniqueStudents.values()).map(async (rawPhone: any) => {
            try {
               const phone = rawPhone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();
               await sms(phone, message);
               return true;
            } catch (smsError: any) {
               console.log('sendResitReminder SMS send failed:', smsError?.message)
               return false;
            }
         }));
         const count = sent.filter(Boolean).length;
         await ais.log.create({ data: { action: `SEND_RESIT_REMINDER`, user: req?.userId, meta: { sessionId, count } } });
         res.status(200).json({ count: uniqueStudents.size, sent: count });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postSession(req: Request & any, res: Response) {
      try {
         const resp = await ais.session.create({ data: { ...req.body } })
         if (resp) {
            // Log Login Response
            await ais.log.create({ data: { action: `CALENDAR_CREATED`, user: req?.userId, meta: req.body } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateSession(req: Request & any, res: Response) {
      try {
         const resp = await ais.session.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            // Log Login Response
            await ais.log.create({ data: { action: `CALENDAR_UPDATED`, user: req?.userId, meta: req.body } })
            //  Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteSession(req: Request & any, res: Response) {
      try {
         const resp = await ais.session.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            // Log Login Response
            await ais.log.create({ data: { action: `CALENDAR_DELETED`, user: req?.userId, meta: req.body } })
            // Return response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   /* Student */
   async fetchStudents(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { fname: { contains: keyword } },
                  { lname: { contains: keyword } },
                  { id: { contains: keyword } },
                  { phone: { contains: keyword } },
                  { email: { contains: keyword } },
                  { indexno: { contains: keyword } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.student.count({
               ...(searchCondition),
            }),
            ais.student.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  title: { select: { label: true } },
                  country: { select: { longName: true } },
                  region: { select: { title: true } },
                  religion: { select: { title: true } },
                  disability: { select: { title: true } },
                  program: {
                     select: {
                        longName: true,
                     }
                  },
               },
               orderBy: [
                  { completeStatus: 'asc' },
                  { semesterNum: 'asc' }
               ]
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchStudent(req: Request, res: Response) {
      try {
         const resp = await ais.student.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
            include: {
               originalHall: true, currentHall: true,
               title: { select: { label: true } },
               country: { select: { longName: true, nationality: true } },
               region: { select: { title: true } },
               religion: { select: { title: true } },
               disability: { select: { title: true } },
               program: {
                  select: {
                     longName: true,
                     shortName: true,
                     category: true,
                  }
               },
               major: {
                  select: {
                     longName: true,
                     shortName: true,
                  }
               },
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchStudentTranscript(req: Request, res: Response) {
      try {
         const st: any = await ais.student.findFirst({
            where: {
               OR: [
                  {
                     AND: [
                        { indexno: { not: null } },
                        { id: paramStr(req.params.id) }
                     ]
                  },
                  { indexno: paramStr(req.params.id) }
               ]
            },
            select: { indexno: true, fname: true, mname: true, lname: true, id: true, gender: true, entryDate: true, exitDate: true, program: { select: { longName: true, shortName: true, stype: true, category: true } } }
         });

         if (!st) throw ("No index number generated")
         const resp = await ais.assessment.findMany({
            where: {
               indexno: st?.indexno,
            },
            include: {
               //student: true,
               //  student: { include: { program: true } },
               //  student: { select: { indexno: true, fname: true, mname: true, lname: true, id: true, gender: true, entryDate: true, exitDate: true, program: { select: { longName: true, shortName: true, stype: true, category: true } } } },

               scheme: { select: { gradeMeta: true, classMeta: true, passMark: true } },
               session: { select: { title: true, year: true, semester: true } },
               course: { select: { title: true } },
            },
            orderBy: [{ session: { createdAt: 'asc' } }, { sessionId: 'asc' }, { courseId: 'asc' }, { id: 'asc' }]
         });

         if (resp) {
            const groups = transcriptGroups(resp.map((row: any) => ({ ...row, student: st })));

            return res.status(200).json(groups)
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(202).json({ message: error.message })
      }
   }

   // Self-service dashboard summary — the two pieces of a student's own
   // status that have no existing endpoint: outstanding resits, and any
   // late-registration fine already posted (or the configured amount they'd
   // risk). Registration deadline/registered-status and evaluation status
   // are already available from existing endpoints, so aren't duplicated
   // here.
   async fetchStudentNoticeSummary(req: Request, res: Response) {
      try {
         const st: any = await ais.student.findFirst({
            where: {
               OR: [
                  { AND: [{ indexno: { not: null } }, { id: paramStr(req.params.id) }] },
                  { indexno: paramStr(req.params.id) }
               ]
            },
            select: { id: true, indexno: true, entryGroup: true }
         });
         if (!st) return res.status(202).json({ message: `no record found` });

         const [resitRows, fineCharges, lateTranstype] = await Promise.all([
            ais.resit.findMany({
               where: { indexno: st.indexno, taken: false },
               include: {
                  course: { select: { title: true } },
                  trailSession: { select: { title: true } },
               },
               orderBy: { createdAt: 'asc' },
            }),
            ais.charge.findMany({
               where: { studentId: st.id, type: 'FINE' },
               orderBy: { createdAt: 'desc' },
            }),
            ais.transtype.findFirst({ where: { id: 8 } }),
         ]);

         const latestFine = fineCharges[0];
         const configuredAmount = st.entryGroup == 'GH' ? lateTranstype?.amountInGhc : lateTranstype?.amountInUsd;

         return res.status(200).json({
            resit: {
               count: resitRows.length,
               items: resitRows.map((r: any) => ({
                  courseId: r.courseId,
                  courseTitle: r.course?.title,
                  trailSessionTitle: r.trailSession?.title,
               })),
            },
            fine: {
               charged: !!latestFine,
               amount: latestFine?.amount ?? null,
               currency: latestFine?.currency ?? null,
               configuredAmount: configuredAmount ?? null,
               configuredCurrency: st.entryGroup == 'GH' ? 'GHC' : 'USD',
            },
         });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async fetchStudentTranscripts(req: Request, res: Response) {
      try {

         const cacheKey = `transcripts:${JSON.stringify(req.body.key)}`;
         const result = await getOrSetCache(cacheKey, async () => {

            const resp = await ais.broadsheet.findMany({
               where: {
                  indexno: { in: req.body?.data },
               },
               orderBy: { sessionCreatedAt: 'asc' }
            });

            if (resp?.length) {
               var mdata: any = new Map();
               for (const sv of resp) {
                  const index: string = sv.indexno;
                  if (mdata.has(index)) {
                     mdata.set(index, [...mdata.get(index), sv])
                  } else {
                     mdata.set(index, [sv])
                  }
               }

               const vdata = await Promise.all(Array.from(mdata)?.map(async (st: any) => {
                  let [indexno, tdata] = st;
                  let sdata: any = new Map();

                  for (const sv of tdata) {
                     const cindex: string = sv.title ?? 'none';
                     const grades: any = sv.gradeMeta;
                     const classes: any = sv.classMeta;
                     const zd = { ...sv, grade: gradeFor(sv, grades), gradepoint: gradePointFor(sv, grades), classes }
                     // Data By Courses
                     if (sdata.has(cindex)) {
                        sdata.set(cindex, [...sdata.get(cindex), { ...zd }])
                     } else {
                        sdata.set(cindex, [{ ...zd }])
                     }
                  }
                  return [indexno, Array.from(sdata)]
               }))
               return vdata;
            }  
         });
         if(result){
            // Return Response
            return res.status(200).json(result);
         } else {
            return res.status(202).json({ message: `No records` })
         }
        

      } catch (error: any) {
         console.log(error)
         return res.status(202).json({ message: error.message })
      }
   }


   async fetchStudentFinance(req: Request, res: Response) {
      try {
         const resp = await ais.studentAccount.findMany({
            where: { studentId: paramStr(req.params.id) },
            include: {
               student: { select: { fname: true, mname: true, indexno: true, program: { select: { longName: true } } } },
               bill: { select: { narrative: true } },
               charge: { select: { title: true } },
               session: { select: { title: true } },
               transaction: { select: { transtag: true } },
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchStudentActivity(req: Request, res: Response) {
      try {
         const resp = await ais.student.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
            include: {
               country: true,
               program: {
                  select: {
                     longName: true
                  }
               },
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async stageStudent(req: Request & any, res: Response) {
      try {
         const { studentId } = req.body
         const resp = await stageStudentAccess(studentId, req?.userId);
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         // stageStudentAccess throws a specific, user-facing reason (e.g.
         // "Student Portal Account Exists!") -- surface it instead of
         // masking it behind a generic message, matching postStudent and
         // most other handlers in this file.
         return res.status(500).json({ message: error.message || 'Internal server error' })
      }
   }



   async resetStudent(req: Request & any, res: Response) {
      try {
         const { studentId } = req.body;
         const password = generateStrongPassword();
         const st = await ais.student.findFirst({ where: { id: studentId } });

         // Some students have an instituteEmail (and even a synced GSuite
         // account) without ever getting a portal login row -- e.g. Generate
         // Student Email was clicked without Stage Student Access first, or
         // data predates that guarantee. updateMany silently matches zero
         // rows in that case, which used to report success with an
         // undefined password. Reset now guarantees a working login either
         // way: create the missing account instead of no-op'ing.
         const existingUser = await ais.user.findFirst({ where: { tag: studentId } });
         let account: any;
         if (existingUser) {
            account = await ais.user.update({ where: { id: existingUser.id }, data: { password: hashPassword(password) } });
         } else {
            account = await ais.user.create({
               data: { tag: studentId, username: st?.instituteEmail || studentId, password: hashPassword(password), unlockPin: pin(), group: { connect: { id: 1 } } },
            });
         }

         // Keep the Google Workspace account's password in sync too --
         // only if this student actually has one (instituteEmail set).
         // Best-effort: never blocks or fails an already-successful
         // portal password reset.
         if (st?.instituteEmail) {
            try {
               const gs = await updateGsuitePassword({ email: st.instituteEmail, password });
               if (gs.ok) {
                  await ais.student.update({ where: { id: studentId }, data: { gsuiteSynced: true, gsuiteSyncedAt: new Date() } });
               } else if (!gs.skipped) {
                  await ais.log.create({ data: { action: `STUDENT_GSUITE_SYNC_FAILED`, user: req?.userId, meta: { instituteEmail: st.instituteEmail, error: gs.error } } });
                  console.log('resetStudent GSuite password sync failed:', gs.error)
               }
            } catch (gsError: any) {
               console.log('resetStudent GSuite password sync threw:', gsError?.message)
            }
         }

         // Send Password By SMS — normalized the same way forgetPassword
         // does (authController.ts), and isolated in its own try/catch:
         // a gateway hiccup shouldn't turn an already-successful password
         // change into a 500 with no visibility into what actually failed.
         if (st?.phone) {
            const phone = st.phone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();
            try {
               await sms(phone, `Hi! Your new credentials is username: ${account.username}, password: ${password}`)
            } catch (smsError: any) {
               console.log('resetStudent SMS send failed:', smsError?.message)
            }
         }
         // Log Login Response
         // Audit: who reset whose account (no credentials logged).
         await ais.log.create({ data: { action: `STUDENT_ACCOUNT_RESET`, user: req?.userId, student: studentId, meta: { studentId, via: req?.originalUrl, smsSent: !!st?.phone } } })
         // Return Password
         res.status(200).json({ password })

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message || 'Internal server error' })
      }
   }

   async generateIndex(req: Request & any, res: Response) {
      try {
         const { studentId } = req.body;
         let indexno;
         const student = await ais.student.findUnique({
            where: { id: studentId },
            include: { program: { select: { prefix: true, semesterTotal: true } } },
         })
         if (student?.indexno) throw ("Index number exists for student!")

         // AKATSICO INDEX NUMBER FORMAT: <duration><admission year><program prefix><4-digit sequence>
         // e.g. "4252030001" for a B.Ed JHS (prefix "203", semesterTotal 8) student
         // admitted in "20"25 --
         //   4    = program duration in years, Math.ceil(semesterTotal / 2)
         //   25   = admission year, derived from entryDate (else the current year)
         //   203  = program prefix
         //   0001 = sequence among this program's active (not completed --
         //          deferred students still count), already-indexed
         //          students admitted the same year
         const admissionYear = (student?.entryDate ? moment(student.entryDate) : moment()).format("YY");
         const duration = Math.ceil((student?.program?.semesterTotal || 0) / 2);
         const prefix = student?.program?.prefix;

         const peers = await ais.student.findMany({
            where: {
               programId: student?.programId,
               indexno: { not: null },
               completeStatus: false,
            },
            select: { entryDate: true },
         });
         const cohort = peers.filter((p: any) => (p.entryDate ? moment(p.entryDate) : moment()).format("YY") === admissionYear);

         // AKATSICO INDEX NUMBER GENERATION
         let studentCount = cohort.length + 1;
         let loop = true;
         while (loop) {
            // Compute Index Number
            const count = studentCount.toString().length == 1 ? `000${studentCount}` : studentCount.toString().length == 2 ? `00${studentCount}` : studentCount.toString().length == 3 ? `0${studentCount}` : studentCount;
            indexno = `${duration}${admissionYear}${prefix}${count}`
            // Check If Index Number Exists
            const ck = await ais.student.findFirst({ where: { indexno } });
            if (ck) {
               studentCount = studentCount + 1;
            } else {
               loop = false;
            }
         }

         const resp = await ais.student.update({
            where: { id: studentId },
            data: { indexno },
         })
         if (resp) {
            // Send Notfication
            const msg = `Hi ${student.fname}! Your AKATSICO Index number has been generated: ${indexno}, Thank you!`;
            await sms(student?.phone, msg);
            // Log Login Response
            await ais.log.create({ data: { action: `INDEX_NUMBER_GENERATED`, user: req?.userId, meta: { indexno } } })
            // Return Password
            res.status(200).json({ indexno })
         } else {
            res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: 'Internal server error' })
      }
   }

   async generateEmail(req: Request & any, res: Response) {
      try {
         const { studentId } = req.body;
         const resp = await generateStudentEmail(studentId, req?.userId);
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         // generateStudentEmail throws a specific, user-facing reason (e.g.
         // "mail already exists !") -- surface it instead of masking it.
         return res.status(500).json({ message: error.message || 'Internal server error' })
      }
   }

   // Manual retry for a student whose Google Workspace account failed to
   // provision or fell out of sync (gsuiteSynced: false with an
   // instituteEmail already set) -- e.g. after a Google API outage. Issues
   // a fresh password (same reasoning as generateEmail: only plaintext we
   // have to give Google is one minted right now) and tries to create the
   // account; if Google reports it already exists, falls back to just
   // resyncing its password instead.
   async retryGsuiteSync(req: Request & any, res: Response) {
      try {
         const { studentId } = req.body;
         const st = await ais.student.findFirst({ where: { id: studentId }, include: { program: { select: { longName: true } } } });
         if (!st?.instituteEmail) return res.status(202).json({ message: `Student has no institutional email yet -- generate one first.` });

         const password = generateStrongPassword();
         await ais.user.updateMany({ where: { tag: studentId }, data: { password: hashPassword(password) } });

         const admissionYear = (st?.entryDate ? moment(st.entryDate) : moment()).format('YYYY');
         let gs = await createGsuiteUser({
            email: st.instituteEmail, password, year: admissionYear,
            firstName: st.fname, middleName: st.mname, lastName: st.lname,
            phone: st.phone, personalEmail: st.email,
            studentId: st.id, indexno: st.indexno,
            program: st?.program?.longName,
         });
         if (!gs.ok && !gs.skipped && /already exists/i.test(gs.error || '')) {
            gs = await updateGsuitePassword({ email: st.instituteEmail, password });
         }

         if (gs.ok) {
            await ais.student.update({ where: { id: studentId }, data: { gsuiteSynced: true, gsuiteSyncedAt: new Date() } });
            if (st?.phone) {
               try {
                  await sms(st.phone, `Hi! Your Google account credentials: ${st.instituteEmail}, password: ${password}`)
               } catch (smsError: any) {
                  console.log('retryGsuiteSync SMS send failed:', smsError?.message)
               }
            }
            await ais.log.create({ data: { action: `STUDENT_GSUITE_SYNC_RETRIED`, user: req?.userId, meta: { instituteEmail: st.instituteEmail } } });
            return res.status(200).json({ success: true });
         } else if (gs.skipped) {
            return res.status(202).json({ message: `GSuite integration is not configured yet.` });
         } else {
            await ais.log.create({ data: { action: `STUDENT_GSUITE_SYNC_FAILED`, user: req?.userId, meta: { instituteEmail: st.instituteEmail, error: gs.error } } });
            return res.status(500).json({ message: gs.error || 'GSuite sync failed' });
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: 'Internal server error' })
      }
   }

   // Dedicated pardon action (route-gated to student::admin/student::finance,
   // see STUDENT_FINANCE_ROLES in aisRoute.ts) — kept separate from the
   // generic updateStudent PATCH so this specific, finance-sensitive action
   // gets its own audit log entry and role enforcement at the backend, not
   // just the Finance Pardon button's frontend gating.
   async pardonStudent(req: Request & any, res: Response) {
      try {
         const { studentId } = req.body;
         const resp = await ais.student.update({
            where: { id: studentId },
            data: { flagPardon: true },
         })
         if (resp) {
            await ais.log.create({ data: { action: `STUDENT_PARDON_ACTIVATED`, user: req?.userId, meta: { studentId } } })
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: 'Internal server error' })
      }
   }




   async postStudent(req: Request & any, res: Response) {
      try {
         const { titleId, programId, countryId, regionId, religionId, disabilityId, majorId } = req.body
         delete req.body.titleId; delete req.body.programId;
         delete req.body.countryId; delete req.body.regionId;
         delete req.body.religionId; delete req.body.disabilityId;
         delete req.body.majorId;
         //if (req.body.entryDate) req.body.entryDate = moment(req.body.entryDate).toDate;
         req.body.indexno = !req.body.indexno ? null : req.body.indexno;
         req.body.completeType = !req.body.completeType ? null : req.body.completeType;

         //req.body.entryDate  = !req.body.entryDate ? null : moment(req.body.entryDate).toDate();
         req.body.entryDate = toDate(req.body.entryDate);
         req.body.dob = toDate(req.body.dob);
         normaliseAdmissionFields(req.body);

         for (const key of ['originalHallId', 'currentHallId', 'originalHall', 'currentHall', 'originalHallSource', 'roomAssignments', 'hallAffiliationEvents', 'affiliateEditedAt']) delete req.body[key];
         const resp = await ais.$transaction(async (tx: any) => {
         const created = await tx.student.create({
            data: {
               ...req.body,
               ...programId && ({ program: { connect: { id: programId } } }),
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...countryId && ({ country: { connect: { id: countryId } } }),
               ...regionId && ({ region: { connect: { id: regionId } } }),
               ...religionId && ({ religion: { connect: { id: religionId } } }),
               ...disabilityId && ({ disability: { connect: { id: disabilityId } } }),
               // A new student has no prior major to disconnect -- `disconnect`
               // is only valid on update(), not create(). "No major selected"
               // just means the relation is left unset here.
               ...majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }),
            }
         })
         return recordAdmissionHall(tx, created, req.userId);
         });
         if (resp) {
            // Log Login Response
            await ais.log.create({
               data: {
                  action: `STUDENT_CREATED`, user: req?.userId, meta: {
                     ...req.body,
                     ...programId && ({ program: { connect: { id: programId } } }),
                     ...titleId && ({ title: { connect: { id: titleId } } }),
                     ...countryId && ({ country: { connect: { id: countryId } } }),
                     ...regionId && ({ region: { connect: { id: regionId } } }),
                     ...religionId && ({ religion: { connect: { id: religionId } } }),
                     ...disabilityId && ({ disability: { connect: { id: disabilityId } } }),
                     ...majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }),
                  }
               }
            })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(error instanceof ResidenceError ? error.status : 500).json({ message: error.message })
      }
   }

   // Bulk-create students from an uploaded sheet. `ApplicantID` maps
   // directly onto student.id (the same free-typed "Student Number" field
   // the single-create form uses) -- there is no separate id auto-generation
   // for students, unlike indexno. `yearGroup` (1 = Year 1, 2 = Year 2, ...)
   // maps to the first-semester value of that year on student.semesterNum,
   // matching the single-create form's "Program Year and Semester" options
   // (YEAR 1 SEM1 = 1, YEAR 2 SEM1 = 3, YEAR 3 SEM1 = 5, ...).
   async uploadStudent(req: any, res: Response) {
      try {
         const rows = req.body;
         if (!rows?.length) return res.status(202).json({ message: `no records found` });

         const missingId: string[] = [];
         const duplicateInSheet: string[] = [];
         const duplicateIndexInSheet: string[] = [];
         const seenIds = new Set<string>();
         const seenIndexnos = new Set<string>();
         const students: any[] = [];

         rows.forEach((row: any, i: number) => {
            const id = row.ApplicantID?.toString()?.trim();
            if (!id) { missingId.push(`row ${i + 1}`); return; }
            if (seenIds.has(id)) { duplicateInSheet.push(id); return; }
            seenIds.add(id);

            // indexno is unique on ais_student; blank -> null (not yet issued).
            const indexno = row.indexno?.toString()?.trim() || null;
            if (indexno) {
               if (seenIndexnos.has(indexno)) duplicateIndexInSheet.push(indexno);
               seenIndexnos.add(indexno);
            }

            const yearGroup = row.yearGroup != null && row.yearGroup !== '' ? Number(row.yearGroup) : null;
            const semesterNum = yearGroup ? (yearGroup - 1) * 2 + 1 : null;

            students.push({
               id,
               indexno,
               fname: row.fname?.toString()?.trim() || null,
               mname: row.mname?.toString()?.trim() || null,
               lname: row.lname?.toString()?.trim() || null,
               dob: toDate(row.dob) ?? null,
               semesterNum,
               gender: row.gender?.toString()?.trim() || null,
               email: row.email?.toString()?.trim() || null,
               phone: row.phone?.toString()?.trim() || null,
               address: row.address?.toString()?.trim() || null,
               hometown: row.hometown?.toString()?.trim() || null,
               programId: row.programId?.toString()?.trim() || null,
               majorId: row.majorId?.toString()?.trim() || null,
               // Either header spelling maps to the student's hall.
               instituteAffliate: (row.HALL ?? row['HALL OF AFFILIATION'] ?? row.instituteAffliate)?.toString()?.trim() || null,
            });
         });

         if (missingId.length || duplicateInSheet.length || duplicateIndexInSheet.length) {
            return res.status(400).json({
               stage: 'sheet',
               message: `Upload rejected: ${missingId.length ? `ApplicantID is missing for ${missingId.join(', ')}. ` : ''}${duplicateInSheet.length ? `Duplicate ApplicantID within the uploaded sheet: ${duplicateInSheet.join(', ')}. ` : ''}${duplicateIndexInSheet.length ? `Duplicate index number within the uploaded sheet: ${duplicateIndexInSheet.join(', ')}.` : ''}`,
               errors: [
                  ...missingId.map((r) => ({ id: r, reason: 'ApplicantID is required' })),
                  ...duplicateInSheet.map((id) => ({ id, reason: 'Duplicate ApplicantID within the uploaded sheet' })),
                  ...duplicateIndexInSheet.map((id) => ({ id, reason: 'Duplicate index number within the uploaded sheet' })),
               ],
            });
         }

         const { status, body } = await createStudentBatch(students, req.userId, 'STUDENT_BULK_UPLOAD');
         res.status(status).json(body);
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ stage: 'server', message: `Upload failed on the server, nothing was saved: ${errorMessage(error)}`, errors: [] })
      }
   }

   // Bulk-create freshers (new Year 1 admits) from the freshers sheet:
   // Application Number, Last name, First name, Middle name, Gender,
   // Phone Number, Program. Application Number maps onto student.id (as
   // ApplicantID does in uploadStudent), Program is matched against a
   // programme's code, short name or full name, and every fresher starts
   // at Year 1 Sem 1 with entryDate = the 1st of the current month.
   // Accounts/emails aren't created here -- "Activate Admission" on the
   // programme's admission letter does that and texts the admission notice.
   async uploadFresher(req: any, res: Response) {
      try {
         const rows = req.body;
         if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ stage: 'sheet', message: 'The sheet has no rows. Fill in the freshers under the header row of the sample and upload again.', errors: [] });

         // Header spelling/casing varies between sheets ("Last name" vs
         // "LAST NAME" vs "Lastname") -- compare on letters/digits only.
         const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
         const normName = (v: string) => v.toUpperCase().replace(/\s+/g, ' ').trim();
         const cell = (row: any, key: string) => {
            const k = Object.keys(row).find((h) => normKey(h) === key);
            return k ? row[k]?.toString()?.trim() || null : null;
         };

         // Whole-sheet check first: a missing/misspelt column would
         // otherwise come back as one error per row. (The spreadsheet
         // reader drops empty cells, so a column blank on every row also
         // shows up here.)
         const COLUMNS: [string, string][] = [['applicationnumber', 'Application Number'], ['lastname', 'Last name'], ['firstname', 'First name'], ['gender', 'Gender'], ['phonenumber', 'Phone Number'], ['program', 'Program']];
         const headers = new Set<string>(rows.flatMap((r: any) => Object.keys(r || {}).map(normKey)));
         const missingCols = COLUMNS.filter(([k]) => !headers.has(k)).map(([, label]) => label);
         if (missingCols.length) {
            return res.status(400).json({
               stage: 'sheet',
               message: `Upload rejected, nothing was saved: the sheet is missing the column(s) ${missingCols.join(', ')} (or they are empty on every row). Use the headers from the freshers sample.`,
               errors: missingCols.map((column) => ({ column, reason: 'Column missing or empty' })),
            });
         }

         // Active programmes win over retired ones that share a code/name.
         const programs = await ais.program.findMany({ select: { id: true, code: true, shortName: true, longName: true, status: true }, orderBy: { status: 'asc' } });
         const programIds = new Map<string, string>();
         programs.forEach((p: any) => [p.code, p.shortName, p.longName].forEach((v) => v && programIds.set(normName(v), p.id)));

         const now = new Date();
         const entryDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));

         const errors: { row: number; id?: string; column?: string; value?: string; reason: string }[] = [];
         const rowOf = new Map<string, number>();
         const students: any[] = [];

         rows.forEach((r: any, i: number) => {
            const row = i + 2; // sheet row: +1 header, +1 1-based
            const id = cell(r, 'applicationnumber') || undefined;
            const problem = (column: string, value: any, reason: string) => errors.push({ row, id, column, value: value ?? '', reason });

            if (!id) { problem('Application Number', '', 'Application Number is required'); return; }
            if (rowOf.has(id)) { problem('Application Number', id, `Duplicate of row ${rowOf.get(id)} in this sheet`); return; }
            rowOf.set(id, row);

            const fname = cell(r, 'firstname');
            const lname = cell(r, 'lastname');
            if (!fname) problem('First name', '', 'First name is required');
            if (!lname) problem('Last name', '', 'Last name is required');

            const genderRaw = cell(r, 'gender');
            const g = genderRaw?.toUpperCase();
            const gender = g === 'M' || g === 'MALE' ? 'M' : g === 'F' || g === 'FEMALE' ? 'F' : null;
            if (!gender) problem('Gender', genderRaw, genderRaw ? 'Must be M, MALE, F or FEMALE' : 'Gender is required');

            const programName = cell(r, 'program');
            const programId = programName ? programIds.get(normName(programName)) : undefined;
            if (!programId) problem('Program', programName, programName ? 'No programme has this code, short name or full name' : 'Program is required');

            // Excel stores 0244000000 as the number 244000000 -- restore
            // the dropped leading zero on 9-digit local numbers. The phone
            // is where the admission notice SMS goes, so it's required.
            let phone = cell(r, 'phonenumber');
            if (phone && /^\d{9}$/.test(phone)) phone = `0${phone}`;
            if (!phone) problem('Phone Number', '', 'Phone Number is required (the admission SMS is sent to it)');
            else if (!/^\+?\d{10,15}$/.test(phone.replace(/[\s-]/g, ''))) problem('Phone Number', phone, 'Not a valid phone number');
            else phone = phone.replace(/[\s-]/g, '');

            students.push({
               id,
               fname,
               mname: cell(r, 'middlename'),
               lname,
               gender,
               phone,
               programId,
               // Fresher flags the rest of the flow reads: semesterNum /
               // entrySemesterNum (activation, FRESHER notices, fee posting),
               // entryDate (letter cohort, fee posting), entryGroup (bill
               // matching). Status flags are set explicitly rather than left
               // to column defaults; admissionStatus stays NULL until
               // "Activate Admission" sets it to PENDING.
               semesterNum: 1,
               entrySemesterNum: 1,
               entryDate,
               entryGroup: 'GH',
               deferStatus: false,
               completeStatus: false,
               graduateStatus: false,
               admissionStatus: null,
            });
         });

         if (errors.length) {
            const badRows = new Set(errors.map((e) => e.row)).size;
            return res.status(400).json({
               stage: 'sheet',
               message: `Upload rejected, nothing was saved: ${errors.length} problem(s) on ${badRows} of ${rows.length} row(s). Fix them in the sheet and upload again.`,
               failedCount: badRows,
               totalCount: rows.length,
               errors,
            });
         }

         // Accounts/emails are created later by "Activate Admission".
         const { status, body } = await createStudentBatch(students, req.userId, 'STUDENT_FRESHER_UPLOAD', { provision: false, idLabel: 'Application Number', rowOf, skipExisting: true });
         res.status(status).json(body);
      } catch (error: any) {
         console.log('uploadFresher failed:', error)
         return res.status(500).json({ stage: 'server', message: `Upload failed on the server, nothing was saved: ${errorMessage(error)}`, errors: [] })
      }
   }

   async updateStudent(req: Request & any, res: Response) {
      try {
         // Student callers get the restricted self-service update, and only
         // on their own record.
         if (req.groupId == 1) {
            if (paramStr(req.params.id) !== req.userId) return res.status(403).json({ message: 'You can only update your own profile!' });
            const resp = await updateOwnStudentProfile(req.userId, req.body);
            return res.status(200).json(resp);
         }
         const protectedHallFields = ['originalHallId', 'currentHallId', 'originalHall', 'currentHall', 'originalHallSource', 'roomAssignments', 'hallAffiliationEvents', 'affiliateEditedAt'];
         if (protectedHallFields.some(key => req.body[key] !== undefined)) return res.status(400).json({ message: 'Manage hall affiliation and room placements in the Hall Module.' });
         if (req.body.instituteAffliate !== undefined) {
            const existing = await ais.student.findUnique({ where: { id: paramStr(req.params.id) }, select: { instituteAffliate: true } });
            if ((req.body.instituteAffliate || '').trim() !== (existing?.instituteAffliate || '').trim()) return res.status(400).json({ message: 'Original hall affiliation is preserved. Use the Hall Module to record affiliation or reassign a room.' });
            delete req.body.instituteAffliate;
         }
         const { titleId, programId, countryId, regionId, religionId, disabilityId, majorId, instituteEmail, indexno } = req.body
         delete req.body.titleId; delete req.body.programId;
         delete req.body.countryId; delete req.body.regionId;
         delete req.body.religionId; delete req.body.disabilityId;
         delete req.body.majorId; 
         // delete req.body.dob;
         // delete req.body.indexno;
         req.body.completeType = !req.body.completeType ? null : req.body.completeType;
         if (indexno != undefined) req.body.indexno = !req.body.indexno ? null : req.body.indexno;
         req.body.entryDate = toDate(req.body.entryDate);
         req.body.dob = toDate(req.body.dob);
         normaliseAdmissionFields(req.body);
         const resp = await ais.$transaction(async (tx: any) => {
         await lockStudent(tx, paramStr(req.params.id));
         if (req.body.gender !== undefined) {
            const session = await tx.session.findFirst({ where: { default: true, status: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
            if (session) {
               const placement = await tx.residenceAssignment.findFirst({ where: { studentId: paramStr(req.params.id), academicYear: academicYear(session), status: 'ACTIVE' } });
               if (placement && genderOf(req.body.gender) !== placement.gender) throw new ResidenceError('Release the current room in the Hall Module before changing the student gender.');
            }
         }
         return tx.student.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
               //...indexno && ({ indexno }),
               ...programId && ({ program: { connect: { id: programId } } }),
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...countryId && ({ country: { connect: { id: countryId } } }),
               ...regionId && ({ region: { connect: { id: regionId } } }),
               ...religionId && ({ religion: { connect: { id: religionId } } }),
               ...disabilityId && ({ disability: { connect: { id: disabilityId } } }),
               ...majorId && majorId == 'NONE' && ({ major: { disconnect: true } }),
               ...majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }),
            }
         })
         }, transactionOptions);
         if (resp) {
            // Update Email as tag in sso_user
            if (instituteEmail) await ais.user.updateMany({ where: { tag: paramStr(req.params.id) }, data: { username: instituteEmail } });
            // Log Login Response
            await ais.log.create({
               data: {
                  action: `STUDENT_UPDATED`, user: req?.userId, meta: {
                     ...req.body,
                     ...programId && ({ program: { connect: { id: programId } } }),
                     ...titleId && ({ title: { connect: { id: titleId } } }),
                     ...countryId && ({ country: { connect: { id: countryId } } }),
                     ...regionId && ({ region: { connect: { id: regionId } } }),
                     ...religionId && ({ religion: { connect: { id: religionId } } }),
                     ...disabilityId && ({ disability: { connect: { id: disabilityId } } }),
                     ...majorId && majorId == 'NONE' && ({ major: { disconnect: true } }),
                     ...majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }),
                  }
               }
            })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(error instanceof StudentSelfEditError ? 400 : error instanceof ResidenceError ? error.status : 500).json({ message: error.message })
      }
   }

   // Halls of Affiliation in use -- options for the student portal's
   // one-time Hall of Affiliation edit (see updateOwnStudentProfile).
   async fetchHalls(req: Request, res: Response) {
      try {
         const rows = await ais.residenceHall.findMany({ where: { active: true }, select: { name: true }, orderBy: { name: 'asc' } });
         res.status(200).json(rows.map((r: any) => r.name))
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteStudent(req: Request & any, res: Response) {
      try {
         const resp = await ais.student.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            // Log Response
            await ais.log.create({ data: { action: `STUDENT_DELETED`, user: req?.userId, meta: resp } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async publishStudentTranscript(req: Request & any, res: Response) {
      try {
         const record = await ais.assessment.findUnique({ where: { id: paramStr(req.body.assessmentId) }, include: { scheme: true } });
         if (!record) return res.status(404).json({ message: 'Assessment not found.' });
         if (!assessmentGrade(record).validGrade) return res.status(422).json({ message: 'A valid final score and credit are required before publication.' });
         // Prisma (not raw SQL) so the change is captured by the
         // ais_assessment audit trail (prisma/auditAssessment.ts).
         const { count: resp } = await ais.assessment.updateMany({ where: { id: paramStr(req.body.assessmentId), NOT: { totalScore: null } }, data: { status: true } });
         if (resp) {
            // Log Response
            await ais.log.create({ data: { action: `ASSESSMENT_PUBLISHED`, user: req?.userId, meta: { count: resp } } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async deleteStudentTranscript(req: Request & any, res: Response) {
      try {
         const resp = await ais.assessment.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            // Log Response
            await ais.log.create({ data: { action: `ASSESSMENT_DELETED`, user: req?.userId, meta: resp } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Courses */
   async fetchCourseList(req: Request, res: Response) {
      try {
         const resp = await ais.course.findMany({ where: { status: true }, orderBy: { title: 'asc' } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchCourses(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
                  { id: { contains: keyword } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.course.count({
               ...(searchCondition),
            }),
            ais.course.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchCourse(req: Request, res: Response) {
      try {
         const resp = await ais.course.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postCourse(req: Request & any, res: Response) {
      try {

         const resp = await ais.course.create({
            data: {
               ...req.body,
            },
         })
         if (resp) {
            // Log Login Response
            await ais.log.create({ data: { action: `COURSE_CREATED`, user: req?.userId, meta: req.body } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateCourse(req: Request & any, res: Response) {
      try {
         const resp = await ais.course.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            // Log Login Response
            await ais.log.create({ data: { action: `COURSE_UPDATED`, user: req?.userId, meta: req.body } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteCourse(req: Request & any, res: Response) {
      try {
         const resp = await ais.course.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            // Log Login Response
            await ais.log.create({ data: { action: `COURSE_DELETED`, user: req?.userId, meta: resp } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Structure & Curriculum */
   async fetchCurriculums(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { courseId: { contains: keyword } },
                  { unit: { title: { contains: keyword } } },
                  { program: { longName: { contains: keyword } } },
                  { course: { title: { contains: keyword } } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.structure.count({
               ...(searchCondition),
            }),
            ais.structure.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  unit: { select: { title: true } },
                  scheme: { select: { id: true, title: true } },
                  program: { select: { longName: true } },
                  major: { select: { shortName: true, longName: true } },
                  course: { select: { title: true, creditHour: true } },
               }
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         // } else {
         //   res.status(202).json({ message: `no records found` })
         // }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchCurriculumList(req: Request, res: Response) {
      try {
         const resp = await ais.structure.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchCurriculum(req: Request, res: Response) {
      try {
         const resp = await ais.structure.findUnique({
            include: { scheme: { select: { id: true, title: true } } },
            where: {
               id: paramStr(req.params.id)
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postCurriculum(req: Request, res: Response) {
      try {
         const schemeId = await curriculumSchemeId(ais, req.body);
         const { unitId, programId, courseId, majorId } = req.body
         delete req.body.schemeId; delete req.body.scheme_id; delete req.body.scheme;
         delete req.body.courseId; delete req.body.programId;
         delete req.body.unitId; delete req.body.majorId;
         const resp = await ais.structure.create({
            data: {
               ...req.body,
               scheme: { connect: { id: schemeId } },
               ...programId && ({ program: { connect: { id: programId } } }),
               ...courseId && ({ course: { connect: { id: courseId } } }),
               ...unitId && ({ unit: { connect: { id: unitId } } }),
               ...majorId && ({ major: { connect: { id: majorId } } }),
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         if (error instanceof CurriculumSchemeError) return res.status(400).json({ message: error.message });
         return res.status(500).json({ message: error.message })
      }
   }

   async updateCurriculum(req: Request, res: Response) {
      try {
         const schemeId = await curriculumSchemeId(ais, req.body);
         const { unitId, programId, courseId, majorId } = req.body
         delete req.body.schemeId; delete req.body.scheme_id; delete req.body.scheme;
         delete req.body.courseId; delete req.body.programId;
         delete req.body.unitId; delete req.body.majorId;
         const resp = await ais.structure.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
               scheme: { connect: { id: schemeId } },
               ...programId && ({ program: { connect: { id: programId } } }),
               ...courseId && ({ course: { connect: { id: courseId } } }),
               ...unitId && ({ unit: { connect: { id: unitId } } }),
               ...majorId && ({ major: { connect: { id: majorId } } }),
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         if (error instanceof CurriculumSchemeError) return res.status(400).json({ message: error.message });
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteCurriculum(req: Request, res: Response) {
      try {
         const resp = await ais.structure.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Schemes */
   async fetchSchemes(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.scheme.count({
               ...(searchCondition),
            }),
            ais.scheme.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  _count: {
                     select: { program: true }
                  }
               }
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchSchemeList(req: Request, res: Response) {
      try {
         const resp = await ais.scheme.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchScheme(req: Request, res: Response) {
      try {
         const resp = await ais.scheme.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
            include: { program: true }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postScheme(req: Request, res: Response) {
      try {
         console.log(req.body);
         const resp = await ais.scheme.create({
            data: {
               ...req.body,
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateScheme(req: Request, res: Response) {
      try {
         console.log(req.body);
         const resp = await ais.scheme.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteScheme(req: Request, res: Response) {
      try {
         const resp = await ais.scheme.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: friendlyDbError(error) })
      }
   }


   /* Registrations */
   async fetchRegistrationList(req: Request, res: Response) {
      try {
         const resp = await ais.activityRegister.findMany({
            where: { session: { default: true } },
            orderBy: { createdAt: 'desc' },
            include: {
               student: {
                  select: {
                     fname: true, mname: true, lname: true,
                     semesterNum: true, id: true,
                     program: { select: { longName: true } }
                  }
               }
            }
         })

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchRegistrations(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               session: { default: true },
               OR: [
                  { indexno: { contains: keyword } },
                  { student: { fname: { contains: keyword } } },
                  { student: { mname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
                  { student: { id: { contains: keyword } } },
                  { student: { program: { longName: { contains: keyword } } } },
                  { session: { title: { contains: keyword } } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.activityRegister.count({
               ...(searchCondition),
            }),
            ais.activityRegister.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               orderBy: { createdAt: 'desc' },
               include: {
                  student: {
                     select: {
                        fname: true, mname: true, lname: true, indexno: true,
                        semesterNum: true, id: true, gender: true,
                        program: { select: { longName: true } },
                     }
                  },
                  session: { select: { title: true } },
               }
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         // } else {
         //    res.status(202).json({ message: `no records found` })
         // }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchRegistration(req: Request, res: Response) {
      try {
         let resp = [];
         const st = await ais.student.findUnique({
            where: { id: paramStr(req.params.indexno) },
            select: { id: true, indexno: true, fname: true, mname: true, lname: true, gender: true, semesterNum: true, program: { select: { longName: true } } },
         })
         if (st) {
            // Get Active Session Info -- no more MAIN/January-SUB stream split,
            // just the one default session.
            const session: any = await ais.session.findFirst({ where: { default: true } })
            // Assessment
            // resp = await ais.assessment.findMany({
            //    include: {
            //       course: { select: { title: true, creditHour: true } },
            //       // student: { select: { id: true, indexno: true, fname: true, mname: true, lname: true, gender: true, semesterNum: true, program: { select: { longName: true, department: true }} }},
            //       session: { select: { title: true } },
            //    },
            //    where: {
            //       indexno: st?.indexno,
            //       session: { default: true }
            //    },
            // });
            // Skip the query entirely when the student has no index number
            // yet (e.g. before "Generate Index Number") -- Prisma rejects a
            // bare `null` for a scalar filter, and a student with no index
            // number can't have any assessment records tied to one anyway.
            if (st?.indexno) {
               resp = await ais.assessment.findMany({
                  include: {
                     course: { select: { title: true, creditHour: true } },
                     session: { select: { title: true } },
                  },
                  where: {
                     indexno: st.indexno,
                     sessionId: session?.id
                  },
               });
            }
         }

         // Resit Courses
         const resits = await ais.resit.findMany({
            where: {
               indexno: paramStr(req.params.indexno),
               registerSession: { default: true }
            },
            select: {
               course: { select: { title: true, creditHour: true } },
               registerSession: { select: { title: true } },
               courseId: true
            }
         })

         if (resits.length) {
            for (let rs of resits)
               resp.push({ course: rs.course, session: rs.registerSession, courseId: rs.courseId, type: 'R' })
         }

         if (resp) {
            // Add Student Bio
            resp = resp.map((r: any) => ({ ...r, student: st }));
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchRegistrationMount(req: Request, res: Response) {
      try {
         const courses: any = [];
         const id = paramStr(req.params.indexno);
         // Get Student Info
         const student: any = await ais.student.findUnique({ include: { program: { select: { hasMajor: true } } }, where: { id } })
         const indexno = student?.indexno;
         // Get Active Session Info -- no more MAIN/January-SUB stream split,
         // just the one default session.
         const session: any = await ais.session.findFirst({ where: { default: true } })

         // console.log("Registration SemesterNum: ", student?.semesterNum);

         // Get Normal Courses with/without Majors
         if (!student) return res.status(404).json({ message: 'Student not found.' });
         const mounts = await curriculumRows(ais, student, student.semesterNum);
         const maincourses = [...new Set(mounts.map((r: any) => r.courseId))].map((code: any) => selectCurriculum(mounts, code, student.majorId));
         // Meta & Instructions
         const meta = await ais.structmeta.findFirst({
            where: { programId: student?.programId, majorId: student?.majorId, semesterNum: student?.semesterNum },
         })

         //### Current Posted Bill 
         // const groupCode = await getBillCodePrisma(student?.semesterNum);
         // const bill = await ais.bill.findFirst({
         //    where: {
         //       programId: student?.programId, sessionId: session?.id, residentialStatus: student?.residentialStatus || 'RESIDENTIAL',
         //       OR: groupCode,
         //    },
         // })

         // const meta:any = []
         if (student && maincourses.length) {
            for (const course of maincourses) {
               const isAdded = courses.find((c: any) => c.code == course.courseId);
               if (!isAdded)
                  courses.push({
                     code: course.courseId,
                     course: course?.course?.title,
                     credit: course?.course?.creditHour,
                     type: course?.type,
                     lock: course?.lock,
                     sessionId: session?.id,
                     schemeId: course.schemeId,
                     semesterNum: student?.semesterNum,
                     indexno,
                     ...course.majorId && ({ major: course?.major?.shortName })
                  })
            }
         }
         // Get Resit Courses -- skip the query entirely when the student
         // has no index number yet (e.g. a freshly bulk-uploaded student
         // before "Generate Index Number"): Prisma rejects a bare `null`
         // for a scalar filter, and a student with no index number can't
         // have any resit records tied to one anyway.
         const resitcourses: any = indexno ? await ais.resit.findMany({
            include: { course: { select: { title: true, creditHour: true } } },
            where: {
               indexno, taken: false, trailSession: { semester: session?.semester },
            }
         }) : []
         if (student && resitcourses.length) {
            for (const course of resitcourses) {
               const isAdded = courses.find((c: any) => c.code == course.courseId);
               if (!isAdded)
                  courses.push({
                     code: course.courseId,
                     course: course?.course?.title,
                     credit: course?.course?.creditHour,
                     type: 'R',
                     lock: false,
                     sessionId: session.id,
                     schemeId: course.schemeId,
                     semesterNum: student.semesterNum,
                     indexno,
                     ...course.majorId && ({ major: course?.major?.shortName })
                  })
            }
         }

         // Conditions
         let condition = true; // Allow Registration
         let message;          // Reason attached
         /*
            // Check for Exceeded Credit Hours - After
            // If No courses are not selected! - After
            // Check whether Total Number of Electives are chosen - After
            
            // If student Doesnt Have an Index Number - Before
               if(!student?.indexno) { condition = false; message = "No Index Number for Student!" }
            // If Semester Level or Program ID or Major  ID is not Updated, Block Registration - Before
               if(!student?.programId || (student.program.hasMajor && !student.majorId) || !student?.semesterNum) { condition = false; message = "No Major or Program or Level Set!" }
            // If Student is Owing Fees, Lock Registration - Before
               if(student?.accountNet > 0 && student?.accountNet < (Bill amount * Payment Percentage )) { condition = false; message = "No Index Number for Student!" }
            // If Student is Pardoned by Finance, Allow Registration - Before
            // If Registration Period is Inactive - Before
            // If Registration Period is Active and Halt status is ON - Before
            // If Registration Period is Extended for Late Finers - Before
         */


         // Check for Exceeded Credit Hours - After
         // If No courses are not selected! - After
         // Check whether Total Number of Electives are chosen - After

         // If student Doesnt Have an Index Number - Before
         if (!student?.indexno) { condition = false; message = "No Index Number for Student!" }
         // If Semester Level or Program ID or (Major  ID for Year 3,4) is not Updated, Block Registration - Before
         if (!student?.programId || (student.program.hasMajor && student.semesterNum > 4 && !student.majorId) || !student?.semesterNum) { condition = false; message = "No Major or Program or Level Set!" }

         // If Student is Owing Fees, Lock Registration - Before
         // if(student?.accountNet > 0 && student?.accountNet < (Bill amount * Payment Percentage )) { condition = false; message = "No Index Number for Student!" }

         // If Student is Pardoned by Finance, Allow Registration - Before
         // If Registration Period is Inactive - Before
         // If Registration Period is Active and Halt status is ON - Before
         // If Registration Period is Extended for Late Finers - Before


         if (courses?.length) {
            res.status(200).json({ session: session?.title, courses, meta, condition, message, registerStart: session?.registerStart, registerEnd: session?.registerEnd, registerEndLate: session?.registerEndLate })
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         if (error instanceof CurriculumSchemeError) return res.status(400).json({ message: error.message });
         return res.status(202).json({ message: error.message })
      }
   }

   async postRegistration(req: Request, res: Response) {
      try {
         const courses = Array.isArray(req.body) ? req.body : [];
         const data: any = [], rdata: any = [];
         if (!courses.length) return res.status(400).json({ message: "Please select at least one course before submitting your registration." });
         // A student without an index number has nothing to key the
         // registration on (Prisma also rejects a null scalar filter), so
         // stop here with something the student can act on.
         if (!courses[0]?.indexno) return res.status(400).json({ message: "Your index number has not been issued yet, so you can't register. Please contact the Academic Affairs office (Registry) to have it generated, then try again." });
         // Get Active Session Info -- no more MAIN/January-SUB stream split,
         // just the one default session.
         const st: any = await ais.student.findFirst({ include: { program: { select: { hasMajor: true } } }, where: { indexno: courses[0].indexno } })
         if (admissionLocked(st)) return res.status(403).json({ message: st.admissionStatus === 'ACCEPTED' ? "Please pay your fees before registering courses." : "Please accept your admission offer on the student portal before registering courses." });
         const session: any = await ais.session.findFirst({ where: { default: true } })
         if (!session) return res.status(400).json({ message: "No active registration session found. Please contact the registry." });
         // Check If Registration Data exists
         const slip = await ais.assessment.findFirst({ where: { indexno: courses[0].indexno, sessionId: session.id } });
         if (slip) return res.status(400).json({ message: "Registration already submitted!" });

         const resitcourses = courses.filter((row: any) => row.type == 'R')
         const maincourses = courses.filter((row: any) => row.type != 'R')
         data.push(...await registrationCourses(ais, st, maincourses, session.id));
         // Canonical values are also used by the registration activity log.
         for (const course of courses) {
            const canonical = data.find((r: any) => r.courseId === course.code);
            Object.assign(course, canonical || { indexno: st.indexno, sessionId: session.id, semesterNum: st.semesterNum });
         }
         if (resitcourses?.length) {
            // Resit Session Info
            const rsession: any = await ais.resitSession.findFirst({ where: { default: true } })
            if (!rsession) return res.status(400).json({ message: "Resit registration isn't open yet. Please deselect your resit course(s), or contact the Registry." });
            // Save Resit Registration
            for (const course of resitcourses) {
               const ups = await ais.resit.updateMany({
                  where: {
                     indexno: course?.indexno,
                     courseId: course?.code,
                     taken: false,
                     paid: true
                  },
                  data: {
                     resitSessionId: rsession.id,
                     registerSessionId: course?.sessionId

                     //registerSession: { connect: { id: course?.sessionId }},
                     //... rsession && ({ session: { connect: { id:rsession?.id }} }),
                     //taken: true  - Only when Resit Exam is taken
                  }
               })
               if (ups) rdata.push(ups);
            }
         }
         // Log Registration -- keyed on the first non-resit course, or the
         // first course when only resits were chosen.
         const first = maincourses[0] || courses[0];
         const isLogged = await ais.activityRegister.findFirst({
            where: {
               indexno: first.indexno,
               sessionId: first.sessionId
            }
         })
         if (!isLogged)
            await ais.activityRegister.createMany({
               data: [{
                  indexno: first.indexno,
                  sessionId: first.sessionId,
                  courses: courses?.length,
                  credits: courses?.reduce((sum: number, cur: any) => sum + cur.credit, 0),
                  semesterNum: first.semesterNum,
                  dump: courses
               }]
            })
         else
            await ais.activityRegister.update({
               where: { id: isLogged?.id },
               data: {
                  indexno: first.indexno,
                  sessionId: first.sessionId,
                  courses: courses?.length,
                  credits: courses?.reduce((sum: number, cur: any) => sum + cur.credit, 0),
                  semesterNum: first.semesterNum,
                  dump: courses
               }
            })

         // Save Registration Courses
         const mainresp = await ais.assessment.createMany({ data })
         if (mainresp) {
            res.status(200).json({ courses: mainresp, resits: rdata, totalCourses: courses.length })
         } else {
            res.status(202).json({ message: `No selected courses found!` })
         }
      } catch (error: any) {
         console.log(error)
         if (error instanceof CurriculumSchemeError) return res.status(400).json({ message: error.message });
         // Raw Prisma/driver errors aren't meant for students — log them,
         // return a readable message instead.
         return res.status(500).json({ message: "We couldn't complete your registration because of a server error. Please try again, or contact the Registry if it keeps happening." })
      }
   }


   async updateRegistration(req: Request, res: Response) {
      try {
         const indexno = paramStr(req.params.indexno);
         const courses = req.body;
         const data: any = [], rdata: any = [];
         const resitcourses = courses.filter((row: any) => row.type == 'R')
         const maincourses = courses.filter((row: any) => row.type != 'R')
         const student = await ais.student.findUnique({ where: { indexno } });
         for (const sessionId of [...new Set(maincourses.map((c: any) => c.sessionId))]) {
            if (typeof sessionId !== 'string' || !sessionId) throw new CurriculumSchemeError('Registration semester is required.');
            data.push(...await registrationCourses(ais, student, maincourses.filter((c: any) => c.sessionId === sessionId), sessionId, false));
         }

         if (resitcourses.length) {
            for (const course of resitcourses) {
               const ups = await ais.resit.updateMany({
                  where: {
                     indexno,
                     courseId: course.courseId,
                     taken: false
                  },
                  data: {
                     registerSessionId: course.sessionId,
                     resitSessionId: course.sessionId,
                     //taken: true
                  }
               })
               if (ups) rdata.push(ups);
            }
         }
         const mainresp = await ais.assessment.createMany({ data })
         if (mainresp) {
            res.status(200).json({ courses: mainresp, resits: rdata })
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         if (error instanceof CurriculumSchemeError) return res.status(400).json({ message: error.message });
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteRegistration(req: Request, res: Response) {
      try {
         // const { data } =  req.body;
         // if(data?.length){

         // }
         // Delete Courses Registration
         const resp = await ais.assessment.deleteMany({
            where: {
               indexno: paramStr(req.params.indexno),
               session: { default: true }
            }
         })
         // Delete Registration Log
         const log = await ais.activityRegister.deleteMany({
            where: {
               indexno: paramStr(req.params.indexno),
               session: { default: true }
            }
         })
         // Reset Resit Registration
         const resit = await ais.resit.updateMany({
            where: {
               indexno: paramStr(req.params.indexno),
               registerSession: { default: true }
            },
            data: {
               taken: false,
               resitSessionId: null,
               registerSessionId: null,
            }
         })

         if (resp?.count) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `Registration not deleted` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* programs */
   async fetchProgramList(req: Request, res: Response) {
      try {
         const resp = await ais.program.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchPrograms(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { code: { contains: keyword } },
                  { shortName: { contains: keyword } },
                  { longName: { contains: keyword } },
                  { prefix: { contains: keyword } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.program.count({
               ...(searchCondition),
            }),
            ais.program.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  student: { select: { _count: true } }
               }
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchProgram(req: Request, res: Response) {
      try {
         const resp = await ais.program.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
            include: {
               student: { select: { _count: true } }
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchProgramStructure(req: Request, res: Response) {
      try {
         const resp = await ais.program.findUnique({
            where: { id: paramStr(req.params.id) },
            include: {
               structure: {
                  select: {
                     id: true,
                     type: true,
                     semesterNum: true,
                     schemeId: true,
                     scheme: { select: { title: true } },
                     course: { select: { title: true, creditHour: true, id: true, practicalHour: true, theoryHour: true } }
                  },
                  orderBy: [{ semesterNum: 'asc' }, { type: 'asc' },]
               },
               structmeta: {
                  select: {
                     id: true,
                     minCredit: true,
                     maxCredit: true,
                     maxElectiveNum: true,
                     semesterNum: true,
                     major: { select: { longName: true } }
                  },
                  orderBy: { semesterNum: 'asc' }
               }
            },
         })

         if (resp?.structure?.length) {
            var mdata: any = new Map(), sdata: any = new Map();
            for (const sv of resp?.structure) {
               const index: string = `LEVEL ${Math.ceil(sv.semesterNum / 2) * 100}, ${sv.semesterNum % 2 == 0 ? 'SEMESTER 2' : 'SEMESTER 1'}` || 'none';
               const zd = { ...sv, course: sv?.course?.title, code: sv?.course?.id, credit: sv?.course?.creditHour, practical: sv?.course?.practicalHour, theory: sv?.course?.theoryHour, type: sv?.type }
               // Data By Level - Semester
               if (mdata.has(index)) {
                  mdata.set(index, [...mdata.get(index), { ...zd }])
               } else {
                  mdata.set(index, [{ ...zd }])
               }
            }

            for (const sv of resp?.structmeta) {
               const index: string = `LEVEL ${Math.ceil(sv.semesterNum / 2) * 100}, ${sv.semesterNum % 2 == 0 ? 'SEMESTER 2' : 'SEMESTER 1'}` || 'none';
               const zd = { ...sv }
               // Data By Level - Semester
               if (sdata.has(index)) {
                  sdata.set(index, [...sdata.get(index), { ...zd }])
               } else {
                  sdata.set(index, [{ ...zd }])
               }
            }
            console.log(Object.fromEntries(sdata))
            res.status(200).json({ data: Array.from(mdata), meta: Object.fromEntries(sdata) })
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchProgramStudents(req: Request, res: Response) {
      try {
         const resp = await ais.program.findUnique({
            where: { id: paramStr(req.params.id) },
            include: {
               student: {
                  where: { completeStatus: false },
                  select: {
                     id: true,
                     indexno: true,
                     fname: true,
                     mname: true,
                     lname: true,
                     gender: true,
                     semesterNum: true,
                     residentialStatus: true,
                     deferStatus: true,
                     // For the programme's bulk ID cards (Issued/Expires, hall, nationality).
                     entryDate: true,
                     instituteAffliate: true,
                     country: { select: { nationality: true } },
                     program: { select: { shortName: true, longName: true } }
                  },
                  orderBy: { semesterNum: 'asc' }
               }
            },
         })
         if (resp?.student?.length) {
            var mdata: any = new Map();
            for (const sv of resp?.student) {
               const index: string = `LEVEL ${Math.ceil(sv.semesterNum / 2) * 100}` || 'none';
               const zd = { ...sv }
               // Data By Level - Semester
               if (mdata.has(index)) {
                  mdata.set(index, [...mdata.get(index), { ...zd }])
               } else {
                  mdata.set(index, [{ ...zd }])
               }
            }
            res.status(200).json(Array.from(mdata))
         } else {
            res.status(200).json([])
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchProgramStatistics(req: Request, res: Response) {
      try {
         const resp = await ais.program.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postProgram(req: Request, res: Response) {
      try {
         // Programmes aren't linked to departments (see schema), so any
         // unitId sent is ignored. Grading schemes are managed on curriculum entries.
         delete req.body.schemeId; delete req.body.scheme_id; delete req.body.scheme; delete req.body.unitId;

         const resp = await ais.program.create({
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateProgram(req: Request, res: Response) {
      try {
         // Programmes aren't linked to departments. Ignore legacy programme scheme inputs.
         delete req.body.schemeId; delete req.body.scheme_id; delete req.body.scheme; delete req.body.unitId;

         const resp = await ais.program.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteProgram(req: Request, res: Response) {
      try {
         const resp = await ais.program.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Majors */
   async fetchMajorList(req: Request, res: Response) {
      try {
         const resp = await ais.major.findMany({
            where: { status: true },
            include: {
               program: { select: { shortName: true } },
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }




   /* Departments */
   async fetchDepartments(req: Request, res: Response) {
      try {
         const resp = await ais.unit.findMany({
            where: { status: true, levelNum: 2, type: 'ACADEMIC' },
            include: {
               level1: { select: { title: true, code: true } },
               _count: {
                  select: {
                     staff: true,
                  }
               },
            },
            orderBy: { title: 'asc' },
         })
         if (resp) {
            // Added for the Department module cards (existing fields unchanged,
            // so the department dropdowns that use this list still work):
            // `courses` = distinct courses assigned to the department in the
            // curriculum (structure.unitId); `head` = head of department's name.
            const ids = resp.map((d: any) => d.id);
            const assigned = ids.length ? await ais.structure.findMany({ where: { unitId: { in: ids } }, select: { unitId: true, courseId: true }, distinct: ['unitId', 'courseId'] }) : [];
            const heads = resp.map((d: any) => d.headStaffNo).filter(Boolean);
            const staff = heads.length ? await ais.staff.findMany({ where: { staffNo: { in: heads } }, select: { staffNo: true, fname: true, lname: true, title: { select: { label: true } } } }) : [];
            const headName = (no: string) => {
               const h: any = staff.find((x: any) => x.staffNo === no);
               return h ? [h.title?.label, h.fname, h.lname].filter(Boolean).join(' ') : null;
            };
            res.status(200).json(resp.map((d: any) => ({
               ...d,
               courses: assigned.filter((a: any) => a.unitId === d.id).length,
               head: d.headStaffNo ? headName(d.headStaffNo) : null,
            })))
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Faculties */
   async fetchFaculties(req: Request, res: Response) {
      try {
         const resp = await ais.unit.findMany({
            where: { status: true, levelNum: 1, type: 'ACADEMIC' },
            include: {
               _count: {
                  select: {
                     staff: true,
                     levelI: true
                  }
               },
            },
            orderBy: {

            }
         })

         console.log("Faculties: ", resp)

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Units */
   async fetchUnits(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
                  { code: { contains: keyword } },
                  { headStaffNo: { contains: keyword } },
               ],
            },
            //include: { level1: true },
            //   orderBy: { createdAt: 'asc'}
         }
         const resp = await ais.$transaction([
            ais.unit.count({
               ...(searchCondition),
            }),
            ais.unit.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchUnitList(req: Request, res: Response) {
      try {
         const resp = await ais.unit.findMany({
            where: { status: true },
            include: { level1: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchUnit(req: Request, res: Response) {
      try {
         const resp = await ais.unit.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
            include: { level1: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postUnit(req: Request, res: Response) {
      try {
         const { level1Id, level2Id } = req.body
         delete req.body.level1Id; delete req.body.level2Id;
         const resp = await ais.unit.create({
            data: {
               ...req.body,
               ...level1Id && ({ level1: { connect: { id: level1Id } } }),
               ...level2Id && ({ level2: { connect: { id: level2Id } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateUnit(req: Request, res: Response) {
      try {
         const { level1Id, level2Id, headStaffNo: newHead } = req.body
         delete req.body.level1Id; delete req.body.level2Id;
         const unit = await ais.unit.findFirst({ where: { id: paramStr(req.params.id) } });
         const resp = await ais.unit.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
               ...level1Id && ({ level1: { connect: { id: level1Id } } }),
               ...!level1Id && ({ level1: { disconnect: true } }),
               ...level2Id && ({ level2: { connect: { id: level2Id } } }),
               ...!level2Id && ({ level2: { disconnect: true } }),
            }
         })
         if (resp) {

            // Stage Head or Dean of Unit

            if (['ACADEMIC'].includes(unit?.type) && newHead && newHead != unit.headStaffNo) {
               //###### NEW HEAD/DEAN ####//
               // Update Role of New Head or Dean
               let userId;
               const nrole = await ais.userRole.findFirst({
                  where: {
                     user: { tag: newHead },
                     appRole: { id: { in: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16] } }
                  }
               })
               if (nrole) {
                  userId = nrole.userId;
                  // Remove AIS Roles
                  await ais.userRole.deleteMany({
                     where: {
                        user: { tag: newHead },
                        appRole: { id: { in: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16] } }
                     }
                  })

               } else {
                  const user = await ais.user.findFirst({ where: { tag: newHead } })
                  if (user) userId = user.id;

               }

               if (unit?.levelNum == 1) {
                  await ais.userRole.create({
                     data: {
                        userId,
                        appRoleId: 4,
                        roleMeta: unit?.id
                     }
                  })

               } else {
                  await ais.userRole.create({
                     data: {
                        userId,
                        appRoleId: 3,
                        roleMeta: unit?.id
                     }
                  })
               }

               // ###### OLD HEAD/DEAN ###### //
               if (unit?.headStaffNo) {
                  const orole = await ais.userRole.findFirst({
                     where: {
                        user: { tag: unit?.headStaffNo },
                        appRole: { id: { in: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16] } }
                     }
                  })

                  if (orole) {
                     // Remove AIS Roles
                     await ais.userRole.deleteMany({
                        where: {
                           user: { tag: unit?.headStaffNo },
                           appRole: { id: { in: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16] } }
                        }
                     })
                     // Create Assessor Role
                     await ais.userRole.create({
                        data: {
                           userId: orole?.userId,
                           appRoleId: 1,
                           roleMeta: null
                        }
                     })
                  }
               }
            }
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteUnit(req: Request, res: Response) {
      try {
         const resp = await ais.unit.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Jobs */
   async fetchJobs(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
                  { id: { contains: keyword } },
               ],
            },
         }
         const resp = await ais.$transaction([
            ais.job.count({
               ...(searchCondition),
            }),
            ais.job.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchJobList(req: Request, res: Response) {
      try {
         const resp = await ais.job.findMany({
            where: { status: true }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchJob(req: Request, res: Response) {
      try {
         const resp = await ais.job.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postJob(req: Request, res: Response) {
      try {
         const resp = await ais.job.create({
            data: {
               ...req.body,
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateJob(req: Request, res: Response) {
      try {
         const resp = await ais.job.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteJob(req: Request, res: Response) {
      try {
         const resp = await ais.job.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Progression */
   async fetchProgressions(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = {
         where: { session: { default: true } }
      }
      try {
         if (keyword) searchCondition = {
            where: {
               session: { default: true },
               OR: [
                  { indexno: { contains: keyword } },
                  { session: { title: { contains: keyword } } },
                  { student: { id: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },

               ],
            }
         }
         const resp = await ais.$transaction([
            ais.activityProgress.count({
               ...(searchCondition),
            }),
            ais.activityProgress.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  student: { include: { program: true } },
                  session: true
               },
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         // } else {
         //    res.status(202).json({ message: `no records found` })
         // }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchProgression(req: Request, res: Response) {
      try {
         const resp = await ais.activityProgress.findUnique({
            where: { id: paramStr(req.params.id) },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postProgression(req: Request, res: Response) {
      try {
         const { indexno } = req.body;
         delete req.body.indexno;
         // Check If Student Exist with Index number
         const st = await ais.student.findFirst({ where: { indexno, deferStatus: false, completeStatus: false }, include: { program: { select: { semesterTotal: true } } } });
         if (!st) throw ("Student can't be progressed, check indexno,defer or complete status!");

         // Fetch Active Session for Student -- no more MAIN/January-SUB stream
         // split, just the one default session.
         const session = await ais.session.findFirst({ where: { default: true } })

         // Check If Progressed
         const pg = await ais.activityProgress.findFirst({ where: { indexno, sessionId: session?.id } })
         if (pg) throw ("Student already progressed !");


         // Save Progression Data
         const resp = await ais.activityProgress.create({
            data: {
               semesterNum: (st.semesterNum + 1 > st.program?.semesterTotal ? 0 : st.semesterNum + 1),
               status: true,
               ...session && ({ session: { connect: { id: session?.id } } }),
               ...indexno && ({ student: { connect: { indexno } } }),
            }
         })
         if (resp) {
            // Update Student SemesterNum & CompleteStatus
            await ais.student.update({
               where: { id: st?.id },
               data: {
                  semesterNum: (st.semesterNum + 1 > st.program?.semesterTotal ? 0 : st.semesterNum + 1),
                  completeStatus: (st.semesterNum + 1 > st.program?.semesterTotal ? true : false
                  )
               }
            })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(202).json({ message: error.message })
      }
   }

   async postAllProgression(req: Request, res: Response) {
      try {
         const { sessionId } = req.body
         delete req.body.sessionId;
         // Fetch Active Session for Student
         const session = await ais.session.findFirst({ where: { id: sessionId } })
         // No more MAIN/January-SUB stream split -- every active student.
         const students = await ais.$queryRaw`select s.id,indexno,semesterNum,p.semesterTotal from ais_student s left join ais_program p on s.programId = p.id where completeStatus = 0 and deferStatus = 0 and indexno is not NULL`;

         const resp = await Promise.all(students.map(async (st: any) => {
            console.log("st: ", st)
            // Check If Progressed
            const pg = await ais.activityProgress.findFirst({ where: { indexno: st?.indexno, sessionId: session?.id } })
            if (pg) return null;

            // Update Student SemesterNum & CompleteStatus
            await ais.student.update({
               where: { id: st?.id },
               data: {
                  semesterNum: (st?.semesterNum + 1 > st?.semesterTotal ? 0 : Math.min(st?.semesterTotal, st?.semesterNum + 1)),
                  completeStatus: (st?.semesterNum + 1 > st?.semesterTotal ? true : false
                  )
               }
            })

            // Update Session Progression Status
            await ais.session.update({ where: { id: sessionId }, data: { progressStudent: true } })

            // Return Response
            return ais.activityProgress.create({
               data: {
                  student: { connect: { indexno: st.indexno } },
                  semesterNum: (st?.semesterNum + 1 > st?.semesterTotal ? 0 : Math.min(st?.semesterTotal, st?.semesterNum + 1)),
                  status: true,
                  ...session && ({ session: { connect: { id: session?.id } } }),
               }
            })
         }))

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateProgression(req: Request, res: Response) {
      try {
         const resp = await ais.activityProgress.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteProgression(req: Request, res: Response) {
      try {
         const resp = await ais.activityProgress.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Sheets */
   async fetchSheets(req: any, res: Response) {
      const { page = 1, pageSize = 6, keyword = '', unit = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      try {
         // Data-level scoping (category/headStaffNo/assignStaffId) on top of the
         // route-level requireRole gate — see util/sheetScope.ts.
         const scopeWhere = sheetScopeWhere(req.roles, req.userId);

         const andClauses: any[] = [
            { session: { OR: [{ default: true }, { assignLateSheet: true }] } },
         ];
         if (scopeWhere) andClauses.push(scopeWhere);
         if (unit) andClauses.push({
            OR: [
               { unit: { id: unit, levelNum: 2 } },
               { unit: { level1Id: unit, levelNum: 2 } },
            ]
         });
         if (keyword) andClauses.push({
            OR: [
               { id: { contains: keyword } },
               { courseId: { contains: keyword } },
               { session: { title: { contains: keyword } } },
               { course: { title: { contains: keyword } } },
               { course: { id: { contains: keyword } } },
               { program: { longName: { contains: keyword } } },
               { unit: { title: { contains: keyword }, levelNum: 2 } },
            ]
         });

         const where = { AND: andClauses };

         const resp = await ais.$transaction([
            ais.sheet.count({ where }),
            ais.sheet.findMany({
               where,
               include: {
                  session: true,
                  program: true,
                  course: true,
                  major: true,
                  assignee: true,
               },
               skip: offset,
               take: Number(pageSize),
               orderBy: [
                  { session: { createdAt: 'desc' } },
                  { semesterNum: 'asc' }
               ]
            })
         ]);

         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchMySheets(req: any, res: Response) {
      const assignStaffId = req.userId;
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = {
         where: {
            //assessorId: assignStaffId,
            assignStaffId,
            session: {
               OR: [
                  { default: true },
                  { assignLateSheet: true },
               ]
            },
         }
      };
      try {
         if (keyword) searchCondition = {
            where: {
               //assessorId: assignStaffId,
               assignStaffId,
               session: {
                  OR: [
                     { default: true },
                     { assignLateSheet: true },
                  ]
               },
               OR: [
                  { id: { contains: keyword } },
                  { session: { title: { contains: keyword } } },
                  { course: { title: { contains: keyword } } },
                  { course: { id: { contains: keyword } } },
                  { program: { longName: { contains: keyword } } },
                  { unit: { title: { contains: keyword }, levelNum: 2 } },

               ],
            }
         }

         const resp = await ais.$transaction([
            ais.sheet.count({
               ...(searchCondition),
            }),
            ais.sheet.findMany({
               ...(searchCondition &&
                  ({
                     ...searchCondition,
                     include: {
                        session: true,
                        program: true,
                        course: true,
                        major: true,
                        assignee: true,
                     }
                  })),
               skip: offset,
               take: Number(pageSize),
               // orderBy: [{ sessionId:'desc'},{ semesterNum:'asc'}]
               orderBy: [
                  { session: { createdAt: 'desc' } },
                  { semesterNum: 'asc' }
               ]
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         // } else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async stageSheet(req: Request, res: Response) {
      try {
         // Fetch Active Semester
         const { sessionId } = req.body
         // Fetch Session Info
         const session = await ais.session.findFirst({ where: { id: sessionId, default: true } })
         if (session) {
            // Fetch Mounted Courses all Program Levels — one sheet per
            // program/session/semester, no mode-based split.
            let mounts = await ais.structure.findMany({ where: { status: true }, include: { program: true } })
            mounts = mounts.filter((meta: any) => (meta?.semesterNum % 2) == (session?.semester == 'SEM2' ? 0 : 1))
            let data = mounts;

            // Check whether Sheets are generated
            const form = await ais.sheet.findFirst({ where: { sessionId, status: true } })
            if (form) {
               // Update Generated Flag
               await ais.session.update({ where: { id: sessionId }, data: { stageSheet: true } })
               // Return Response
               return res.status(202).json({ message: `sheets exists for calendar` });
            }

            // Upsert Bulk into Sheet
            const resp: any = await Promise.all(data?.map(async (row: any) => {
               let { courseId, programId, unitId, majorId } = row;
               return await ais.sheet.create({
                  data: {
                     semesterNum: row.semesterNum,
                     ...sessionId && ({ session: { connect: { id: sessionId } } }),
                     ...courseId && ({ course: { connect: { id: courseId } } }),
                     ...programId && ({ program: { connect: { id: programId } } }),
                     ...majorId && ({ major: { connect: { id: majorId } } }),
                     ...unitId && ({ unit: { connect: { id: unitId } } }),
                  }
               })
            }))
            if (resp) {
               // Update Stage Status in Calendar
               await ais.session.update({ where: { id: sessionId }, data: { stageSheet: true } })
               return res.status(200).json(resp)

            } else {
               return res.status(202).json({ message: `no record found` })
            }

         } else {
            return res.status(202).json({ message: `no record found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async cleanSheet(req: Request, res: Response) {
      try {
         // Fetch Active Semester
         // const { sessionId } = req.body
         // const sessionId = 'f63b1b74-0533-4a62-8510-6292cc93a9a3'; 2026/2025 first
         // const sessionId = 'a500f0cb-6114-4039-81f5-5102382d4d4f'; 2025/2024 second jan
         // const sessionId = '44872c48-a33c-4a7a-a9ce-eb486e59aab2'; 2025/2024 second main
         // const sessionId = '71c730c1-638e-4ee0-9d6a-8fdceac5851c'; //2025/2024 first main
         // const sessionId = 'eb4bc6a5-87c9-4740-80bd-f932beb813de'; //2025/2024 first jan
         // const sessionId = 'cd431ccf-b5f2-4743-9b82-f481d6dea7db'; //2024/2023 second jan
         // const sessionId = '937c57c1-6595-4982-a3f7-3f2c29c7fc82'; //2024/2023 second main
         // const sessionId = '3149b295-ce38-4cb3-9f94-bed2b552d998'; //2024/2023 first jan
         const sessionId = 'cbc5fa67-7982-4516-b824-ff860c756a1b'; //2024/2023 first main




         // Fetch Session Info
         const session = await ais.session.findFirst({ where: { id: sessionId } })
         if (session) {
            // Fetch Mounted Courses all Program Levels — one sheet per
            // program/session/semester, no mode-based split.
            let mounts = await ais.structure.findMany({ where: { status: true }, include: { program: true } })
            mounts = mounts.filter((meta: any) => (meta?.semesterNum % 2) == (session?.semester == 'SEM2' ? 0 : 1))
            let data = mounts;

            // Upsert Bulk into Sheet
            const resp: any = await Promise.all(data?.map(async (row: any) => {
               let { courseId, programId, unitId, majorId } = row;
               const sheetM = await ais.sheet.findFirst({ where: { semesterNum: row.semesterNum, sessionId, programId, courseId } });
               await ais.$executeRaw`set foreign_key_checks=0`;
               if (sheetM) {
                  return await ais.$executeRaw`UPDATE ais_sheet SET semesterNum = ${row.semesterNum}, assignStaffId = ${sheetM?.assignStaffId || null}, sessionId = ${sessionId || null}, courseId = ${courseId || null}, programId = ${programId || null}, majorId = ${majorId || null}, unitId = ${unitId || null}, updatedAt = NOW() WHERE id = ${sheetM.id}`;
               } else {
                  return await ais.$executeRaw`INSERT INTO ais_sheet (id,semesterNum,assignStaffId,sessionId,courseId,programId,majorId,unitId,status,createdAt,updatedAt) VALUES (UUID(),${row.semesterNum}, ${sheetM?.assignStaffId || null}, ${sessionId || null}, ${courseId || null}, ${programId || null}, ${majorId || null}, ${unitId || null}, 1, NOW(),NOW())`;
               }
            }))
            if (resp) {
               return res.status(200).json(resp)
            } else {
               return res.status(202).json({ message: `no record found` })
            }
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async loadSheet(req: any, res: Response) {
      try {
         // Fetch Active Semester
         const { sheetId } = req.body;
         const inScope = await isSheetInScope(ais, sheetId, req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         // Fetch Session Info
         const sheet = await ais.sheet.findFirst({ where: { id: sheetId, status: true }, include: { program: true, unit: true, session: true, course: true, major: true } })
         if (sheet) {
            // Fetch Mounted Courses all Program Levels

            let mounts = await ais.assessment.findMany({
               where: {
                  semesterNum: sheet.semesterNum,
                  sessionId: sheet?.sessionId,
                  courseId: sheet?.courseId,
                  student: { programId: sheet?.programId },
               },
               include: {
                  student: {
                     select: { fname: true, mname: true, lname: true, id: true, indexno: true, gender: true, programId: true }
                  },
                  scheme: true,
                  course: true,
                  session: true
               },
               orderBy: { student: { fname: 'asc' } }
            })

            let resp = mounts?.map((row: any) => {
               const grade = getGrade(row.totalScore, row.scheme?.gradeMeta);
               const gradepoint = getGradePoint(row.totalScore, row.scheme?.gradeMeta);
               return ({
                  ...row,
                  grade,
                  gradepoint
               })
            });

            console.log("resp: ", resp)
            if (resp) {
               res.status(200).json(resp)
            } else {
               res.status(202).json({ message: `no record found` })
            }
         } else {
            res.status(202).json({ message: `no record found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async uploadSheet(req: any, res: Response) {
      try {
         // Fetch Active Semester
         const { id, data } = req.body;
         const inScope = await isSheetInScope(ais, id, req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         // const createdBy = req.userId;
         let resp;
         const sheet = await ais.sheet.findFirst({ where: { id } })

         if (data?.length && sheet && !sheet.assessed) {
            const { sessionId, courseId } = sheet;
            resp = await Promise.all(data?.map(async (row: any) => {
               const { indexno, quiz, assignment, midsem } = row;
               const scoreA = quiz !== '' && quiz != null ? parseFloat(quiz) : null;
               const scoreB = assignment !== '' && assignment != null ? parseFloat(assignment) : null;
               const scoreC = midsem !== '' && midsem != null ? parseFloat(midsem) : null;
               // Class score is always the sum of Quiz/Assignment/Midsem — same
               // rule as the manual capture form (saveSheet). Never trust a
               // pre-computed class/total column from the uploaded file.
               const classScore: any = (scoreA ?? 0) + (scoreB ?? 0) + (scoreC ?? 0);

               let isExist = await ais.assessment.findFirst({ where: { sessionId, courseId, indexno } });
               if (isExist) {
                  // Exam score isn't part of this upload — total is recomputed
                  // from the new class score plus whatever exam score already
                  // exists on the record, left untouched here.
                  const totalScore = classScore + (isExist.examScore || 0);
                  return await ais.assessment.update({ where: { id: isExist?.id }, data: { scoreA, scoreB, scoreC, classScore, totalScore } });
               }
               return null;
            }))
         } else return resp;

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `Upload failed` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveSheet(req: any, res: Response) {
      try {
         // Fetch Active Semester
         const { count, data, sheetId } = req.body;

         const inScope = await isSheetInScope(ais, sheetId, req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         const sheet = await ais.sheet.findUnique({ where: { id: sheetId }, select: { programId: true, majorId: true } });
         if (!sheet) return res.status(202).json({ message: `no record found` });

         let mounts = [];
         const courseId = data[`cid`];
         const sessionId = data[`sid`];

         for (let i = 0; i < count; i++) {
            const scoreA = data[`${i}_scorea`] ? parseFloat(data[`${i}_scorea`]) : null;
            const scoreB = data[`${i}_scoreb`] ? parseFloat(data[`${i}_scoreb`]) : null;
            const scoreC = data[`${i}_scorec`] ? parseFloat(data[`${i}_scorec`]) : null;
            // Class score capture (Quiz/Assignment/Midsem) is now the sole source of
            // classScore -- it's always their sum, not a separately-entered value.
            // The old truthy-AND chain here broke on a genuine 0 in any component
            // (falsy), silently falling back to the unrelated manual _class field.
            const classScore: any = (scoreA ?? 0) + (scoreB ?? 0) + (scoreC ?? 0);
            let examScore: any = parseFloat(data[`${i}_exam`]);
                examScore = !isNaN(examScore) ? examScore : null;
            let totalScore = classScore + examScore;
                totalScore = !isNaN(totalScore) ? totalScore : null
            const indexno = data[`${i}_idx`];
            const id = data[`${i}_id`];

            mounts.push({
               where: {
                  id, course: { id: courseId }, session: { id: sessionId }, indexno,
                  // Constrain to this sheet's own student population, not just
                  // any row that happens to share course+session+indexno —
                  // closes the gap where saveSheet couldn't otherwise verify a
                  // captured score belongs to the sheet it was authorized for.
                  student: {
                     programId: sheet.programId,
                     ...sheet.majorId && ({ majorId: sheet.majorId }),
                  },
               },
               data: {
                  // ... scoreA && ({ scoreA }),
                  // ... scoreB && ({ scoreB }),
                  // ... scoreC && ({ scoreC }),
                  scoreA,
                  scoreB,
                  scoreC,
                  classScore,
                  examScore,
                  totalScore,
               }
            })
         }
         // Bulk Score Update
         const resp: any = await Promise.all(mounts?.map(async (query: any) => {
            return await ais.assessment.updateMany(query)
         }))

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchSheet(req: any, res: Response) {
      try {
         const inScope = await isSheetInScope(ais, paramStr(req.params.id), req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         const resp = await ais.sheet.findUnique({
            where: { id: paramStr(req.params.id) },
            include: {
               session: { select: { title: true, cohort: true } },
               program: { select: { longName: true, category: true } },
               course: { select: { title: true, id: true, creditHour: true } },
               major: { select: { longName: true } },
               assignee: true,
               assessor: true,
               certifier: true
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postSheet(req: Request, res: Response) {
      try {
         // Optional relation fields (majorId, assignStaffId, assessorId,
         // certifierId) come through as "" when left blank, or "NONE" for
         // the Major field's explicit no-major option — either passed
         // straight through as a scalar foreign key, MariaDB rejects it as
         // pointing to a row that doesn't exist. stripBlank drops them so
         // Prisma just omits the field instead.
         const resp = await ais.sheet.create({
            data: stripBlank(req.body),
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: friendlyDbError(error) })
      }
   }

   async submitSheet(req: any, res: Response) {
      try {
         const assessorId: any = req.userId;
         const inScope = await isSheetInScope(ais, paramStr(req.params.id), req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         const resp = await ais.sheet.update({ where: { id: paramStr(req.params.id) }, data: { assessed: true, assessorId } });
         if (resp) {
            console.log(resp)
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async closeSheet(req: Request, res: Response) {
      try {
         const resp: any = await ais.sheet.findUnique({ where: { id: paramStr(req.params.id) } });
         if (resp) {
            let { courseId, programId, unitId, majorId, sessionId, semesterNum } = resp;
            // Fetch Affected Students
            const assessments = await ais.assessment.findMany({
               where: {
                  ...sessionId && ({ sessionId }),
                  ...courseId && ({ courseId }),
                  ...programId && ({ student: { programId } }),
                  ...majorId && ({ student: { majorId } }),
                  ...semesterNum && ({ semesterNum: Number(semesterNum) }),
                  // ... unitId && ({ unitId }),
               },
               include: { scheme: true }
            })

            // Generate Resit Data on Sheet Close
            //const rsession = await ais.resitSession.findFirst({ where: { default: true }});
            const all = await Promise.all(assessments.filter((a: any) => a.totalScore < a.scheme.passMark).map(async (r: any) => {
               const { sessionId, indexno, courseId, schemeId, semesterNum } = r;
               return await ais.resit.upsert({
                  where: {
                     resitId: {
                        indexno,
                        courseId,
                        trailSessionId: sessionId,

                     }
                  },
                  create: {
                     semesterNum: Number(semesterNum),
                     totalScore: null,
                     trailSession: { connect: { id: sessionId } },
                     course: { connect: { id: courseId } },
                     scheme: { connect: { id: schemeId } },
                     student: { connect: { indexno: indexno } },
                  },
                  update: {}
               })
            }));

            // Update Student Assessment Publish Status
            await ais.assessment.updateMany({
               where: {
                  ...sessionId && ({ sessionId }),
                  ...courseId && ({ courseId }),
                  ...programId && ({ student: { programId } }),
                  ...majorId && ({ student: { majorId } }),
                  ...semesterNum && ({ semesterNum: Number(semesterNum) }),
                  // ... unitId && ({ unitId }),
               },
               data: { status: true },
            })
            console.log(all)
            // Update Sheet
            await ais.sheet.update({ where: { id: paramStr(req.params.id) }, data: { finalized: true } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async moderateSheet(req: any, res: Response) {
      try {
         const inScope = await isSheetInScope(ais, paramStr(req.params.id), req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         const resp = await ais.sheet.update({
            where: { id: paramStr(req.params.id) },
            data: { moderated: true }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async publishSheet(req: any, res: Response) {
      try {
         const certifierId: any = req.userId;
         const inScope = await isSheetInScope(ais, paramStr(req.params.id), req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         const resp: any = await ais.sheet.findUnique({ where: { id: paramStr(req.params.id) } });
         if (resp) {
            if (!resp.moderated) {
               return res.status(400).json({ message: `This sheet must be moderated before it can be published.` });
            }
            let { courseId, programId, unitId, majorId, sessionId, semesterNum } = resp
            // Update Student Assessment Publish Status
            const ups = await ais.assessment.updateMany({
               where: {
                  ...sessionId && ({ sessionId }),
                  ...courseId && ({ courseId }),
                  ...programId && ({ student: { programId } }),
                  ...majorId && ({ student: { majorId } }),
                  ...semesterNum && ({ semesterNum: Number(semesterNum) }),
                  // ... unitId && ({ unitId }),
               },
               data: { status: true }
            })
            // Update Sheet
            await ais.sheet.update({ where: { id: paramStr(req.params.id) }, data: { certified: true, certifierId } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async unpublishSheet(req: any, res: Response) {
      try {
         const inScope = await isSheetInScope(ais, paramStr(req.params.id), req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         const resp: any = await ais.sheet.findUnique({ where: { id: paramStr(req.params.id) } });
         if (resp) {
            let { courseId, programId, unitId, majorId, sessionId, semesterNum } = resp
            // Update Student Assessment Publish Status
            const ups = await ais.assessment.updateMany({
               where: {
                  ...sessionId && ({ sessionId }),
                  ...courseId && ({ courseId }),
                  ...programId && ({ student: { programId } }),
                  ...majorId && ({ student: { majorId } }),
                  ...semesterNum && ({ semesterNum: Number(semesterNum) }),
                  // ... unitId && ({ unitId }),
               },
               data: { status: false }
            })
            console.log(ups)
            // Update Sheet
            await ais.sheet.update({ where: { id: paramStr(req.params.id) }, data: { certified: false, certifierId: null } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateSheet(req: any, res: Response) {
      try {
         let { courseId, programId, unitId, majorId, sessionId, semesterNum, assignStaffId } = req.body;

         // This endpoint serves two different callers behind the same route:
         // the admin-only edit form (arbitrary fields) and the "assign sheet"
         // action (only assignStaffId), which hod/registry roles may also
         // trigger — so authorization branches by request body shape.
         const isAssignOnly = !!assignStaffId && !courseId && !programId && !unitId && !majorId && !sessionId && !semesterNum;
         if (isAssignOnly) {
            const inScope = await isSheetInScope(ais, paramStr(req.params.id), req.roles, req.userId);
            if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });
         } else if (!isSheetAdmin(req.roles)) {
            return res.status(403).json({ message: `You do not have permission to edit this sheet.` });
         }

         const sheet = await ais.sheet.findUnique({ where: { id: paramStr(req.params.id) } });
         const resp = await ais.sheet.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               //...req.body,
               ...semesterNum && ({ semesterNum: Number(semesterNum) }),
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
               ...courseId && ({ course: { connect: { id: courseId } } }),
               ...programId && ({ program: { connect: { id: programId } } }),
               ...unitId && ({ unit: { connect: { id: unitId } } }),
               ...majorId && majorId == 'NONE' && ({ major: { disconnect: true } }),
               ...majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }),
               ...assignStaffId && ({ assignee: { connect: { staffNo: assignStaffId } } }),
            }
         })
         if (resp) {
            // Send SMS
            if (assignStaffId && (assignStaffId != sheet.assignStaffId)) {
               const st = await ais.staff.findFirst({ where: { staffNo: assignStaffId } })
               if (st?.phone) await sms(st?.phone, `Hi! You have been assigned a course with course code: ${sheet?.courseId} for Year ${Math.ceil(sheet?.semesterNum / 2)}. Please login to assess your students.`)
            }

            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: friendlyDbError(error) })
      }
   }

   async reverseSheet(req: any, res: Response) {
      try {
         // The route (POST /sheets/reverse) has no :id param — the frontend
         // sends the target sheet's id as sheetId in the body.
         const sheetId = paramStr(req.body?.sheetId);
         const inScope = await isSheetInScope(ais, sheetId, req.roles, req.userId);
         if (!inScope) return res.status(403).json({ message: `You do not have access to this sheet.` });

         const resp = await ais.sheet.update({
            where: { id: sheetId },
            data: {
               // `assigned` was never a field on the sheet model — this update
               // previously threw on every call.
               certified: false,
               finalized: false,
               assessed: false,
               assessorId: null,
               // Any prior moderation was signed off on scores that are
               // about to be redone — it no longer applies to the retake.
               moderated: false
            }
         })
         if (resp) {
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteSheet(req: Request, res: Response) {
      try {
         const resp = await ais.sheet.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   /* Backlog */
   async fetchBacklogs(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         const where: any = {
            ...keyword && ({
               OR: [
                  { title: { contains: keyword } },
                  { session: { title: { contains: keyword } } },
               ],
            }),
         };
         if (Object.keys(where).length) searchCondition = { where };
         const resp = await ais.$transaction([
            ais.activityBacklog.count({
               ...(searchCondition),
            }),
            ais.activityBacklog.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  session: true
               }
            })
         ]);

         if (resp && resp[1]?.length) {
            return res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            return res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchBacklog(req: Request, res: Response) {
      try {
         const resp = await ais.activityBacklog.findUnique({
            where: { id: paramStr(req.params.id) },
            include: { session: true }
         })
         if (resp) {
            // Flag rows whose indexno has no matching student so the UI can
            // highlight them before an approval attempt rejects the batch.
            const indexnos = [...new Set((resp.meta as any[] || []).map((r: any) => r.indexno?.trim()).filter(Boolean))] as string[];
            if (indexnos.length) {
               const students = await ais.student.findMany({ where: { indexno: { in: indexnos } }, select: { indexno: true } });
               const foundIndexnos = new Set(students.map((s: any) => s.indexno));
               resp.meta = (resp.meta as any[]).map((r: any) => ({ ...r, studentExists: foundIndexnos.has(r.indexno?.trim()) }));
            }
            return res.status(200).json(resp)
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async approveBacklog(req: any, res: Response) {
      try {
         const approvedBy = req.userId;
         const rs = await ais.activityBacklog.findUnique({
            where: { id: req.body?.backlogId },
         })

         if (rs) {
            const { id, type, meta, sessionId, schemeId } = rs;

            // Validate the whole batch up front so a bad row fails cleanly
            // instead of leaving the backlog partially committed.
            if (type == 'ASSESSMENT') {
               const missingScore = (meta || []).filter((r: any) => r.scoreTotal === null || r.scoreTotal === undefined || Number.isNaN(r.scoreTotal));
               if (missingScore.length) {
                  const indexnos = [...new Set(missingScore.map((r: any) => r.indexno?.trim()))];
                  return res.status(400).json({
                     message: `Backlog not committed: total score is missing for ${missingScore.length} of ${meta.length} student record(s): ${indexnos.join(', ')}. Please provide a total score before committing this backlog.`,
                     failedCount: missingScore.length,
                     totalCount: meta.length,
                     errors: indexnos.map((indexno) => ({ indexno, reason: 'Total score is missing' })),
                  });
               }
            }

            const indexnos = [...new Set((meta as any[] || []).map((r: any) => r.indexno?.trim()).filter(Boolean))] as string[];
            if (indexnos.length) {
               const students = await ais.student.findMany({ where: { indexno: { in: indexnos } }, select: { indexno: true } });
               const foundIndexnos = new Set(students.map((s: any) => s.indexno));
               const missingStudents = indexnos.filter((idx) => !foundIndexnos.has(idx));
               if (missingStudents.length) {
                  return res.status(400).json({
                     message: `Backlog not committed: ${missingStudents.length} of ${indexnos.length} student index number(s) could not be found: ${missingStudents.join(', ')}. Please check and correct them before committing this backlog.`,
                     failedCount: missingStudents.length,
                     totalCount: indexnos.length,
                     errors: missingStudents.map((indexno) => ({ indexno, reason: 'Student index number not found' })),
                  });
               }
            }

            // Commit each record inside a transaction so a failure partway
            // through rolls back cleanly instead of leaving the backlog
            // partially committed, and report exactly which record(s) failed.
            let resp: any;
            try {
               resp = await withBufferedAudit(prismaBase, () => ais.$transaction(async (tx: any) => {
                  let data: any[] = [];

                  if (type == 'ASSESSMENT') { // BACKLOG ASSESSMENT
                     data = await Promise.all(meta.map(async (r: any) => {
                        try {
                           const as = await tx.assessment.findFirst({ where: { sessionId, courseId: r.courseId, indexno: r.indexno.trim() } });
                           const cs = await tx.course.findUnique({ where: { id: r.courseId } });
                           // Log Existing Data
                           await tx.log.create({ data: { action: `BACKLOG_${type}`, user: req.userId, student: r.indexno.trim(), meta: as } });
                           // Quiz / Midsem / Assignment (scoreA / scoreC / scoreB). Older
                           // backlogs without the breakdown leave existing values alone.
                           const parts = 'scoreQuiz' in r ? { scoreA: r.scoreQuiz ?? null, scoreB: r.scoreAssignment ?? null, scoreC: r.scoreMidsem ?? null } : {};
                           // Upsert New Data
                           return await tx.assessment.upsert({
                              where: {
                                 id: as?.id ?? ''
                              },
                              create: {
                                 indexno: r.indexno.trim(),
                                 courseId: r.courseId,
                                 semesterNum: Number(r.semesterNum),
                                 ...parts,
                                 classScore: r.scoreClass,
                                 examScore: r.scoreExam,
                                 totalScore: r.scoreTotal,
                                 type: r.scoreType,
                                 status: true,
                                 credit: cs?.creditHour,
                                 sessionId,
                                 schemeId
                              },
                              update: {
                                 semesterNum: Number(r.semesterNum),
                                 ...parts,
                                 classScore: r.scoreClass,
                                 examScore: r.scoreExam,
                                 totalScore: r.scoreTotal,
                                 type: r.scoreType,
                                 credit: cs?.creditHour,
                                 schemeId
                              },

                           })
                        } catch (recordError: any) {
                           throw new BacklogRecordError(r.indexno?.trim(), friendlyDbError(recordError));
                        }
                     }))

                  } else if (type == 'REGISTRATION') { // BACKLOG REGISTRATION
                     data = await Promise.all(meta.map(async (r: any) => {
                        try {
                           const cs = await tx.course.findUnique({ where: { id: r.courseId } });
                           return await tx.assessment.create({
                              data: {
                                 indexno: r.indexno.trim(),
                                 courseId: r.courseId,
                                 semesterNum: Number(r.semesterNum),
                                 type: r.scoreType,
                                 status: true,
                                 credit: cs?.creditHour,
                                 sessionId,
                                 schemeId
                              }
                           });
                        } catch (recordError: any) {
                           throw new BacklogRecordError(r.indexno?.trim(), friendlyDbError(recordError));
                        }
                     }))

                  } else if (type == 'DELETION') { // BACKLOG DELETION
                     data = await Promise.all(meta.map(async (r: any) => {
                        try {
                           const as = await tx.assessment.findFirst({ where: { sessionId, courseId: r.courseId, indexno: r.indexno } });
                           // Log Existing Data
                           await tx.log.create({ data: { action: `BACKLOG_${type}`, user: req.userId, student: r.indexno, meta: as } });
                           // Delete Existing Data
                           return await tx.assessment.deleteMany({ where: { indexno: r.indexno, courseId: r.courseId, sessionId } })
                        } catch (recordError: any) {
                           throw new BacklogRecordError(r.indexno?.trim(), friendlyDbError(recordError));
                        }
                     }))
                  }

                  const committed = { count: data?.length };
                  if (committed.count) {
                     // Update Backlog Status
                     await tx.activityBacklog.update({ where: { id }, data: { approvedBy, status: true } });
                  }
                  return committed;
               }))
            } catch (txError: any) {
               if (txError instanceof BacklogRecordError) {
                  console.log(txError)
                  return res.status(400).json({
                     message: `Backlog not committed: record for student ${txError.indexno || 'unknown'} failed (${txError.reason}). No changes were saved — please fix this record and try again.`,
                     failedCount: 1,
                     totalCount: meta.length,
                     errors: [{ indexno: txError.indexno, reason: txError.reason }],
                  });
               }
               throw txError;
            }

            console.log(resp)
            if (resp?.count) {
               res.status(200).json({ success: true, data: resp })
            } else {
               res.status(202).json({ message: `no records found` })
            }

         }
         else throw ("Invalid Backlog Id")

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async uploadBacklog(req: any, res: Response) {
      try {
         const data = req.body;
         let resp;
         if (data?.length) {

            const createdBy: any = req.userId;
            let sessionId = data[0].sessionId, schemeId = data[0].schemeId;
            let meta: any = [];

            data?.map(async (row: any) => {
               let { courseId, type, status, semesterNum, indexno, quiz, midsem, assignment, classScore, examScore, totalScore } = row;
               // Excel cells may come through as numbers.
               indexno = String(indexno ?? '').trim();
               courseId = String(courseId ?? '').trim();
               schemeId = String(schemeId ?? '').trim();
               type = String(type ?? '').trim();
               semesterNum = +semesterNum;
               status = !!status;

               meta.push({ indexno, courseId, semesterNum, scoreType: type, ...backlogScores({ quiz, midsem, assignment, classScore, examScore, totalScore }) })
            })

            resp = await ais.activityBacklog.create({
               data: {
                  title: `UPLOAD - ${moment().format('LLL')?.toUpperCase()} - ${createdBy}`,
                  type: `ASSESSMENT`,
                  meta,
                  ...createdBy && ({ creator: { connect: { staffNo: createdBy } } }),
                  ...sessionId && ({ session: { connect: { id: sessionId } } }),
                  ...schemeId && ({ scheme: { connect: { id: schemeId } } }),
               },
            })

         } else return resp;


         if (resp) {
            console.log(resp)
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(202).json({ message: error.message })
      }
   }

   // Exam Score Manager upload -- a narrower clone of uploadBacklog. The
   // sample/upload file has exam score, sessionId, schemeId, semesterNum,
   // courseId, indexno, and type (scoreType N/R): no classScore/totalScore.
   // schemeId only sets the exam maximum the scores are validated against
   // -- this never creates an assessment record, only updates the
   // examScore (and recomputed totalScore) on an existing one.
   // Stages a pending activityExam batch the same way uploadBacklog does;
   // approveExamScore commits it. `tag` is a free-text label the uploader
   // gives the batch (picked in the upload popup alongside the file), not
   // part of the sheet itself.
   async uploadExamScore(req: any, res: Response) {
      try {
         const { tag, rows } = req.body;
         let resp;
         if (rows?.length) {
            const createdBy: any = req.userId;
            let sessionId = rows[0].sessionId;
            let meta: any = [];

            // Each row's exam score is checked against the exam maximum of the
            // grading scheme named in the file (schemeId column, from the
            // upload sample) -- EXAM_SCORE_MAX when the file has no scheme.
            const schemeIds = [...new Set(rows.map((r: any) => String(r.schemeId ?? '').trim()).filter(Boolean))] as string[];
            const schemes = schemeIds.length ? await ais.scheme.findMany({ where: { id: { in: schemeIds } }, select: { id: true, scoreRange: true } }) : [];
            const unknownSchemes = schemeIds.filter((id) => !schemes.some((sc: any) => sc.id === id));
            if (unknownSchemes.length) {
               return res.status(400).json({ message: `Upload rejected: grading scheme not found (${unknownSchemes.join(', ')}). Please generate a new upload sample.` });
            }
            const examMaxOf = (schemeId: any) => {
               const range: any = schemes.find((sc: any) => sc.id === String(schemeId ?? '').trim())?.scoreRange;
               const v = Number(range?.exam);
               return v > 0 ? v : EXAM_SCORE_MAX;
            };

            const errors: { indexno: string; reason: string }[] = [];
            rows?.map((row: any) => {
               let { courseId, type, semesterNum, indexno, examScore } = row;
               // Excel cells may come through as numbers.
               indexno = String(indexno ?? '').trim();
               courseId = String(courseId ?? '').trim();
               type = String(type ?? '').trim();
               semesterNum = +semesterNum;
               const raw = String(examScore ?? '').trim();
               const max = examMaxOf(row.schemeId);
               examScore = raw === '' ? null : Number(raw);
               if (examScore != null && Number.isNaN(examScore)) errors.push({ indexno, reason: `exam score "${raw}" is not a number` });
               else if (examScore != null && examScore < 0) errors.push({ indexno, reason: `exam score ${examScore} is below 0` });
               else if (examScore != null && examScore > max) errors.push({ indexno, reason: `exam score ${examScore} exceeds the maximum of ${max}` });

               meta.push({ indexno, courseId, semesterNum, scoreType: type, scoreExam: examScore })
            })

            if (errors.length) {
               const shown = errors.slice(0, 15).map((e) => `${e.indexno} (${e.reason})`).join('; ');
               return res.status(400).json({
                  message: `Upload rejected: ${errors.length} of ${meta.length} student record(s) have an invalid exam score: ${shown}${errors.length > 15 ? `; and ${errors.length - 15} more` : ''}.`,
                  failedCount: errors.length,
                  totalCount: meta.length,
                  errors,
               });
            }

            resp = await ais.activityExam.create({
               data: {
                  title: `EXAM SCORE UPLOAD - ${moment().format('LLL')?.toUpperCase()} - ${createdBy}`,
                  tag: tag?.trim() || null,
                  meta,
                  ...createdBy && ({ creator: { connect: { staffNo: createdBy } } }),
                  ...sessionId && ({ session: { connect: { id: sessionId } } }),
               },
            })

         } else return resp;

         if (resp) {
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(202).json({ message: error.message })
      }
   }

   async fetchExamScores(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         const where: any = {
            ...keyword && ({
               OR: [
                  { title: { contains: keyword } },
                  { session: { title: { contains: keyword } } },
               ],
            }),
         };
         if (Object.keys(where).length) searchCondition = { where };
         const resp = await ais.$transaction([
            ais.activityExam.count({
               ...(searchCondition),
            }),
            ais.activityExam.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  session: true
               }
            })
         ]);

         if (resp && resp[1]?.length) {
            return res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            return res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchExamScore(req: Request, res: Response) {
      try {
         const resp = await ais.activityExam.findUnique({
            where: { id: paramStr(req.params.id) },
            include: { session: true }
         })
         if (resp) {
            // Flag rows with no matching assessment record (the row an
            // approval actually updates) so the UI can highlight them before
            // an approval attempt rejects the batch. Checking the `student`
            // table here would be wrong: this module only updates existing
            // assessment rows, which can outlive or predate a student record.
            const meta = (resp.meta as any[]) || [];
            if (meta.length) {
               const existing = await ais.assessment.findMany({
                  where: {
                     sessionId: resp.sessionId,
                     OR: meta.map((r: any) => ({
                        courseId: r.courseId,
                        semesterNum: Number(r.semesterNum),
                        indexno: r.indexno?.trim(),
                        type: r.scoreType,
                     })),
                  },
                  select: { courseId: true, semesterNum: true, indexno: true, type: true },
               });
               const foundKeys = new Set(existing.map((a: any) => `${a.courseId}|${a.semesterNum}|${a.indexno}|${a.type}`));
               resp.meta = meta.map((r: any) => ({ ...r, studentExists: foundKeys.has(`${r.courseId}|${Number(r.semesterNum)}|${r.indexno?.trim()}|${r.scoreType}`) }));
            }
            return res.status(200).json(resp)
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async approveExamScore(req: any, res: Response) {
      try {
         const approvedBy = req.userId;
         const rs = await ais.activityExam.findUnique({
            where: { id: req.body?.examId },
         })

         if (rs) {
            const { id, meta, sessionId } = rs;

            // Validate the whole batch up front so a bad row fails cleanly
            // instead of leaving the batch partially committed.
            const missingExam = (meta || []).filter((r: any) => r.scoreExam === null || r.scoreExam === undefined || Number.isNaN(r.scoreExam));
            if (missingExam.length) {
               const indexnos = [...new Set(missingExam.map((r: any) => r.indexno?.trim()))];
               return res.status(400).json({
                  message: `Batch not committed: exam score is missing for ${missingExam.length} of ${meta.length} student record(s): ${indexnos.join(', ')}. Please provide an exam score before committing this batch.`,
                  failedCount: missingExam.length,
                  totalCount: meta.length,
                  errors: indexnos.map((indexno) => ({ indexno, reason: 'Exam score is missing' })),
               });
            }

            // This module only ever updates an existing assessment record --
            // it never creates one -- so the row that must exist is the
            // assessment (matched on session/course/semester/indexno/type),
            // not a `student` table entry. Checking against `student` here
            // would wrongly reject valid updates for indexnos that have
            // assessment history but no (or a stale) student record.
            const existing = await ais.assessment.findMany({
               where: {
                  sessionId,
                  OR: (meta as any[] || []).map((r: any) => ({
                     courseId: r.courseId,
                     semesterNum: Number(r.semesterNum),
                     indexno: r.indexno?.trim(),
                     type: r.scoreType,
                  })),
               },
               select: { courseId: true, semesterNum: true, indexno: true, type: true },
            });
            const foundKeys = new Set(existing.map((a: any) => `${a.courseId}|${a.semesterNum}|${a.indexno}|${a.type}`));
            const missingRecords = (meta as any[] || []).filter((r: any) => !foundKeys.has(`${r.courseId}|${Number(r.semesterNum)}|${r.indexno?.trim()}|${r.scoreType}`));
            if (missingRecords.length) {
               const indexnos = [...new Set(missingRecords.map((r: any) => r.indexno?.trim()))];
               return res.status(400).json({
                  message: `Batch not committed: no matching assessment record found for ${missingRecords.length} of ${meta.length} student record(s): ${indexnos.join(', ')}. Please check the session, course, semester, and assessment type before committing this batch.`,
                  failedCount: missingRecords.length,
                  totalCount: meta.length,
                  errors: indexnos.map((indexno) => ({ indexno, reason: 'No matching assessment record found' })),
               });
            }

            // Commit each record inside a transaction so a failure partway
            // through rolls back cleanly instead of leaving the batch
            // partially committed, and report exactly which record(s) failed.
            let resp: any;
            try {
               resp = await withBufferedAudit(prismaBase, () => ais.$transaction(async (tx: any) => {
                  // Updates an existing assessment record only -- sessionId,
                  // courseId, semesterNum, indexno, and scoreType (N/R) are
                  // used purely to find/confirm the right row, never to
                  // create one. totalScore is always recomputed as
                  // classScore + examScore.
                  const data = await Promise.all(meta.map(async (r: any) => {
                     try {
                        const as = await tx.assessment.findFirst({ where: { sessionId, courseId: r.courseId, semesterNum: Number(r.semesterNum), indexno: r.indexno.trim(), type: r.scoreType } });
                        if (!as) throw new BacklogRecordError(r.indexno?.trim(), 'No matching assessment record found for that session, course, semester, and assessment type');
                        // Log Existing Data
                        await tx.log.create({ data: { action: `EXAM_SCORE`, user: req.userId, student: r.indexno.trim(), meta: as } });
                        // Update Exam + Total Score
                        const totalScore = (as.classScore ?? 0) + (r.scoreExam ?? 0);
                        return await tx.assessment.update({
                           where: { id: as.id },
                           data: { examScore: r.scoreExam, totalScore },
                        })
                     } catch (recordError: any) {
                        if (recordError instanceof BacklogRecordError) throw recordError;
                        throw new BacklogRecordError(r.indexno?.trim(), friendlyDbError(recordError));
                     }
                  }))

                  const committed = { count: data?.length };
                  if (committed.count) {
                     // Update Batch Status
                     await tx.activityExam.update({ where: { id }, data: { approvedBy, status: true } });
                  }
                  return committed;
               }))
            } catch (txError: any) {
               if (txError instanceof BacklogRecordError) {
                  console.log(txError)
                  return res.status(400).json({
                     message: `Batch not committed: record for student ${txError.indexno || 'unknown'} failed (${txError.reason}). No changes were saved — please fix this record and try again.`,
                     failedCount: 1,
                     totalCount: meta.length,
                     errors: [{ indexno: txError.indexno, reason: txError.reason }],
                  });
               }
               throw txError;
            }

            console.log(resp)
            if (resp?.count) {
               res.status(200).json({ success: true, data: resp })
            } else {
               res.status(202).json({ message: `no records found` })
            }

         }
         else throw ("Invalid Exam Score Batch Id")

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Edits a pending Exam Score batch's rows before it's committed. Mirrors
   // updateBacklog's flat-form -> meta[] shape, narrowed to this module's
   // fields (indexno, courseId, semesterNum, scoreType, scoreExam -- no
   // classScore/scoreTotal/schemeId). Rejected once the batch is approved,
   // since a committed batch's meta is the audit record of what was applied.
   async updateExamScore(req: any, res: Response) {
      try {
         const existing = await ais.activityExam.findUnique({ where: { id: paramStr(req.params.id) } });
         if (!existing) return res.status(202).json({ message: `No records found` });
         if (existing.status) return res.status(400).json({ message: `Batch already committed -- pending batches only can be edited.` });

         const { sessionId } = req.body;
         let meta: any[] = [];
         const metaNum = parseInt(req.body.metaNum);
         if (metaNum)
            for (let i = 1; i <= metaNum; i++) {
               const indexno = req.body[`${i}_indexno`]?.trim();
               const courseId = req.body[`${i}_courseId`];
               const semesterNum = req.body[`${i}_semesterNum`];
               const scoreType = req.body[`${i}_scoreType`];
               const scoreExam = req.body[`${i}_scoreExam`] != '' ? parseFloat(req.body[`${i}_scoreExam`]) : null;
               meta.push({ indexno, courseId, semesterNum: Number(semesterNum), scoreType, scoreExam })
            }

         const overMax = meta.filter((r: any) => r.scoreExam != null && r.scoreExam > EXAM_SCORE_MAX);
         if (overMax.length) {
            const indexnos = [...new Set(overMax.map((r: any) => r.indexno))];
            return res.status(400).json({
               message: `Not saved: exam score exceeds the maximum of ${EXAM_SCORE_MAX} for ${overMax.length} of ${meta.length} student record(s): ${indexnos.join(', ')}.`,
               failedCount: overMax.length,
               totalCount: meta.length,
               errors: indexnos.map((indexno) => ({ indexno, reason: `Exam score exceeds maximum of ${EXAM_SCORE_MAX}` })),
            });
         }

         const resp = await ais.activityExam.update({
            where: { id: paramStr(req.params.id) },
            data: {
               meta,
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
            },
         })
         if (resp) {
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postBacklog(req: any, res: Response) {
      try {
         const { sessionId, schemeId, type, userId } = req.body;
         const createdBy = req.userId || userId;
         let meta = [];
         const metaNum = parseInt(req.body.metaNum);
         if (metaNum)
            for (let i = 1; i <= metaNum; i++) {
               const indexno = req.body[`${i}_indexno`].trim();
               const courseId = req.body[`${i}_courseId`];
               const semesterNum = req.body[`${i}_semesterNum`];
               const scoreType = req.body[`${i}_scoreType`];
               if (type == 'REGISTRATION')
                  meta.push({ indexno, courseId, semesterNum, scoreType })
               else if (type == 'ASSESSMENT')
                  meta.push({ indexno, courseId, semesterNum, scoreType, ...backlogFormScores(req.body, i) })
               else
                  meta.push({ indexno, courseId, semesterNum })
            }

         const resp = await ais.activityBacklog.create({
            data: {
               title: `ENTRY - ${moment().format('LLL')?.toUpperCase()} - ${createdBy}`,
               type,
               meta,
               ...createdBy && ({ creator: { connect: { staffNo: createdBy } } }),
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
               ...schemeId && ({ scheme: { connect: { id: schemeId } } }),
            },
         })

         if (resp) {
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateBacklog(req: any, res: Response) {
      try {
         const { sessionId, schemeId, type, userId } = req.body;
         // const createdBy = req.userId || userId;
         let meta = [];
         const metaNum = parseInt(req.body.metaNum);
         if (metaNum)
            for (let i = 1; i <= metaNum; i++) {
               const indexno = req.body[`${i}_indexno`].trim();
               const courseId = req.body[`${i}_courseId`];
               const semesterNum = req.body[`${i}_semesterNum`];
               const scoreType = req.body[`${i}_scoreType`];
               if (type == 'REGISTRATION')
                  meta.push({ indexno, courseId, semesterNum, scoreType })
               else if (type == 'ASSESSMENT')
                  meta.push({ indexno, courseId, semesterNum, scoreType, ...backlogFormScores(req.body, i) })
               else
                  meta.push({ indexno, courseId, semesterNum })
            }

         const resp = await ais.activityBacklog.update({
            where: { id: paramStr(req.params.id) },
            data: {
               // title,
               type,
               meta,
               // ...createdBy && ({ creator: { connect: { staffNo: createdBy } } }),
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
               ...schemeId && ({ scheme: { connect: { id: schemeId } } }),
            },
         })
         if (resp) {
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteBacklog(req: Request, res: Response) {
      try {
         const resp = await ais.activityBacklog.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Resit */
   async fetchResits(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { indexno: { contains: keyword } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
                  { course: { title: { contains: keyword } } },
                  { course: { id: { contains: keyword } } },
                  { trailSession: { title: { contains: keyword } } },
               ],
            },
         }
         const resp = await ais.$transaction([
            ais.resit.count({
               ...(searchCondition),
            }),
            ais.resit.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  resitSession: true,
                  trailSession: true,
                  registerSession: true,
                  course: true,
                  student: { include: { program: true } },

               }
            })
         ]);

         //if(resp && resp[1]?.length){
         return res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         // } else {
         //    return res.status(202).json({ message: `no records found` })
         // }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchResit(req: Request, res: Response) {
      try {
         const resp = await ais.resit.findUnique({
            where: { id: paramStr(req.params.id) },
            include: { session: true }
         })
         if (resp) {
            return res.status(200).json(resp)
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postResit(req: any, res: Response) {
      try {
         const createdBy = req.userId;
         const { sessionId, schemeId, type, title } = req.body;
         const resp = await ais.resit.create({
            data: {
               title,
               type,
               ...createdBy && ({ creator: { connect: { staffNo: createdBy } } }),
               ...sessionId && ({ resitSession: { connect: { id: sessionId } } }),
               ...schemeId && ({ scheme: { connect: { id: schemeId } } }),
            },
         })
         if (resp) {
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateResit(req: any, res: Response) {
      try {
         const createdBy = req.userId
         const { sessionId, schemeId, type, title } = req.body;
         const resp = await ais.resit.update({
            where: { id: paramStr(req.params.id) },
            data: {
               title,
               type,
               ...createdBy && ({ creator: { connect: { staffNo: createdBy } } }),
               ...sessionId && ({ resitSession: { connect: { id: sessionId } } }),
               ...schemeId && ({ scheme: { connect: { id: schemeId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteResit(req: Request, res: Response) {
      try {
         const resp = await ais.resit.delete({ where: { id: paramStr(req.params.id) } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Resit Session */
   async fetchResitSessions(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
               ],
            },
         }
         const resp = await ais.$transaction([
            ais.resitSession.count({
               ...(searchCondition),
            }),
            ais.resitSession.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         //if(resp && resp[1]?.length){
         return res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         // } else {
         //    return res.status(202).json({ message: `no records found` })
         // }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchResitSessionsList(req: Request, res: Response) {
      try {
         const resp = await ais.resitSession.findMany({
            orderBy: { createdAt: 'desc' }
         })
         // Return Response
         return res.status(200).json(resp)
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchResitSessionList(req: any, res: Response) {
      try {
         const resp = await ais.resit.findMany({
            where: {
               resitSessionId: paramStr(req.params.id),
               ...(await resitScopeWhere(ais, req.roles, req.userId)),
            },
            include: { course: true, student: true, scheme: true }
         })
         if (resp.length) {
            const grades: any = resp[0].scheme?.gradeMeta;
            const dm = await Promise.all(resp.map(async (r: any) => {
               return ({ ...r, grade: await getGrade(r?.totalScore, grades) })
            }));

            let courseMap = new Map();
            for (let d of dm) {
               if (courseMap.has(`${d?.course?.id} - ${d?.course?.title}`)) {
                  let cs = courseMap.get(`${d?.course?.id} - ${d?.course?.title}`);
                  cs.push(d);
                  courseMap.set(`${d?.course?.id} - ${d?.course?.title}`, cs);

               } else {
                  courseMap.set(`${d?.course?.id} - ${d?.course?.title}`, [d]);
               }
            }

            // Return Response
            return res.status(200).json(Array.from(courseMap))
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Lightweight per-course cards for the "My Resits" list — always the
   // active resit session (My Resits never lets an assessor pick an
   // arbitrary session), scoped to whichever courses the caller's
   // department owns via resitScopeWhere.
   async fetchMyResitCourses(req: any, res: Response) {
      try {
         const activeSession: any = await ais.resitSession.findFirst({ where: { default: true } });
         if (!activeSession) return res.status(202).json({ message: `no active resit session found` });

         const resp = await ais.resit.findMany({
            where: {
               resitSessionId: activeSession.id,
               ...(await resitScopeWhere(ais, req.roles, req.userId)),
            },
            include: { course: true }
         })

         if (resp.length) {
            let courseMap = new Map();
            for (let r of resp) {
               const key = r?.course?.id;
               if (courseMap.has(key)) {
                  courseMap.get(key).count += 1;
               } else {
                  courseMap.set(key, { courseId: r?.course?.id, courseTitle: r?.course?.title, creditHour: r?.course?.creditHour, count: 1 });
               }
            }
            return res.status(200).json(Array.from(courseMap.values()))
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Same row/grouping shape as fetchResitSessionList (Array.from(courseMap),
   // one [label, rows[]] tuple) so AISResitStudentCard/ScoreCard/CaptureCard
   // need no changes — just resolved against the active session and
   // narrowed to one course, so "My Resits" never needs a session id in
   // the URL at all.
   async fetchMyResitCourseList(req: any, res: Response) {
      try {
         const activeSession: any = await ais.resitSession.findFirst({ where: { default: true } });
         if (!activeSession) return res.status(202).json({ message: `no active resit session found` });

         const resp = await ais.resit.findMany({
            where: {
               resitSessionId: activeSession.id,
               courseId: paramStr(req.params.courseId),
               ...(await resitScopeWhere(ais, req.roles, req.userId)),
            },
            include: { course: true, student: true, scheme: true }
         })
         if (resp.length) {
            const grades: any = resp[0].scheme?.gradeMeta;
            const dm = await Promise.all(resp.map(async (r: any) => {
               return ({ ...r, grade: await getGrade(r?.totalScore, grades) })
            }));

            let courseMap = new Map();
            for (let d of dm) {
               const key = `${d?.course?.id} - ${d?.course?.title}`;
               if (courseMap.has(key)) {
                  courseMap.get(key).push(d);
               } else {
                  courseMap.set(key, [d]);
               }
            }

            return res.status(200).json(Array.from(courseMap))
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async fetchResitSession(req: Request, res: Response) {
      try {
         const resp = await ais.resitSession.findUnique({
            where: { id: paramStr(req.params.id) },
         })
         if (resp) {
            return res.status(200).json(resp)
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveResitSession(req: any, res: Response) {
      try {
         // Fetch Active Semester
         const { count, data } = req.body;
         console.log(req.body)
         let mounts = [];
         let ids: string[] = [];

         let scored: { id: string; totalScore: number }[] = [];

         for (let i = 0; i < count; i++) {
            const totalScore = data[`${i}_totalScore`] ? parseFloat(data[`${i}_totalScore`]) : null;
            const id = data[`${i}_id`];
            ids.push(id);
            mounts.push({
               where: { id },
               data: {
                  totalScore,
                  taken: true
               }
            })
            if (totalScore !== null) scored.push({ id, totalScore });
         }

         // A non-admin assessor may only submit rows that belong to a
         // department they head — fail the whole batch closed if any one
         // row is out of scope, rather than silently applying the rest.
         const inScope = await Promise.all(ids.map((id) => isResitInScope(ais, id, req.roles, req.userId)));
         if (inScope.some((ok) => !ok)) {
            return res.status(403).json({ message: `You do not have access to one or more of these resit records.` });
         }

         // Bulk Score Update
         const resp: any = await Promise.all(mounts?.map(async (query: any) => {
            return await ais.resit.updateMany(query)
         }))

         // Mirror the captured score into the assessment table (type: 'R')
         // so it surfaces wherever the rest of the system reads scores from
         // assessment (transcripts, broadsheets, GPA) — the resit table
         // alone is invisible everywhere outside this module.
         await Promise.all(scored.map(async ({ id, totalScore }) => {
            const resit: any = await ais.resit.findUnique({
               where: { id },
               select: { indexno: true, courseId: true, schemeId: true, semesterNum: true, trailSessionId: true, registerSessionId: true },
            });
            if (!resit || !resit.registerSessionId) return;

            const existing = await ais.assessment.findFirst({
               where: { indexno: resit.indexno, courseId: resit.courseId, sessionId: resit.registerSessionId, type: 'R' },
            });
            if (existing) {
               await ais.assessment.update({ where: { id: existing.id }, data: { totalScore, status: true } });
            } else {
               // assessment has no credit of its own on `resit` — pull it
               // from the original failing assessment row that produced
               // this resit in the first place (closeSheet's upsert).
               const original: any = await ais.assessment.findFirst({
                  where: { indexno: resit.indexno, courseId: resit.courseId, sessionId: resit.trailSessionId, type: 'N' },
                  select: { credit: true },
               });
               await ais.assessment.create({
                  data: {
                     indexno: resit.indexno,
                     courseId: resit.courseId,
                     sessionId: resit.registerSessionId,
                     schemeId: resit.schemeId,
                     semesterNum: resit.semesterNum,
                     credit: original?.credit ?? 0,
                     type: 'R',
                     totalScore,
                     status: true,
                  },
               });
            }
         }));

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async postResitSession(req: any, res: Response) {
      try {
         const resp = await ais.resitSession.create({
            data: req.body,
         })
         if (resp) {
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateResitSession(req: any, res: Response) {
      try {
         const resp = await ais.resitSession.update({
            where: { id: paramStr(req.params.id) },
            data: req.body,
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteResitSession(req: Request, res: Response) {
      try {
         const resp = await ais.resitSession.delete({ where: { id: paramStr(req.params.id) } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Graduate Session */
   /* Graduate Session */
   async fetchGraduateSessions(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
                  { description: { contains: keyword } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.graduateSession.count({
               ...(searchCondition),
            }),
            ais.graduateSession.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  _count: {
                     select: { graduate: true }
                  }
               }

            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchGraduateSessionsList(req: Request, res: Response) {
      try {
         const resp = await ais.graduateSession.findMany()
         // Return Response
         return res.status(200).json(resp)
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchGraduateSessionList(req: Request, res: Response) {
      try {
         const resp = await ais.graduate.findMany({
            where: { graduateSessionId: paramStr(req.params.id) },
            include: { student: { include: { program: true } } },
            orderBy: {
               student: { lname: 'asc' }
            }
         })
         if (resp.length) {
            const dm = resp;

            let programMap = new Map();
            for (let d of dm) {
               if (programMap.has(d?.student?.program?.longName)) {
                  let cs = programMap.get(d?.student?.program?.longName);
                  cs.push(d);
                  programMap.set(d?.student?.program?.longName, cs);

               } else {
                  programMap.set(d?.student?.program?.longName, [d]);
               }
            }
            // Return Response
            return res.status(200).json(Array.from(programMap))
         } else {
            res.status(202).json([])
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async generateGraduateSessionList(req: Request, res: Response) {
      try {
         const resp = await ais.graduateSession.findFirst({ where: { default: true } });
         if (resp) {
            // Delete + rebuild happen in one transaction — previously a
            // failure partway through the Promise.all below (e.g. a DB
            // connection hiccup) would leave the session's graduate list
            // half-deleted with only some students re-upserted. A generous
            // timeout since a full cohort's worth of per-student lookups can
            // take a while; Prisma's interactive-transaction default (5s)
            // would abort a real run well before it finishes.
            await ais.$transaction(async (tx: any) => {
               // Clean Graduates
               await tx.graduate.deleteMany({
                  where: { graduateSessionId: resp?.id }
               })
               // Fetch All students with Completed Status, Graduated Status with Program link
               const sts = await tx.student.findMany({
                  where: {
                     completeStatus: true,
                     graduateStatus: false,
                     indexno: { not: null },
                     semesterNum: 0
                  },
                  include: { program: true },
               })

               await Promise.all(sts.map(async (st: any) => {
                  let verified = true;
                  let verifiedRemark: any = [];
                  let incompleteCount = 0;
                  // Get Credit Total — this stays "all attempted credit"
                  // (including IC courses) since it answers "has this student
                  // registered/attempted enough credit hours," not "how many
                  // are graded."
                  const as = await tx.assessment.aggregate({ _sum: { credit: true }, where: { indexno: st.indexno } }); // Credit Total
                  const ax = await tx.assessment.findMany({ where: { indexno: st.indexno }, include: { scheme: true } });
                  const totals = academicTotals(ax);
                  incompleteCount = totals.incomplete;
                  const cgpa = totals.cgpa == null ? null : totals.cgpa.toFixed(2);
                  if (totals.invalid || totals.unpublished || totals.cgpa == null) {
                     verified = false;
                     if (totals.invalid) verifiedRemark.push(`${totals.invalid} invalid grade(s)`);
                     if (totals.unpublished) verifiedRemark.push(`${totals.unpublished} unpublished result(s)`);
                     if (totals.cgpa == null) verifiedRemark.push('No published graded credits');
                  }
                  const classes: any = ax?.length ? ax[0].scheme?.classMeta : null;
                  const graduateClass = getClass(cgpa, classes);

                  // #1. Check From Resit Table, whether Student doesnt have Pending and Untaken Resits
                  const rs = await tx.resit.count({ where: { indexno: st.indexno, taken: false } });
                  const isPassedResit = !Boolean(rs);
                  if (!isPassedResit) {
                     verified = false;
                     verifiedRemark.push(`Untaken Resit(s)`)
                  }

                  // #2. Check Whether Total Credit hours in assessment is greater or equal to Program Credit Minimum
                  const isPassedCreditTotal = (as?._sum?.credit || 0) >= st?.program?.creditTotal;
                  if (!isPassedCreditTotal) {
                     verified = false;
                     verifiedRemark.push(`Program Credit Minimum Not Met`);
                  }

                  // #3. Check Whether IC or Incomplete Courses exist.
                  if (incompleteCount > 0) {
                     verified = false;
                     verifiedRemark.push(`${incompleteCount} IC(s) Identified`);
                  }

                  // None of the 3 checks exclude a student from the list anymore — a
                  // failure just marks them unverified with a remark (checks #1-#3
                  // above) so staff can see the issue on the ISSUES tab instead of the
                  // student silently vanishing from generation.
                  return await tx.graduate.upsert({
                     where: { indexno: st?.indexno },
                     create: { cgpa, verified, verifiedRemark: verifiedRemark ? verifiedRemark?.join(", ") : null, class: graduateClass, indexno: st?.indexno, graduateSessionId: resp?.id },
                     update: { cgpa, verified, verifiedRemark: verifiedRemark ? verifiedRemark?.join(", ") : null, class: graduateClass }
                  })
               }));
            }, { timeout: 60000 });

            // Return Response
            return res.status(200).json(resp)
         } else {
            return res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchGraduateSession(req: Request, res: Response) {
      try {
         const resp = await ais.graduateSession.findUnique({
            where: { id: paramStr(req.params.id) },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postGraduateSession(req: Request, res: Response) {
      try {

         const resp = await ais.graduateSession.create({
            data: {
               ...req.body,
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateGraduateSession(req: Request, res: Response) {
      try {
         const resp = await ais.graduateSession.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteGraduateSession(req: Request, res: Response) {
      try {
         const resp = await ais.graduateSession.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   /* Graduate */
   async fetchGraduates(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               graduateSession: { default: true },
               OR: [
                  { student: { id: { contains: keyword } } },
                  { student: { indexno: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
                  { graduateSession: { title: { contains: keyword } } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.graduate.count({
               ...(searchCondition),
            }),
            ais.graduate.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  student: { include: { program: true } },
                  graduateSession: true
               }
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchGraduateList(req: Request, res: Response) {
      try {
         const resp = await ais.graduate.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchGraduate(req: Request, res: Response) {
      try {
         const resp = await ais.graduate.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
            include: { program: true }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async uploadGraduate(req: any, res: Response) {
      try {
         const data = req.body;
         let resp: any;
         console.log("Data: ", data?.length)
         if (data?.length) {
            let logs:any = [];
            const certPrintedBy: any = req.userId;
            let count = 0;
            // for(let row of data){
            await Promise.all(data.map( async(row: any) => {
               let { certno: certNo, indexno, year, cgpa } = row;
               // Log Record
               logs.push({ indexno, graduateSession: `${year} GRADUATION `})
               // Get Student Data - Check If  student Exist
               const st = await ais.student.findFirst({ 
                  where: { indexno },
               });
              
               //console.log("st: ", !!st)
               if(!st) count += 1;

               if(st?.indexno){
                    console.log("st: ", !!st), st?.fname
                  try {
                     let graduateSessionId;
                     const classes: any = await curriculumClassMeta(ais, st);
                     const graduateClass = getClass(cgpa, classes);
                     // Upsert Graduation Session, 
                     const gs = await ais.graduateSession.findFirst({ where: { title: `${year} GRADUATION` }});
                     if(gs){
                        graduateSessionId = gs?.id
                     } else {
                        const insGs = await ais.graduateSession.create({ data: { title: `${year} GRADUATION`, description: `${year} GRADUATION`, start: new Date(`${year}-11-15`), end: new Date(`${year}-11-20`), status: true, default: false  }});
                        console.log("insGs: ",insGs); 
                        graduateSessionId = insGs?.id;
                     }
                     // Update Graduation Data and Status
                     const gst = await ais.graduate.upsert({
                        where: { indexno: st?.indexno?.trim() },
                        create: { cgpa: String(cgpa), certNo: String(certNo), class: graduateClass, certPrinted: true, certPrintedAt: new Date(`${year}-11-01`), certPrintedBy, indexno: st?.indexno?.trim(), graduateSessionId },
                        update: { cgpa: String(cgpa), certNo: String(certNo), class: graduateClass }
                     })

                     if(gst){
                        // Remove from Log
                        logs = logs?.filter((r:any) => r.indexno != indexno);
                        // Update CGPA, Graduate Status, Complete Status in Student Model
                        await ais.student.update({ where: { id: st?.id }, data: { graduateStatus: true, completeStatus: true, completeType: 'GRADUATION' } });
                     }
                     
                  } catch (error: any) {
                     // Remove from Log
                     logs = logs?.filter((r:any) => r.indexno != indexno);
                     const lg = await ais.graduateLog.upsert({
                        where: { indexno_graduateSession: { indexno, graduateSession: `${year} GRADUATION` } },
                        create: { indexno, graduateSession: `${year} GRADUATION`, reason: error instanceof CurriculumSchemeError ? error.message : error?.code?.toUpperCase() },
                        update: { reason: error instanceof CurriculumSchemeError ? error.message : error?.code?.toUpperCase()  }
                     })
                     console.log(`LOG ${indexno}: `,lg)
                  }
                 
               } else {
                  // Remove from Log
                  logs = logs?.filter((r:any) => r.indexno != indexno);
                  // const lg = await ais.graduateLog.create({ data: { indexno, graduateSession: `${year} GRADUATION`, reason: `STUDENT NOT FOUND - CHECK INDEXNO`  }});
                  const lg = await ais.graduateLog.upsert({
                     where: { indexno_graduateSession: { indexno, graduateSession: `${year} GRADUATION` } },
                     create: { indexno, graduateSession: `${year} GRADUATION`, reason: `STUDENT NOT FOUND` },
                     update: { reason: `STUDENT NOT FOUND` }
                  })
                  console.log(`LOG ${indexno}: `,lg)
               }

              
            })) 

            // 
            console.log("MAIN LOGS: ", logs?.length);
            
            // Commit Skipped Logs
            await Promise.all(logs.map( async(row: any) => {
               const lg = await ais.graduateLog.upsert({
                  where: { indexno_graduateSession: { indexno: row.indexno, graduateSession: row.graduateSession  } },
                  create: { indexno: row.indexno, graduateSession: row.graduateSession , reason: 'STUDENT SKIPPED' },
                  update: { reason: 'STUDENT SKIPPED' }
               })
               console.log(`MAIN LOG ${row.indexno}: `,lg)
            }));

            resp = data?.length;
         
         } 


         if (resp) {
            console.log(resp)
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log("Return Error", error.message)
         return res.status(202).json({ message: error.message })
      }
   }


   async uploadGraduateSupplement(req: any, res: Response) {
      try {
         const data = req.body;
         let resp: any;
         console.log("Data: ", data?.length)
         if (data?.length) {
            const certPrintedBy: any = req.userId;
            let count = 0;
            // for(let row of data){
            await Promise.all(data.map( async(row: any) => {
               let { indexno } = row;
               const st = await ais.student.updateMany({ 
                  where: { indexno: String(indexno)},
                  data: { graduateStatus: false }
               });
              
               if(st?.count) count += 1;
            })) 
            resp = count; 
         } 

         if (resp) {
            return res.status(200).json({ success: true, data: resp })
         } else {
            return res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log("Return Error", error.message)
         return res.status(202).json({ message: error.message })
      }
   }


   async excludeGraduate(req: Request, res: Response) {
      console.log("body: ",req.body)
      try {
         const resp = await ais.student.updateMany({
            where: {
               indexno: paramStr(req?.params?.id)
            },
            data: {
               ...req.body,
            }
         })
         console.log("resp: ", resp);
         if (resp) {
            res.status(200).json({ success: true, data: resp })
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   async postGraduate(req: Request, res: Response) {
      try {

         const resp = await ais.graduate.create({
            data: {
               ...req.body,
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateGraduate(req: Request, res: Response) {
      try {
         const resp = await ais.graduate.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteGraduate(req: Request, res: Response) {
      try {
         const resp = await ais.graduate.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Academic Broadsheet */
   async fetchBroadsheetOld(req: Request, res: Response) {
      try {
         const workbook = new ExcelJS.Workbook();
         const worksheet = workbook.addWorksheet('Final Year Broadsheet');

         let students: any = [], courseData = new Map();
         // Get Final and Completing Student
         let finalStudents = await ais.$queryRaw`select s.fname,s.mname,s.lname,s.indexno,p.longName as program,semesterNum,s.completeStatus,s.deferStatus from ais_student s left join ais_program p on s.programId = p.id where s.semesterNum = p.semesterTotal`;
         const indexnos = finalStudents.filter((r: any) => r.indexno).map((r: any) => r.indexno);
         let results = await ais.assessment.findMany({
            where: { indexno: { in: indexnos } },
            include: { course: true }
         })

         results.map((row: any) => {
            if (courseData.has(`${row.course?.title} (${row.courseId})`)) {
               let courseRecs = courseData.get(`${row.course?.title} (${row.courseId})`);
               if (courseRecs[row.indexno])
                  courseRecs[row.indexno].push(row)
               else
                  courseRecs[row.indexno] = [row];
               courseData.set(`${row.course?.title} (${row.courseId})`, courseRecs)

            } else {
               let courseRecs = { [row.indexno]: [row] };
               courseData.set(`${row.course?.title} (${row.courseId})`, courseRecs)
            }
         })

         students = finalStudents.map((row: any) => {
            let studentData: any = {
               'INDEX NUMBER': row.indexno,
               'NAME OF STUDENT': row.fname + ' ' + (row.mname ? row.mname + ' ' : '') + row.lname,
               'PROGRAM OF STUDY': row.program,
            }

            const cs = Object.keys(Object.fromEntries(courseData));
            for (const key of cs) {
               // const hasData:any = Array.from(courseData).map(([key, data]: any) => { console.log(Object.values(data)); return Object.values(data) }).flat(1).filter((r: any) => r.indexno == row.indexno && r.courseId == key);
               const hasData: any = Array.from(courseData).map(([key, data]: any) => { console.log(Object.values(data)); return Object.values(data) }).flat(2);
               // studentData[key] = hasData.length > 1 ? hasData.join(',') : hasData.length == 1 ? (hasData[0].totalScore || ''):'';
               // studentData[key] = hasData.length > 0 ?  hasData[0].totalScore:'';
               console.log('hasData: ', hasData);
            }
            return studentData;
         })

         // Excel Column names
         const columnNames = Object.keys(students[0]);
         worksheet.columns = columnNames.map((column) => ({ header: column, key: column }));
         // Excel Data
         students.map((student: any) => worksheet.addRow(student));
         console.log("results: ", Array.from(courseData));

         if (students) {
            // Excel File
            //   const buffer = await workbook.xlsx.writeBuffer();
            const filename = 'Final Year Broadsheet.xlsx';
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename=' + filename);
            // Write the workbook to the response stream
            await workbook.xlsx.write(res);
            res.end();
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // VIEW SCRIPT:  create view broadsheet as select x.*,o.title,o.semester,o.year,o.createdAt as sessionCreatedAt,m.gradeMeta,m.classMeta,c.title as courseTitle,upper(s.fname) as fname,upper(s.mname) as mname,upper(s.lname) as lname,p.longName as program,p.shortName as programShortName,j.longName as major,j.shortName as majorShortName,p.stype,p.category,s.semesterNum as curSemesterNum,s.completeStatus,s.deferStatus,s.graduateStatus,s.gender,s.entryDate,s.programId,s.majorId,g.cgpa,g.class,s.id as studentId from ais_assessment x left join ais_course c on x.courseId = c.id left join ais_student s on s.indexno = x.indexno left join ais_program p on s.programId = p.id left join ais_major j on s.majorId = j.id left join ais_session o on x.sessionId = o.id left join ais_scheme m on x.schemeId = m.id left join ais_graduate g on s.indexno = g.indexno left join ais_graduate_session n on g.graduateSessionId = n.id where x.indexno in (select s.indexno from ais_student s left join ais_program p on s.programId = p.id where s.semesterNum = 0 and s.completeStatus = 1 order by s.programId,s.indexno,x.semesterNum);


   async fetchBroadsheet(req: Request, res: Response) {
      try {
         const { program } = req.body;
         let students: any = [], courseData = new Map(), finalStudents = new Map();
         let results = await ais.broadsheet.findMany({
            where: {
               ... (program && program != 'all' && ({ programId: program }))
            },
            orderBy: [
               { program: 'asc' },
               { majorId: 'asc' },
               { lname: 'asc' }
            ]
         });
         results.map((row: any) => {
            // Set Final Year Student Bio
            if (!finalStudents.has(row.indexno))
               finalStudents.set(row.indexno, { fname: row.fname, mname: row.mname, lname: row.lname, indexno: row.indexno, semesterNum: row.curSemesterNum, program: row.program, major: row.major, fgpa: row.cgpa, class: row.class })

            // Set Course & Assessment Data
            if (courseData.has(`${row.courseTitle} (${row.courseId})`)) {
               let courseRecs = courseData.get(`${row.courseTitle} (${row.courseId})`);
               if (courseRecs[row.indexno])
                  courseRecs[row.indexno].push(row)
               else
                  courseRecs[row.indexno] = [row];
               courseData.set(`${row.courseTitle} (${row.courseId})`, courseRecs)

            } else {
               let courseRecs = { [row.indexno]: [row] };
               courseData.set(`${row.courseTitle} (${row.courseId})`, courseRecs)
            }
         })

         // Populate Final Year Broadsheet
         students = Object.keys(Object.fromEntries(finalStudents)).map((rowKey: any) => {
            const studentBio: any = finalStudents.get(rowKey);

            let studentData: any = {
               'INDEX NUMBER': studentBio.indexno,
               'STUDENT NAME': studentBio.lname + ', ' + studentBio.fname + ' ' + (studentBio.mname ? studentBio.mname + ' ' : ''),
               // 'SURNAME': studentBio.lname,
               // 'OTHERNAME(S)': studentBio.fname + ' ' + (studentBio.mname ? studentBio.mname + ' ' : ''),
               'STUDY PROGRAM': studentBio.program,
               'STUDY MAJOR ': studentBio.major,
               'FGPA': studentBio.fgpa,
               'CLASS': studentBio.class,
            }

            const cs = Object.keys(Object.fromEntries(courseData));
            for (const cskey of cs) {
               const hasData2 = Array.from(courseData)?.filter(([key, _]: any) => key == cskey)?.map(([_, data]: any) => data)[0][rowKey] ?? null;
               studentData[cskey] = hasData2?.length ? hasData2.map((m: any) => m.totalScore).join(" | ") : '';
            }
            return studentData;
         })

         if (students) {
            res.status(200).json({ type: req.body?.type, data: students })
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   /* Circulars */
   async fetchNotices(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { reference: { contains: keyword } },
                  { title: { contains: keyword } },
                  { receiver: { contains: keyword } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.informer.count({
               ...(searchCondition),
            }),
            ais.informer.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Circulars (informer notices) addressed to the signed-in student, for the
   // student app. A student can only read their own.
   async fetchMyCirculars(req: Request & any, res: Response) {
      try {
         const id = paramStr(req.params.id);
         if (req.userId != id) return res.status(403).json({ message: "You can only view your own circulars." });
         const st: any = await ais.student.findUnique({ where: { id }, include: { program: { select: { semesterTotal: true, category: true } } } });
         if (!st) return res.status(404).json({ message: "Student not found" });
         const audiences = studentAudiences(st);
         const items = audiences.length ? await ais.informer.findMany({
            where: { status: true, receiver: { in: audiences as any } },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: { id: true, reference: true, title: true, content: true, receiver: true, createdAt: true },
         }) : [];
         res.status(200).json({ audiences, items });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: 'Could not load circulars' })
      }
   }

   async sendNotice(req: Request, res: Response) {
      try {
         const resp = await ais.informer.findUnique({
            where: { id: req.body.noticeId }
         })
         if (resp) {
            let receivers: any = [];

            if (resp.receiver == 'FRESHER') {
               const rs = await ais.student.findMany({
                  where: { completeStatus: false, deferStatus: false, phone: { not: null } },
                  select: { semesterNum: true, entrySemesterNum: true, phone: true },
               })
               receivers = rs?.filter((r: any) => ((r.semesterNum == r.entrySemesterNum) || (r.semesterNum == r.entrySemesterNum + 1))).map((r: any) => r?.phone);

            } else if (resp.receiver == 'FINAL') {
               const rs = await ais.student.findMany({
                  where: { completeStatus: false, deferStatus: false, phone: { not: null } },
                  select: { semesterNum: true, phone: true, program: { select: { semesterTotal: true } } },
               })
               receivers = rs?.filter((r: any) => ((r.semesterNum == r.program.semesterTotal) || (r.semesterNum == r.program.semesterTotal - 1))).map((r: any) => r?.phone);

            } else if (resp.receiver == 'STUDENT') {
               const rs = await ais.student.findMany({
                  where: { completeStatus: false, deferStatus: false, phone: { not: null } },
                  select: { phone: true },
               })
               receivers = rs?.map((r: any) => r?.phone);

            } else if (resp.receiver == 'UNDERGRAD') {
               const rs = await ais.student.findMany({
                  where: { completeStatus: false, deferStatus: false, program: { category: 'UG' }, phone: { not: null } },
                  select: { phone: true },
               })
               receivers = rs?.map((r: any) => r?.phone);

            } else if (resp.receiver == 'POSTGRAD') {
               const rs = await ais.student.findMany({
                  where: { completeStatus: false, deferStatus: false, program: { category: 'PG' }, phone: { not: null } },
                  select: { phone: true },
               })
               receivers = rs?.map((r: any) => r?.phone);

            } else if (resp.receiver == 'ALUMNI') {
               const rs = await ais.student.findMany({
                  where: { completeStatus: true, graduateStatus: true, phone: { not: null } },
                  select: { phone: true },
               })
               receivers = rs?.map((r: any) => r?.phone);

            } else if (resp.receiver == 'STAFF') {
               const rs = await ais.staff.findMany({
                  where: { status: true, phone: { not: null } },
                  select: { phone: true },
               })
               receivers = rs?.map((r: any) => r?.phone);

            } else if (resp.receiver == 'HOD') {
               const rs = await ais.unit.findMany({
                  where: { type: 'ACADEMIC', levelNum: 2 },
                  select: { phone: true, headStaffNo: true },
               })
               receivers = await Promise.all(rs?.map(async (r: any) => {
                  const st = await ais.staff.findFirst({ where: { staffNo: r?.headStaffNo, phone: { not: null } } });
                  return st?.phone
               }));

            } else if (resp.receiver == 'DEAN') {
               const rs = await ais.unit.findMany({
                  where: { type: 'ACADEMIC', levelNum: 1 },
                  select: { phone: true, headStaffNo: true },
               })
               receivers = await Promise.all(rs?.map(async (r: any) => {
                  const st = await ais.staff.findFirst({ where: { staffNo: r?.headStaffNo, phone: { not: null } } });
                  return st?.phone
               }));

            } else if (resp.receiver == 'ASSESSOR') {
               const rs = await ais.unit.findMany({
                  where: { type: 'ACADEMIC', levelNum: 1 },
                  select: { phone: true, headStaffNo: true },
               })
               receivers = await Promise.all(rs?.map(async (r: any) => {
                  const st = await ais.staff.findFirst({ where: { staffNo: r?.headStaffNo, phone: { not: null } } });
                  return st?.phone
               }));

            } else if (resp.receiver == 'DEBTOR') {
               const rs = await ais.student.findMany({
                  where: { completeStatus: true, deferStatus: true, accountNet: { gt: 0 }, phone: { not: null } },
                  select: { phone: true },
               })
               receivers = rs?.map((r: any) => r?.phone);
            }

            // Also push it to the student app (via akaweb) for student audiences.
            void broadcastCircular(resp).catch(() => undefined);

            // Clean Receivers phone numbers
            const send = receivers?.map(async (phone: string) => {
               const mobile: any = phone.replace('-', '').replace(' ', '').replace('+233', '0').replace('.', '').replace('_', '');
               console.log(mobile);
               if (mobile?.length == 10 || mobile?.length == 11)
                  return await sms(mobile, resp.smsContent);
               return;
            })
            // Return Response
            res.status(200).json(send)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchNotice(req: Request, res: Response) {
      try {
         const resp = await ais.informer.findUnique({
            where: {
               id: paramStr(req.params.id)
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postNotice(req: Request, res: Response) {
      try {

         const resp = await ais.informer.create({
            data: {
               ...req.body,
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateNotice(req: Request, res: Response) {
      try {
         const resp = await ais.informer.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteNotice(req: Request, res: Response) {
      try {
         const resp = await ais.informer.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   /* Deferments */
   async fetchDeferments(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { student: { id: { contains: keyword } } },
                  { student: { indexno: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
                  { session: { title: { contains: keyword } } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.activityDefer.count({
               ...(searchCondition),
            }),
            ais.activityDefer.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  student: { include: { program: true } },
                  session: true
               }
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchDefermentList(req: Request, res: Response) {
      try {
         const resp = await ais.activityDefer.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchDeferment(req: Request, res: Response) {
      try {
         let resp = await ais.activityDefer.findUnique({
            where: { id: paramStr(req.params.id) },
            include: { student: { include: { program: true } }, session: true }
         })
         if (resp) {
            // Calculate Resumption 
            const year = Number(moment(resp.letterDate).add(resp?.durationInYears, "years").format("YYYY"));
            const academicYear = `${year}/${year + 1}`;

            // Fetch Deferment Letter
            const letter = await ais.letter.findFirst({ where: { tag: resp.status == 'RESUMED' ? 'res' : 'def' } });
            resp.letter = { ...letter, academicYear, student: resp?.student };

            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postDeferment(req: Request, res: Response) {
      try {
         const { indexno, sessionId, semesterNum, reason, durationInYears, start, end, letterDate } = req.body;
         const resp = await ais.activityDefer.create({
            data: {
               semesterNum: Number(semesterNum),
               reason,
               durationInYears: Number(durationInYears),
               start,
               end,
               letterDate,
               ...indexno && ({ student: { connect: { indexno } } }),
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateDeferment(req: Request, res: Response) {
      try {
         let { indexno, sessionId, semesterNum, reason, durationInYears, status, start, end, letterDate } = req.body;
         delete req.body.indexno;
         delete req.body.sessionId;

         let deferStatus = status == 'APPROVED' ? true : false;
         start = ['APPROVED', 'RESUMED'].includes(status) ? (start != null ? start : new Date()) : null;
         end = ['RESUMED'].includes(status) ? (end != null ? end : new Date()) : null;

         const resp = await ais.activityDefer.update({
            where: { id: paramStr(req.params.id) },
            data: {
               semesterNum: Number(semesterNum),
               reason,
               durationInYears: Number(durationInYears),
               status,
               start,
               end,
               letterDate,
               ...indexno && ({ student: { connect: { indexno } } }),
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
            }
         })
         if (resp) {
            // Update Student Status
            await ais.student.update({ where: { indexno }, data: { deferStatus } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async upgradeDeferment(req: Request, res: Response) {
      try {
         let { indexno, status } = req.body;
         let deferStatus = status == 'APPROVED' ? true : false;
         let start = ['APPROVED'].includes(status) ? new Date() : null;
         let end = ['RESUMED'].includes(status) ? new Date() : null;

         const resp = await ais.activityDefer.update({
            where: { id: paramStr(req.params.id) },
            data: {
               status,
               ...end && ({ end }),
               ...start && ({ start }),
            }
         })
         if (resp) {
            // Update Student Status
            await ais.student.update({ where: { indexno }, data: { deferStatus } })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteDeferment(req: Request, res: Response) {
      try {
         const resp = await ais.activityDefer.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   /* Service Letters */
   async fetchLetters(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { tag: { contains: keyword } },
                  { title: { contains: keyword } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.letter.count({
               ...(searchCondition),
            }),
            ais.letter.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchLetterList(req: Request, res: Response) {
      try {
         const resp = await ais.letter.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchLetter(req: Request, res: Response) {
      try {
         const resp = await ais.letter.findFirst({
            where: {
               OR: [
                  { id: paramStr(req.params.id) },
                  { tag: paramStr(req.params.id) },
               ]
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postLetter(req: Request, res: Response) {
      try {
         const data = letterFields(req.body);
         const missing = ['title', 'tag', 'signature'].filter((k) => !data[k]);
         if (missing.length) return res.status(400).json({ message: `Please provide: ${missing.join(', ')}.` });
         const clash = await letterTagClash(data.tag);
         if (clash) return res.status(400).json({ message: `A letter already uses this category ("${clash.title}"). Edit that letter instead.` });

         const resp = await ais.letter.create({ data: { signatory: '', template: '', ...data } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateLetter(req: Request, res: Response) {
      try {
         const id = paramStr(req.params.id);
         const data = letterFields(req.body);
         if ('title' in data && !data.title) return res.status(400).json({ message: 'Title is required.' });
         if (data.tag) {
            const clash = await letterTagClash(data.tag, id);
            if (clash) return res.status(400).json({ message: `Another letter already uses this category ("${clash.title}").` });
         }
         const resp = await ais.letter.update({ where: { id }, data })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteLetter(req: Request, res: Response) {
      try {
         const resp = await ais.letter.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }




   /* Transwift  */
   async fetchTranswifts(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { student: { id: { contains: keyword } } },
                  { student: { indexno: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
                  { issuer: { staffNo: { contains: keyword } } },
                  { transact: { transtag: { contains: keyword } } },
                  { transact: { transtype: { title: { contains: keyword } } } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.transwift.count({
               ...(searchCondition),
            }),
            ais.transwift.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               orderBy: { 'createdAt': 'desc' },
               include: {
                  student: { include: { program: true } },
                  issuer: true,
                  transact: { include: { transtype: true } }
               }
            })
         ]);

         //if(resp && resp[1]?.length){
         res.status(200).json({
            totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
            totalData: resp[1]?.length,
            data: resp[1],
         })
         //} else {
         //res.status(202).json({ message: `no records found` })
         //}
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchTranswiftList(req: Request, res: Response) {
      try {
         const resp = await ais.transwift.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchTranswiftByStudent(req: Request, res: Response) {
      try {
         const resp = await ais.transwift.findMany({
            where: { studentId: paramStr(req.params.id) },
            include: {
               student: { include: { program: true } },
               transact: { include: { transtype: true } }
            },
            orderBy: { 'createdAt': 'desc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchTranswift(req: Request, res: Response) {
      try {
         const resp = await ais.transwift.findUnique({
            where: { id: paramStr(req.params.id) },
            include: {
               student: { include: { program: true } },
               issuer: true,
               transact: { include: { transtype: true } }
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postTranswift(req: Request, res: Response) {
      try {

         const resp = await ais.transwift.create({
            data: {
               ...req.body,
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async upgradeTranswift(req: Request, res: Response) {
      try {
         const { } = req.body;
         const resp = await ais.transwift.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async updateTranswift(req: Request, res: Response) {
      try {
         const resp = await ais.transwift.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteTranswift(req: Request, res: Response) {
      try {
         const resp = await ais.transwift.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   /* Evaluations */
   async fetchEvaluations(req: Request, res: Response) {
      const { page = 1, pageSize = 10, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      try {
         // Course-only — this view and EvaluationCardItem.tsx are entirely
         // course-oriented (a "COURSES: {count}" badge, print-slip link);
         // without this scoping, non-course (sts/ims) submissions would show
         // up here as phantom extra cards once students start completing them.
         let searchCondition: any = { where: { courseId: { not: null } } };

         if (keyword) {
            searchCondition = {
               where: {
                  courseId: { not: null },
                  session: { default: true },
                  OR: [
                     { student: { indexno: { contains: keyword } } },
                     { student: { fname: { contains: keyword } } },
                     { student: { lname: { contains: keyword } } },
                     { student: { id: { contains: keyword } } },
                  ]
               }
            };
         }

         const resp = await ais.$transaction([
            ais.courseEvaluation.groupBy({
               by: ['sessionId', 'indexno'],
               _count: {
                  indexno: true
               },
               ...(searchCondition)
            }),
            ais.courseEvaluation.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  student: { include: { program: true } },
                  session: true,
               },
               distinct: ['sessionId', 'indexno'],
               orderBy: { createdAt: 'desc' }
            })
         ]);

         console.log('Evals: ', resp[0].length);

         if (resp && resp[1]?.length) {
            console.log('Evals: ', resp);
            res.status(200).json({
               totalPages: Math.ceil(resp[0].length / pageSize) || 0,
               totalData: resp[1]?.length,
               data: resp[1]
            });
         } else {
            res.status(204).json({ message: "No evaluations found" });
         }
      } catch (error: any) {
         console.log(error);
         return res.status(500).json({ message: error.message });
      }
   }





   /* App Roles */

   async fetchARoleList(req: Request, res: Response) {
      try {
         let resp = await ais.appRole.findMany({
            where: { status: true },
            select: {
               id: true,
               title: true,
               description: true,
               appModule: {
                 select: {
                   tag: true,
                   title: true,
                   app: { select: { tag: true, title: true } }
                 }
               }
             },
             orderBy: [
               { appModule: { app: { createdAt: 'asc' }}},
               { appModule: { createdAt: 'asc' }},
               {createdAt: 'asc'}
             ]
         })

         if (resp) {
            resp = resp.map((r:any) => {
               return ({
                  roleId: r?.id,
                  role: `${r.appModule?.tag}::${r?.title?.toLowerCase()}`,
                  roleDesc: r?.description,
                  module: r.appModule?.tag,
                  app:  r.appModule?.app?.tag
               })
           })
            return res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* User Roles */

   async fetchURoleList(req: Request, res: Response) {
      try {
         const { staffId } = req.body
         let resp = await ais.userRole.findMany({
            where: { user: { tag: staffId.toString() } },
            include: { 
              appRole: {
                select: {
                  id: true,
                  title: true,
                  description: true,
                  appModule: {
                    select: {
                      tag: true,
                      title: true,
                      app: { select: { tag: true, title: true } }
                    }
                  }
                }
              }
            }
          });
  
        
         if (resp?.length) {
            resp = resp.map((r:any) => {
               return ({
                  id: r.id,
                  userId: r.userId,
                  roleId: r.appRole?.id,
                  role: `${r.appRole?.appModule?.tag}::${r.appRole?.title?.toLowerCase()}`,
                  roleDesc: r.appRole?.description,
                  module: r.appRole?.appModule?.tag,
                  app:  r.appRole?.appModule?.app?.tag
               })
            })
            
           return res.status(200).json(resp)
         } else {
            res.status(200).json([])
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: 'Internal server error' })
      }
   }


   async fetchURoles(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      try {
         const where: any = keyword ? {
            OR: [
               { user: { tag: { contains: keyword } } },
               { appRole: { title: { contains: keyword } } },
            ],
         } : {};

         const [count, roles] = await ais.$transaction([
            ais.userRole.count({ where }),
            ais.userRole.findMany({
               where,
               skip: offset,
               take: Number(pageSize),
               orderBy: { createdAt: 'desc' },
               include: {
                  user: { select: { tag: true, groupId: true } },
                  appRole: {
                     select: {
                        title: true,
                        description: true,
                        appModule: { select: { tag: true, title: true, app: { select: { tag: true, title: true } } } },
                     },
                  },
               },
            }),
         ]);

         if (roles?.length) {
            // Staff details aren't on the sso.user record itself, so batch-fetch
            // them from hr.staff by tag and merge in.
            const tags = [...new Set(roles.map((r: any) => r.user?.tag).filter(Boolean))];
            const staffList = tags.length
               ? await ais.staff.findMany({ where: { staffNo: { in: tags } }, select: { staffNo: true, fname: true, mname: true, lname: true, email: true } })
               : [];
            const staffMap = new Map(staffList.map((s: any) => [s.staffNo, s]));

            const data = roles.map((r: any) => {
               const staff: any = staffMap.get(r.user?.tag);
               return {
                  id: r.id,
                  tag: r.user?.tag,
                  name: staff ? `${staff.fname} ${staff.mname ? staff.mname + ' ' : ''}${staff.lname}` : r.user?.tag,
                  mail: staff?.email,
                  role: `${r.appRole?.appModule?.tag}::${r.appRole?.title?.toLowerCase()}`,
                  roleTitle: r.appRole?.title,
                  roleDesc: r.appRole?.description,
                  module: r.appRole?.appModule?.tag,
                  app: r.appRole?.appModule?.app?.tag,
                  roleMeta: r.roleMeta,
                  createdAt: r.createdAt,
               };
            });

            res.status(200).json({
               totalPages: Math.ceil(count / pageSize) || 1,
               totalData: count,
               data,
            })
         } else {
            res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async fetchURole(req: Request, res: Response) {
      try {
         const resp = await ais.userRole.findUnique({
            where: {
               id: Number(paramStr(req.params.id))
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postURole(req: Request, res: Response) {
      try {
         const { appRoleId, staffNo } = req.body
         delete req.body.appRoleId;
         delete req.body.staffNo;
         let resp;

         const user = await ais.user.findFirst({ where: { tag: staffNo.toString() } })
         if (!user) throw new Error(`No SSO account found for staff ${staffNo}`);

         const targetRole = await ais.appRole.findUnique({
            where: { id: Number(appRoleId) },
            select: {
               title: true,
               appModule: { select: { tag: true, title: true } }
            }
         })
         if (!targetRole) throw new Error(`Selected role could not be found`);

         // A staff member may hold roles across many modules, but only one
         // role within any single module at a time (e.g. can't be both
         // student::admin and student::clerk simultaneously) — assigning a
         // second role in the same module must replace, not stack on top
         // of, the one already held there.
         const existingInModule = await ais.userRole.findFirst({
            where: {
               userId: user.id,
               appRole: { appModule: { tag: targetRole.appModule?.tag } },
            },
            select: { appRole: { select: { title: true } } },
         })
         if (existingInModule) {
            const moduleLabel = targetRole.appModule?.title || targetRole.appModule?.tag;
            throw new Error(
               `This staff member already holds the "${existingInModule.appRole?.title}" role in the ${moduleLabel} module. Remove it before assigning "${targetRole.title}".`
            );
         }

         resp = await ais.userRole.create({
            data: {
               roleMeta: '',
               ...req.body,
               ...appRoleId && ({ appRole: { connect: { id: Number(appRoleId) } } }),
               user: { connect: { id: user.id } },
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateURole(req: Request, res: Response) {
      try {
         const resp = await ais.userRole.update({
            where: {
               id: Number(paramStr(req.params.id))
            },
            data: {
               ...req.body,
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteURole(req: Request, res: Response) {
      try {
         const resp = await ais.userRole.delete({
            where: { id: Number(paramStr(req.params.id)) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Access Control -- role assignment by person, on the App > Module > Role
      catalogue. A person holds at most one role per module. */

   // Everything the Access Control page shows: the active catalogue with
   // each role's holders, and each person who holds a role.
   async fetchAccessOverview(req: Request, res: Response) {
      try {
         const [apps, assignments] = await Promise.all([
            ais.app.findMany({
               where: { status: true },
               orderBy: { createdAt: 'asc' },
               select: {
                  tag: true, title: true,
                  appModules: {
                     where: { status: true },
                     orderBy: { createdAt: 'asc' },
                     select: {
                        id: true, tag: true, title: true, description: true,
                        appRoles: { where: { status: true }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, description: true } },
                     },
                  },
               },
            }),
            ais.userRole.findMany({
               orderBy: { createdAt: 'asc' },
               select: {
                  id: true, roleMeta: true, createdAt: true, appRoleId: true,
                  user: { select: { id: true, tag: true, groupId: true } },
                  appRole: { select: { title: true, status: true, appModule: { select: { tag: true, title: true, app: { select: { tag: true } } } } } },
               },
            }),
         ]);
         const people = await accessPeople(assignments.map((a: any) => a.user).filter(Boolean));

         const holdersByRole = new Map<number, any[]>();
         const byUser = new Map<string, any>();
         for (const a of assignments) {
            if (!a.user) continue;
            const person = people.get(a.user.tag);
            const roleTag = `${a.appRole?.appModule?.tag}::${a.appRole?.title?.toLowerCase()}`;
            if (!holdersByRole.has(a.appRoleId)) holdersByRole.set(a.appRoleId, []);
            holdersByRole.get(a.appRoleId)!.push({ userRoleId: a.id, tag: a.user.tag, name: person?.name, groupId: a.user.groupId, assignedAt: a.createdAt });
            if (!byUser.has(a.user.tag)) byUser.set(a.user.tag, { ...person, tag: a.user.tag, groupId: a.user.groupId, roles: [] });
            byUser.get(a.user.tag).roles.push({
               userRoleId: a.id, roleId: a.appRoleId, role: roleTag, title: a.appRole?.title,
               module: a.appRole?.appModule?.tag, moduleTitle: a.appRole?.appModule?.title, app: a.appRole?.appModule?.app?.tag,
               active: !!a.appRole?.status, note: a.roleMeta, assignedAt: a.createdAt,
            });
         }

         res.status(200).json({
            apps: apps.map((app: any) => ({
               tag: app.tag, title: app.title,
               modules: app.appModules.map((m: any) => ({
                  id: m.id, tag: m.tag, title: m.title, description: m.description,
                  roles: m.appRoles.map((r: any) => ({
                     id: r.id, title: r.title, description: r.description,
                     role: `${m.tag}::${r.title?.toLowerCase()}`,
                     holders: holdersByRole.get(r.id) ?? [],
                  })),
               })),
            })),
            users: [...byUser.values()].sort((a, b) => (a.name || a.tag).localeCompare(b.name || b.tag)),
         });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // One person's access: who they are and the role ids they hold.
   async fetchUserAccess(req: Request, res: Response) {
      try {
         const tag = paramStr(req.params.tag).trim();
         const user = await ais.user.findFirst({ where: { tag }, select: { id: true, tag: true, groupId: true } });
         const person = (await accessPeople(user ? [user] : [{ tag, groupId: 2 }])).get(tag);
         const roles = user ? await ais.userRole.findMany({ where: { userId: user.id }, select: { id: true, appRoleId: true, roleMeta: true, createdAt: true } }) : [];
         res.status(200).json({
            ...person, tag, groupId: user?.groupId ?? null, hasAccount: !!user,
            roles: roles.map((r: any) => ({ userRoleId: r.id, roleId: r.appRoleId, note: r.roleMeta, assignedAt: r.createdAt })),
         });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Replace a person's roles with exactly `roleIds`: validates the set,
   // then grants/revokes only the difference in one transaction and logs it.
   async saveUserAccess(req: any, res: Response) {
      try {
         const tag = paramStr(req.params.tag).trim();
         const roleIds: number[] = [...new Set<number>((req.body?.roleIds || []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0))];
         const note = String(req.body?.note ?? '').trim().slice(0, 255);

         const user = await ais.user.findFirst({ where: { tag }, select: { id: true, tag: true } });
         if (!user) return res.status(400).json({ message: `${tag} has no portal account yet. Stage their account first, then assign roles.` });

         const roles = roleIds.length ? await ais.appRole.findMany({
            where: { id: { in: roleIds } },
            select: { id: true, title: true, status: true, appModule: { select: { tag: true, title: true } } },
         }) : [];
         const missing = roleIds.filter((id) => !roles.some((r: any) => r.id === id));
         if (missing.length) return res.status(400).json({ message: `Unknown role(s): ${missing.join(', ')}. Reload the page and try again.` });

         // One role per module.
         const perModule = new Map<string, any[]>();
         for (const r of roles) {
            const k = r.appModule?.tag;
            if (!perModule.has(k)) perModule.set(k, []);
            perModule.get(k)!.push(r);
         }
         const clashes = [...perModule.values()].filter((rs) => rs.length > 1);
         if (clashes.length) {
            return res.status(400).json({ message: `Only one role per module is allowed: ${clashes.map((rs) => `${rs[0].appModule?.title || rs[0].appModule?.tag} (${rs.map((r: any) => r.title).join(' / ')})`).join('; ')}.` });
         }

         const current = await ais.userRole.findMany({
            where: { userId: user.id },
            select: { id: true, appRoleId: true, appRole: { select: { title: true, appModule: { select: { tag: true } } } } },
         });
         const tagOf = (r: any) => `${r.appModule?.tag}::${r.title?.toLowerCase()}`;
         const toRevoke = current.filter((c: any) => !roleIds.includes(c.appRoleId));
         const toGrant = roles.filter((r: any) => !current.some((c: any) => c.appRoleId === r.id));
         const inactive = toGrant.filter((r: any) => !r.status);
         if (inactive.length) return res.status(400).json({ message: `Disabled role(s) can't be granted: ${inactive.map(tagOf).join(', ')}.` });

         // Don't let an administrator lock themselves out of this page.
         if (tag === req.userId && toRevoke.some((c: any) => tagOf(c.appRole) === 'access::admin')) {
            return res.status(400).json({ message: `You can't remove your own Access Control admin role -- you'd lose access to role management. Ask another administrator to do it.` });
         }

         if (toRevoke.length || toGrant.length) {
            await ais.$transaction([
               ...(toRevoke.length ? [ais.userRole.deleteMany({ where: { id: { in: toRevoke.map((c: any) => c.id) } } })] : []),
               ...toGrant.map((r: any) => ais.userRole.create({ data: { userId: user.id, appRoleId: r.id, roleMeta: note } })),
               ais.log.create({
                  data: {
                     action: 'USER_ROLES_UPDATED', user: req.userId,
                     meta: { tag, granted: toGrant.map(tagOf), revoked: toRevoke.map((c: any) => tagOf(c.appRole)), note: note || null },
                  },
               }),
            ]);
         }
         res.status(200).json({ granted: toGrant.map(tagOf), revoked: toRevoke.map((c: any) => tagOf(c.appRole)) });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Admission Letters */

   async fetchAdmissionLetters(req: Request, res: Response) {
      try {
         const resp = await ais.admissionLetter.findMany({
            select: { id: true, title: true, category: true, year: true, status: true, programId: true, updatedAt: true, program: { select: { shortName: true, longName: true, category: true } } },
            orderBy: [{ status: 'desc' }, { updatedAt: 'desc' }],
         })
         res.status(200).json(resp)
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: errorMessage(error) })
      }
   }

   async fetchAdmissionLetter(req: Request, res: Response) {
      try {
         const resp = await ais.admissionLetter.findUnique({ where: { id: paramStr(req.params.id) }, include: { program: { select: { shortName: true, longName: true, category: true } } } })
         if (resp) res.status(200).json(resp)
         else res.status(404).json({ message: `Admission letter not found` })
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: errorMessage(error) })
      }
   }

   // Shared create/update validation: programme must exist; a programme
   // has at most one active letter (the one printed).
   async saveAdmissionLetter(req: Request, res: Response) {
      try {
         const id = req.params.id ? paramStr(req.params.id) : null;
         const data = admissionLetterFields(req.body);
         const existing = id ? await ais.admissionLetter.findUnique({ where: { id } }) : null;
         if (id && !existing) return res.status(404).json({ message: 'Admission letter not found' });
         const merged = { status: true, ...existing, ...data };
         const missing = ['title', 'programId', 'signature'].filter((k) => !merged[k]);
         if (merged.year != null && (merged.year < 2000 || merged.year > 2100)) return res.status(400).json({ message: 'Admission year must be between 2000 and 2100.' });
         if (missing.length) return res.status(400).json({ message: `Please provide: ${missing.map((k) => (k === 'programId' ? 'programme' : k)).join(', ')}.` });
         const program = await ais.program.findUnique({ where: { id: merged.programId }, select: { longName: true, category: true } });
         if (!program) return res.status(400).json({ message: 'Selected programme not found.' });
         if (!data.category && !existing) data.category = program.category || 'UG';
         if (merged.status) {
            const clash = await ais.admissionLetter.findFirst({ where: { programId: merged.programId, status: true, ...(id && { id: { not: id } }) }, select: { title: true } });
            if (clash) return res.status(400).json({ message: `${program.longName} already has an active admission letter ("${clash.title}"). Deactivate or edit that one instead.` });
         }
         const resp = id
            ? await ais.admissionLetter.update({ where: { id }, data })
            : await ais.admissionLetter.create({ data: { signatory: '', template: '', ...data } });
         res.status(200).json(resp)
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: errorMessage(error) })
      }
   }

   async deleteAdmissionLetter(req: Request, res: Response) {
      try {
         const resp = await ais.admissionLetter.delete({ where: { id: paramStr(req.params.id) } })
         res.status(200).json(resp)
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: errorMessage(error) })
      }
   }

   // Print data for one student (?studentId=) or all newly admitted first
   // years of a programme (?programId=).
   async fetchAdmissionLetterPrint(req: Request, res: Response) {
      try {
         const studentId = String(req.query.studentId || '').trim();
         const programId = String(req.query.programId || '').trim();
         let students: any[] = [];
         let pid = programId;
         if (studentId) {
            const st = await ais.student.findUnique({ where: { id: studentId }, select: ADMISSION_STUDENT_SELECT });
            if (!st) return res.status(404).json({ message: 'Student not found.' });
            if (!st.programId) return res.status(400).json({ message: 'This student has no programme, so no admission letter applies.' });
            students = [st];
            pid = st.programId;
         } else if (programId) {
            // The letter decides the cohort (its admission year), so load it first.
            const letter = await activeAdmissionLetter(programId);
            if (letter) students = await ais.student.findMany({ where: { programId, ...admissionCohortWhere(letter) }, select: ADMISSION_STUDENT_SELECT, orderBy: [{ lname: 'asc' }, { fname: 'asc' }] });
            const bundle = await admissionPrintBundle(programId, students, letter);
            if (bundle.letter) return res.status(200).json(bundle);
         } else {
            return res.status(400).json({ message: 'Choose a student or a programme.' });
         }
         const bundle = await admissionPrintBundle(pid, students);
         if (!bundle.letter) {
            const program = await ais.program.findUnique({ where: { id: pid }, select: { longName: true } });
            return res.status(400).json({ message: `No active admission letter for ${program?.longName || 'this programme'}. Create one under Admission Letters first.` });
         }
         res.status(200).json(bundle)
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: errorMessage(error) })
      }
   }

   // "Activate Admission" on an admission letter: for the letter's freshers
   // (its cohort -- see admissionCohortWhere -- still in Year 1 Sem 1) not
   // yet activated, create any missing portal account + institute email,
   // mark the offer PENDING and text each one that they've been admitted and
   // should log in to view the letter and accept or reject the offer.
   // Re-running only picks up freshers added since, so nobody is texted twice.
   async activateAdmission(req: any, res: Response) {
      try {
         const letter = await ais.admissionLetter.findUnique({ where: { id: paramStr(req.params.id) }, include: { program: { select: { longName: true } } } });
         if (!letter) return res.status(404).json({ message: 'Admission letter not found.' });
         if (!letter.status || !letter.programId) return res.status(400).json({ message: 'Only an active admission letter tied to a programme can be activated.' });

         const freshers = await ais.student.findMany({
            where: { programId: letter.programId, ...admissionCohortWhere(letter), semesterNum: 1, deferStatus: false, admissionStatus: null },
            select: { id: true, fname: true, mname: true, lname: true, phone: true, instituteEmail: true },
         });
         if (!freshers.length) return res.status(200).json({ total: 0, activated: 0, errors: [], message: 'No freshers awaiting activation for this programme and admission year.' });

         const accounts = await ais.user.findMany({ where: { tag: { in: freshers.map((s: any) => s.id) } }, select: { tag: true } });
         const hasAccount = new Set(accounts.map((a: any) => a.tag));
         const notice = (s: any, login: string) => admissionSmsText(letter.smsTemplate, s, letter, login);
         const credentials = (s: any) => (username: string, password: string) => notice(s, `Username: ${username}, Password: ${password}`);

         const userId = req.userId;
         const activated: string[] = [];
         const errors: { id: string; reason: string }[] = [];
         for (const s of freshers) {
            try {
               // Exactly one SMS per fresher: whichever step issues the
               // password texts it inside the admission notice.
               if (!hasAccount.has(s.id)) await stageStudentAccess(s.id, userId, !!s.instituteEmail, credentials(s));
               if (!s.instituteEmail) {
                  await generateStudentEmail(s.id, userId, true, credentials(s));
               } else if (hasAccount.has(s.id) && s.phone) {
                  try {
                     await sms(s.phone, notice(s, 'Use your existing portal login.'));
                  } catch (smsError: any) {
                     console.log('activateAdmission SMS send failed:', smsError?.message);
                  }
               }
               // Set last: a fresher whose provisioning failed stays NULL and
               // is retried by the next activation.
               await ais.student.update({ where: { id: s.id }, data: { admissionStatus: 'PENDING' } });
               activated.push(s.id);
            } catch (activateError: any) {
               console.log('activateAdmission failed for', s.id, activateError);
               errors.push({ id: s.id, reason: errorMessage(activateError, 'Failed to activate admission') });
            }
         }
         await ais.log.create({ data: { action: 'ADMISSION_ACTIVATED', user: userId, meta: { letterId: letter.id, programId: letter.programId, count: activated.length, ids: activated, errors } as any } });
         res.status(200).json({ total: freshers.length, activated: activated.length, errors });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: errorMessage(error) })
      }
   }

   // Student portal: the signed-in fresher's own admission letter (the same
   // bundle the staff print uses, incl. the fee bill + bank account) and
   // where their offer stands.
   async fetchMyAdmission(req: any, res: Response) {
      try {
         const id = paramStr(req.params.id);
         if (req.userId != id) return res.status(403).json({ message: 'You can only view your own admission.' });
         const st: any = await ais.student.findUnique({ where: { id }, select: { ...ADMISSION_STUDENT_SELECT, admissionStatus: true, admissionRespondedAt: true, accountNet: true, flagPardon: true } });
         if (!st) return res.status(404).json({ message: 'Student not found.' });
         // Freshers (semesters 1-2) only -- continuing students have no
         // Admission page, matching the portal's hasAdmissionOffer.
         if (!st.admissionStatus || !st.programId || ![1, 2].includes(Number(st.semesterNum))) return res.status(404).json({ message: 'There is no admission offer on your record.' });
         const bundle = await admissionPrintBundle(st.programId, [st]);
         res.status(200).json({ ...bundle, admissionStatus: st.admissionStatus, admissionRespondedAt: st.admissionRespondedAt });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: errorMessage(error) })
      }
   }

   // Student portal: accept or reject a PENDING admission offer. Final --
   // the status is part of the where, so a second click (or a request after
   // answering) changes nothing.
   async respondAdmission(req: any, res: Response) {
      try {
         const id = paramStr(req.params.id);
         if (req.userId != id) return res.status(403).json({ message: 'You can only answer your own admission offer.' });
         const decision = String(req.body?.decision || '').toUpperCase();
         if (decision !== 'ACCEPTED' && decision !== 'REJECTED') return res.status(400).json({ message: 'Choose to accept or reject the offer.' });
         const resp = await ais.student.updateMany({ where: { id, admissionStatus: 'PENDING' }, data: { admissionStatus: decision, admissionRespondedAt: new Date() } });
         if (!resp.count) return res.status(400).json({ message: 'This admission offer has already been answered. Contact the Registry for any change.' });
         await ais.log.create({ data: { action: `ADMISSION_${decision}`, user: id, student: id, meta: { decision } } });
         res.status(200).json({ admissionStatus: decision });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: errorMessage(error) })
      }
   }

   async checkUser(req: Request, res: Response) {
      try {
         const { userId } = req.body
         const resp = await ais.user.findFirst({ where: { tag: userId?.toString() } })
         res.status(200).json(!!resp)

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }



   /* Staff */
   async fetchStaffs(req: Request, res: Response) {
      const { page = 1, pageSize = 6, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { staffNo: { contains: keyword } },
                  { fname: { contains: keyword } },
                  { lname: { contains: keyword } },
                  { phone: { contains: keyword } },
                  { email: { contains: keyword } },
               ],
            }
         }
         const resp = await ais.$transaction([
            ais.staff.count({
               ...(searchCondition),
            }),
            ais.staff.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  title: { select: { label: true } },
                  country: { select: { longName: true } },
                  region: { select: { title: true } },
                  religion: { select: { title: true } },
                  marital: { select: { title: true } },
                  unit: { select: { title: true } },
                  job: { select: { title: true } },
                  //promotion:{ select: { job: { select: { title:true }}}},
               }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(202).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchStaff(req: Request, res: Response) {
      try {
         const resp = await ais.staff.findUnique({
            where: {
               staffNo: paramStr(req.params.id)
            },
            include: {
               title: { select: { label: true } },
               country: { select: { longName: true } },
               region: { select: { title: true } },
               religion: { select: { title: true } },
               marital: { select: { title: true } },
               unit: { select: { title: true } },
               job: { select: { title: true } },
               //promotion:{ select: { job: { select: { title:true }}}},
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async stageStaff(req: Request & any, res: Response) {
      try {
         const staffId = req.body?.staffId?.toString()?.trim();
         if (!staffId) throw new Error("No staff number provided!")
         const password = pwdgen();
         const st = await ais.staff.findFirst({ where: { staffNo: staffId } })
         // Login resolves staff details from the staff row (authController),
         // so a portal account without one can sign in but has no profile.
         if (!st) throw new Error("Staff record not found!")
         const isUser = await ais.user.findFirst({ where: { tag: staffId, groupId: 2 } })
         if (isUser) throw new Error("Staff User Account Exists!")
         // `||` (not `??`): some staff rows carry an empty-string instituteEmail.
         const ssoData = { tag: staffId, username: st?.instituteEmail?.trim() || staffId, password: hashPassword(password) }  // Others
         // Populate SSO Account
         const resp = await ais.user.create({
            data: {
               ...ssoData,
               group: { connect: { id: 2 } },
            },
         })
         if (resp) {
            // Send Password By SMS -- quote the username actually stored on the
            // account (login matches on sso_user.username), not instituteEmail.
            if (st?.phone) {
               const phone = st.phone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();
               try {
                  await sms(phone, `Hi! Your new credentials are Username: ${resp.username}, Password: ${password}`)
               } catch (smsError: any) {
                  console.log('stageStaff SMS send failed:', smsError?.message)
               }
            }
            // Audit: who staged which staff account (no credentials logged).
            await ais.log.create({ data: { action: `STAFF_ACCOUNT_STAGED`, user: req?.userId, meta: { staffId, username: resp.username, via: req?.originalUrl, smsSent: !!st?.phone } } })
            // Never return the password hash to the client.
            const { password: _hash, unlockPin: _pin, ...account } = resp;
            res.status(200).json({ ...account, password })
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message || 'Internal server error' })
      }
   }

   async resetStaff(req: Request & any, res: Response) {
      try {
         const staffId = req.body?.staffId?.toString()?.trim();
         if (!staffId) throw new Error("No staff number provided!")
         const password = pwdgen();
         const st = await ais.staff.findFirst({ where: { staffNo: staffId } })
         const user = await ais.user.findFirst({ where: { tag: staffId, groupId: 2 } })
         if (!user) return res.status(202).json({ message: `No staff user account found. Stage the account first.` })
         await ais.user.update({ where: { id: user.id }, data: { password: hashPassword(password) } })
         // Audit: who reset which staff account (no credentials logged).
         await ais.log.create({ data: { action: `STAFF_ACCOUNT_RESET`, user: req?.userId, meta: { staffId, via: req?.originalUrl, smsSent: !!st?.phone } } })
         // Send Password By SMS -- quote the account's real login username
         // (login matches on sso_user.username), which can differ from
         // staff.instituteEmail or be set when that column is null/empty.
         if (st?.phone) {
            const phone = st.phone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();
            try {
               await sms(phone, `Hi! Your credentials are Username: ${user.username}, Password: ${password}`)
            } catch (smsError: any) {
               console.log('resetStaff SMS send failed:', smsError?.message)
            }
         }
         res.status(200).json({ username: user.username, password })

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message || 'Internal server error' })
      }
   }

   async staffRole(req: Request, res: Response) {
      try {
         const { staffId } = req.body
         const resp = await ais.userRole.findMany({
            where: { user: { tag: staffId.toString() } },
            include: { appRole: { select: { title: true, appModule: { select: { app: true } } } } }
         })
         if (resp?.length) {
            res.status(200).json(resp.map((r: any) => ({ ...r, appRole: { title: r.appRole?.title, app: r.appRole?.appModule?.app } })))
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: 'Internal server error' })
      }
   }

   async postStaff(req: Request, res: Response) {
      try {
         const st = await ais.staff.findFirst({ where: { staffNo: { notIn: ['16000', '15666'] } }, orderBy: { 'staffNo': 'desc' } });
         const { titleId, maritalId, countryId, regionId, religionId, unitId, jobId } = req.body
         req.body.staffNo = req.body.staffNo ? req.body.staffNo?.toString() : (parseInt(st.staffNo) + 1).toString();
         delete req.body.titleId; delete req.body.maritalId;
         delete req.body.countryId; delete req.body.regionId;
         delete req.body.religionId; delete req.body.unitId;
         delete req.body.jobId;
         req.body.exitDate = toDate(req.body.exitDate);
         req.body.dob = toDate(req.body.dob);
         req.body.phone = req.body.phone ? req.body.phone : null;
         req.body.email = req.body.email ? req.body.email : null;
         req.body.ssnitNo = req.body.ssnitNo ? req.body.ssnitNo : null;
         req.body.ghcardNo = req.body.ghcardNo ? req.body.ghcardNo : null;

         const resp = await ais.staff.create({
            data: {
               ...req.body,
               ...maritalId && ({ marital: { connect: { id: maritalId } } }),
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...countryId && ({ country: { connect: { id: countryId } } }),
               ...regionId && ({ region: { connect: { id: regionId } } }),
               ...religionId && ({ religion: { connect: { id: religionId } } }),
               ...unitId && ({ unit: { connect: { id: unitId } } }),
               ...jobId && ({ job: { connect: { id: jobId } } }),
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateStaff(req: Request, res: Response) {
      try {
         const st = await ais.staff.findFirst({ where: { staffNo: { notIn: ['16000', '15666'] } }, orderBy: { 'staffNo': 'desc' } });
         const { titleId, maritalId, countryId, regionId, religionId, unitId, jobId, instituteEmail } = req.body
         delete req.body.titleId; delete req.body.maritalId;
         delete req.body.countryId; delete req.body.regionId;
         delete req.body.religionId; delete req.body.unitId;
         delete req.body.jobId; //   
         req.body.staffNo = req.body.staffNo > 0 ? req.body.staffNo?.toString() : (parseInt(st?.staffNo) + 1).toString();
         req.body.exitDate = toDate(req.body.exitDate);
         req.body.dob = toDate(req.body.dob);
         req.body.phone = req.body.phone ? req.body.phone : null;
         req.body.email = req.body.email ? req.body.email : null;
         req.body.ssnitNo = req.body.ssnitNo ? req.body.ssnitNo : null;
         req.body.ghcardNo = req.body.ghcardNo ? req.body.ghcardNo : null;



         const resp = await ais.staff.update({
            where: { staffNo: paramStr(req.params.id) },
            data: {
               ...req.body,
               ...maritalId && ({ marital: { connect: { id: maritalId } } }),
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...countryId && ({ country: { connect: { id: countryId } } }),
               ...regionId && ({ region: { connect: { id: regionId } } }),
               ...religionId && ({ religion: { connect: { id: religionId } } }),
               ...unitId && ({ unit: { connect: { id: unitId } } }),
               ...jobId && ({ job: { connect: { id: jobId } } }),
            }
         })
         if (resp) {
            if (paramStr(req.params.id) != req.body.staffNo) {
               // Update SSO User with New (Tag/Username)
               await ais.user.updateMany({ where: { tag: paramStr(req.params.id), groupId: 2 }, data: { tag: req.body.staffNo, username: instituteEmail ? instituteEmail : req.body.staffNo?.toString() } });
               // Update Photo FileName
               const tag = paramStr(req.params.id)?.toString().split("/").join("").trim().toLowerCase();
               const dtag = req.body.staffNo.split("/").join("").trim().toLowerCase();
               var file = path.join(__dirname, "/../../public/cdn/photo/staff/", tag + '.jpg');
               var dfile = path.join(__dirname, "/../../public/cdn/photo/staff/", dtag + '.jpg');
               var stats = fs.statSync(file);
               if (stats) fs.renameSync(file, dfile);

            } else {
               // Update Email as tag in sso_user
               if (instituteEmail) await ais.user.updateMany({ where: { tag: paramStr(req.params.id) }, data: { username: instituteEmail } });
            }
            // Return Response
            res.status(200).json(resp)

         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteStaff(req: Request, res: Response) {
      try {
         // Remove User Account
         await ais.user.deleteMany({ where: { tag: paramStr(req.params.id) } })
         // Hard Delete Staff Record
         const resp = await ais.staff.delete({ where: { staffNo: paramStr(req.params.id) } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Helpers */
   async fetchCountries(req: Request, res: Response) {
      try {
         const resp = await ais.country.findMany({
            where: { status: true },
            orderBy: { createdAt: 'asc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchRegions(req: Request, res: Response) {
      try {
         const resp = await ais.region.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchReligions(req: Request, res: Response) {
      try {
         const resp = await ais.religion.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchDisabilities(req: Request, res: Response) {
      try {
         const resp = await ais.disability.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchCategories(req: Request, res: Response) {
      try {
         const resp = await ais.category.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchRelations(req: Request, res: Response) {
      try {
         const resp = await ais.relation.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchMarital(req: Request, res: Response) {
      try {
         const resp = await ais.marital.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchTitles(req: Request, res: Response) {
      try {
         const resp = await ais.title.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchCollectors(req: Request, res: Response) {
      try {
         const resp = await ais.collector.findMany()
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchAppRoles(req: Request, res: Response) {
      try {
         const resp = await ais.appRole.findMany()
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }










   async runData(req: Request, res: Response) {
      try {
         let resp;
         // const subjects:any = require('../../util/subjects.json');
         // const structure:any = require('../../util/structure.json');
         // const courses:any = require('../../util/courses2.json');
         //  const students = require('../../util/active_student.json');
         //   const staff = require('../../util/staff.json');
         //  const users = require('../../util/users.json');
         //  const jobs = require('../../util/job.json');
         //  const scores = require('../../util/_calendar.json');
         //const scores = require('../../util/_graduate.json');
         //  const scores = require('../../util/units.json');
         // const courses = require('../../util/akatsico_courses.json');
         // const courses = require('../../util/courses.json');

         // if(courses.length){
         //   for(const course of courses){
         //      console.log(course)
         //      const ins = await ais.course.create({
         //          data: {
         //             id: course.course_code,
         //             title: course.title?.toUpperCase(),
         //             creditHour: Number(course.credit),
         //             remark:'ACTIVE'
         //          }
         //      })
         //   }
         // }
         //  if(jobs.length){
         //    for(const subj of jobs){
         //       console.log(subj)
         //       const ins = await ais.job.create({
         //           data: {
         //              title: subj?.title, 
         //              type: subj?.type, 
         //              staffCategory: subj?.staff_group, 
         //              status: true
         //           }
         //       })
         //       console.log(ins)
         //    }
         //  }


         // if(students.length){
         //   for(const student of students){
         //      console.log(student)
         //      const ins = await ais.student.create({
         //          data: {
         //             id: student?.refno,
         //             indexno: student.indexno,
         //             fname: student.fname?.toUpperCase(),
         //             mname: student.mname?.toUpperCase(),
         //             lname: student.lname?.toUpperCase(),
         //             ... student?.dob && ({ dob: moment(student?.dob,'YYYY-MM-DD').toDate() }),
         //             ... student?.doa && ({ entryDate: moment(student?.doa,'YYYY-MM-DD').toDate() }),
         //             ... student?.doc && ({ exitDate: moment(student?.doc,'YYYY-MM-DD').toDate() }),
         //             entryGroup: student.entry_group,
         //             semesterNum: Number(student?.semester),
         //             phone: student.phone?.replace("+233","0")?.substring(0,10),
         //             email: student.email,
         //             gender: student.gender,
         //             guardianName: student.guardian_name,
         //             guardianPhone: student.guardian_phone,
         //             instituteEmail: student.institute_email,
         //             completeStatus: student.complete_status == 1 ? true : false,
         //             deferStatus: student.defer_status == 1 ? true : false,
         //             graduateStatus: student.graduate_status == 1 ? true : false,
         //             studyMode: student.session,
         //             ... student?.transact_account && ({ accountNet: parseFloat(student.transact_account) }),
         //             ... student?.entry_semester && ({ entrySemesterNum: Number(student.entry_semester) }),
         //             ... student?.prog_id && ({ program: { connect: { id: student?.prog_id }} }),
         //             ... student?.major_id && ({ major: { connect: { id: student?.major_id }} }),
         //             ... student?.country_id && ({ country: { connect: { id: student?.country_id }} }),
         //             //country: { connect: { id: "96b0a1d5-7899-4b9a-bcbe-7a72eee6572c" } },
         //          }
         //      })
         //   }
         // }

         // if(staff.length){
         //    for(const st of staff){
         //       console.log(st)
         //       const ins = await ais.staff.create({
         //           data: {
         //              staffNo: st?.staff_no?.toString(),
         //              fname: st.fname?.toUpperCase(),
         //              mname: st.mname?.toUpperCase(),
         //              lname: st.lname?.toUpperCase(),
         //              dob: st?.dob && moment(st?.dob,'YYYY-MM-DD').toDate(),
         //              phone: st.phone,
         //              email: st.email,
         //              residentAddress: st.address,
         //              gender: st.gender,
         //              hometown: st.hometown,
         //              birthplace: st.birth_place,
         //              ssnitNo: st.ssnit,
         //              instituteEmail: st.inst_mail,
         //              qualification: st.position,
         //             //  religion: { connect: { id: st.religionId }},
         //             ... st.unit_id && ({ unit: { connect: { id: st.unit_id?.toString() }}}),
         //             ... st.job_id && ({ job: { connect: { id: st.job_id?.toString() }}}),
         //             // job: { connect: { id: st.job_id }},
         //             country: { connect: { id: "96b0a1d5-7899-4b9a-bcbe-7a72eee6572c" }},
         //           }
         //       })
         //    }
         // }

         // if(structure.length){
         //   for(const struct of structure){
         //      console.log(struct)
         //      const ins = await ais.structure.create({
         //          data: {
         //             course: { connect: { id: struct.courseId }},
         //             unit: { connect: { id: struct.unitId }},
         //             program: { connect: { id: struct.programId }},
         //             type: struct.type,
         //             semesterNum: Number(struct.semesterNum),
         //          }
         //      })
         //   }
         // }

         //  if(subjects.length){
         //   for(const subj of subjects){
         //      console.log(subj)
         //      const ins = await ais.subject.create({
         //          data: {
         //             title: subj?.title 
         //          }
         //      })
         //   }
         // }

         // if(scores.length){
         //    for(const st of scores){
         //       console.log(st)
         //       const ins = await ais.assessment.create({
         //           data: {
         //              //indexno: st?.indexno,
         //              credit: Number(st.credit),
         //              semesterNum: Number(st.semesterNum),
         //              classScore: parseFloat(st.classScore),
         //              examScore: parseFloat(st.examScore),
         //              totalScore: parseFloat(st.totalScore),
         //              type: 'N',
         //              session: {
         //                 connect: {
         //                    id: st.sessionId
         //                 }
         //              },
         //              scheme: {
         //                connect: {
         //                   id: st.schemeId
         //                }
         //             },
         //             course: {
         //                connect: {
         //                   id: st.courseId?.trim()
         //                }
         //             },
         //             student: {
         //                connect: {
         //                   indexno: st.indexno?.trim()
         //                }
         //             },

         //           }
         //       })
         //    }
         // }


         //  if(scores.length){
         //   for(const subj of scores){
         //      console.log(subj)
         //      const ins = await ais.unit.create({
         //          data: {
         //             code: subj?.code, 
         //             title: subj?.title, 
         //             type: subj?.type, 
         //             location: subj?.location, 
         //             levelNum: Number(subj?.level), 
         //          }
         //      })
         //   }
         // }

         // if(scores.length){
         //    for(const subj of scores){
         //       console.log(subj)
         //       const ins = await ais.major.create({
         //           data: {
         //              shortName: subj?.title, 
         //              longName: subj?.title, 
         //              status: true
         //           }
         //       })
         //    }
         //  }

         // if(scores.length){
         //    for(const subj of scores){
         //       console.log(subj)
         //       const ins = await ais.program.create({
         //           data: {
         //              code: subj?.code, 
         //              prefix: subj?.prefix, 
         //              shortName: subj?.short, 
         //              longName: subj?.long, 
         //              category: subj?.group_id, 
         //              semesterTotal: Number(subj?.semesters), 
         //              creditTotal: Number(subj?.credits), 
         //           }
         //       })
         //    }
         //  }

         // if(scores.length){
         //    for(const subj of scores){
         //       console.log(subj)
         //       const ins:any = await ais.student.create({
         //          data: {
         //             id: subj?.refno,
         //             indexno: subj.indexno,
         //             fname: subj.fname?.toUpperCase() || '',
         //             mname: subj.mname?.toUpperCase() || '',
         //             lname: subj.lname?.toUpperCase() || '',
         //             //dob: moment(subj?.dob,'DD/MM/YYYY').toDate(),
         //             semesterNum: Number(subj.semester) || 0,
         //             phone: subj.phone,
         //             email: subj.email,
         //             gender: subj.gender,
         //             completeStatus: !!subj.complete_status,
         //             deferStatus: !!subj.defer_status,
         //             graduateStatus: !!subj.graduate_status,
         //             // program: {
         //             //    connect: {
         //             //       id: subj.programId
         //             //    }
         //             // },
         //             country: {
         //                connect: {
         //                   id: "96b0a1d5-7899-4b9a-bcbe-7a72eee6572c"
         //                }
         //             },
         //          },

         //       })
         //    }
         //  }

         // if(scores.length){
         //    for(const subj of scores){
         //       console.log(subj)
         //       const ins:any = await ais.student.upsert({
         //          where: { id: subj?.refno },
         //          create: {
         //             id: subj?.refno,
         //             indexno: subj.indexno,
         //             fname: subj.fname?.toUpperCase() || '',
         //             mname: subj.mname?.toUpperCase() || '',
         //             lname: subj.lname?.toUpperCase() || '',
         //             //dob: moment(subj?.dob,'DD/MM/YYYY').toDate(),
         //             semesterNum: Number(subj.semester) || 0,
         //             phone: subj.phone?.substring(10),
         //             email: subj.email,
         //             gender: subj.gender,
         //             completeStatus: !!subj.complete_status,
         //             deferStatus: !!subj.defer_status,
         //             graduateStatus: !!subj.graduate_status,
         //             // program: {
         //             //    connect: {
         //             //       id: subj.programId
         //             //    }
         //             // },
         //             country: {
         //                connect: {
         //                   id: "96b0a1d5-7899-4b9a-bcbe-7a72eee6572c"
         //                }
         //             },
         //          },
         //          update: {
         //             indexno: subj.indexno,
         //             fname: subj.fname?.toUpperCase() || '',
         //             mname: subj.mname?.toUpperCase() || '',
         //             lname: subj.lname?.toUpperCase() || '',
         //             //dob: moment(subj?.dob,'DD/MM/YYYY').toDate(),
         //             semesterNum: Number(subj.semester) || 0,
         //             phone: subj?.phone?.substring(10),
         //             email: subj.email,
         //             gender: subj.gender,
         //             completeStatus: !!subj.complete_status,
         //             deferStatus: !!subj.defer_status,
         //             graduateStatus: !!subj.graduate_status,
         //             // program: {
         //             //    connect: {
         //             //       id: subj.programId
         //             //    }
         //             // },
         //             country: {
         //                connect: {
         //                   id: "96b0a1d5-7899-4b9a-bcbe-7a72eee6572c"
         //                }
         //             },
         //          },

         //       })
         //    }
         //  }

         //  if(users.length){
         //    for(const subj of users){
         //       console.log(subj)
         //       const ins = await ais.user.create({
         //           data: {
         //              groupId: Number(subj?.group_id), 
         //              tag: subj?.tag, 
         //              username: subj?.username, 
         //              password: subj?.password, 
         //          }
         //       })
         //    }
         //  }

         // if(scores.length){
         //    for(const subj of scores){
         //       console.log(subj)
         //       const ins = await ais.user.upsert({
         //           where: { tag: subj?.tag },
         //           create: {
         //              groupId: Number(subj?.group_id), 
         //              tag: subj?.tag, 
         //              username: subj?.username, 
         //              password: subj?.password, 
         //          },
         //          update: {
         //             username: subj?.username, 
         //             password: subj?.password, 
         //         }
         //       })
         //    }
         //  }
         //  // Calendar
         //  if(scores.length){
         //    for(const subj of scores){
         //       console.log(subj)
         //       const ins = await ais.session.create({
         //          data: {
         //             tag: subj?.tag, 
         //             title: subj?.title, 
         //             year: subj?.academic_year?.toString(), 
         //             semester: subj?.academic_sem == '1' ? 'SEM1':'SEM2', 
         //             default: !!subj?.default, 
         //             status: !!subj?.status
         //          }
         //       })
         //    }
         //  }

         //  // Schemes
         //  if(scores.length){
         //    for(const subj of scores){
         //       console.log(subj)
         //       const ins = await ais.scheme.create({
         //          data: {
         //             title: subj?.title, 
         //             gradeMeta: subj?.grade_meta || null, 
         //             classMeta: subj?.class_meta || null, 
         //             passMark: 0, 
         //          }
         //       })
         //    }
         //  }

         /* ADMISSION MIGRATIONS  */

         //const sessions = require('../../util/ams/session.json');
         //const letters = require('../../util/ams/letter.json');
         const vouchers = require('../../util/ams/voucher.json');

         //  if(vouchers.length){  // VOUCHERS
         //    for(const subj of vouchers){
         //       console.log(subj)
         //       const ins = await ais.voucher.create({
         //           data: {
         //              serial: subj?.serial?.toString(), 
         //              pin: subj?.pin, 
         //              applicantName: subj?.applicant_name, 
         //              applicantPhone: subj?.applicant_phone?.toString()?.substring(0,10), 
         //              sellType: subj?.sell_type, 
         //              status: subj?.status == 1 ? true: false, 
         //              ... subj?.sold_at && ({ soldAt: moment(subj?.sold_at,'YYYY-MM-DD').toDate() }),
         //              ... subj.session_id && ({ admission: { connect: { id: subj.session_id?.toString() }}}),
         //              ... subj.group_id && ({ category: { connect: { id: subj?.group_id }}}),
         //              ... subj.vendor_id && ({ vendor: { connect: { id: subj?.vendor_id }}}),
         //           }
         //       })
         //       console.log(ins)
         //    }
         //  }

         //  if(sessions.length){  // SESSIONS
         //    for(const subj of sessions){
         //       console.log(subj)
         //       const ins = await ais.admission.create({
         //           data: {
         //              title: subj?.title, 
         //              voucherIndex: subj?.voucher_index, 
         //              applyPause: subj?.apply_freeze == 1 ? true: false, 
         //              showAdmitted: subj?.admission_show == 1 ? true: false, 
         //              status: subj?.status == 1 ? true: false, 
         //              ... subj?.exam_start && ({ examStart: moment(subj?.exam_start,'YYYY-MM-DD').toDate() }),
         //              ... subj?.exam_end && ({ examStart: moment(subj?.exam_end,'YYYY-MM-DD').toDate() }),
         //              ... subj?.apply_start && ({ applyStart: moment(subj?.apply_start,'YYYY-MM-DD').toDate() }),
         //              ... subj?.apply_end && ({ applyEnd: moment(subj?.apply_end,'YYYY-MM-DD').toDate() }),
         //              ... subj?.admission_date && ({ admittedAt: moment(subj?.admission_date,'YYYY-MM-DD').toDate() }),
         //              ... subj.pg_letter && ({ pgletter: { connect: { id: subj.pg_letter }}}),
         //              ... subj.ug_letter && ({ ugletter: { connect: { id: subj.ug_letter }}}),
         //              ... subj.dp_letter && ({ dpletter: { connect: { id: subj.dp_letter }}}),
         //              ... subj.cp_letter && ({ cpletter: { connect: { id: subj.cp_letter }}}),
         //            }
         //       })
         //       console.log(ins)
         //    }
         //  }

         //  if(letters.length){
         //    for(const subj of letters){ // LETTERS
         //       console.log(subj)
         //       const ins = await ais.admissionLetter.create({
         //           data: {
         //              title: subj?.title, 
         //              signatory: subj?.signatory, 
         //              signature: subj?.signature, 
         //              template: subj?.template, 
         //              ... subj.tag && ({ category: { connect: { id: subj.tag }}}),
         //              status: subj?.status == 1 ? true: false
         //           }
         //       })
         //       console.log(ins)
         //    }
         //  }



         if (vouchers) {
            res.status(200).json(vouchers)
         } else {
            res.status(202).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async runAccount(req: Request, res: Response) {
      try {
         let resp = [];
         const students = await ais.student.findMany();
         // if(students.length){
         //   for(const student of students){
         //      const ins = await ais.user.create({
         //          data: {
         //             tag: student?.id,
         //             username: student?.id,
         //             password: sha1(student.fname?.toLowerCase()),
         //             unlockPin: '2024',
         //             locked: false,
         //             group: {
         //                connect: {
         //                   id: 1
         //                }
         //             },
         //          }
         //      })
         //      resp.push(ins)
         //   }
         // }
         // if(students){
         //   res.status(200).json(resp)
         // } else {
         //   res.status(202).json({ message: `no record found` })
         // }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   async academicStatus(req: Request, res: Response) {
      try {
         const id = paramStr(req.params.id);
         // Get Student Info
         const student: any = await ais.student.findUnique({ include: { program: { select: { hasMajor: true } } }, where: { id } })
         const indexno = student?.indexno;
         // Get Active Session Info -- no more MAIN/January-SUB stream split,
         // just the one default session.
         const session: any = await ais.session.findFirst({ where: { default: true } })

         const assessment: any = await ais.assessment.findFirst({ where: { sessionId: id, indexno } });

         const events: any = {
            'medicals': { start: session.medicalStart, end: session.medicalEnd },
            'orientation': { start: session.orientStart, end: session.orientEnd },
            'matriculation': { start: session.matriculateStart, end: session.matriculateStart },
            'registration': { start: session.registerStart, end: session.registerEndLate },
            'examination': { start: session.examStart, end: session.examEnd },
            'evaluation': { start: session.evaluationStart, end: session.evaluationEnd },
         }

         const event = Object.entries(events).find(([title, row]: any) => moment(new Date()).isBetween(moment(row?.start), moment(row?.end)));
         return res.status(200).json({ success: true, data: { student, session, events, event, isRegistered: !!assessment } })

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async nextClass(req: Request, res: Response) {
      try {
         let resp = [];
         const students = await ais.student.findMany();

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }






}