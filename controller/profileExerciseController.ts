import { Request, Response } from 'express';
import moment from 'moment';
import { prisma } from '../prisma/client';
const sms = require('../config/sms');
const db: any = prisma;

// Public, sign-in-free profile update exercise: a student finds their record
// (student ID, index number, phone or name) and corrects names, date of
// birth, phone, personal email and -- only while it's blank -- index number.
// Changes apply immediately (no identity check, by decision), so exposure is
// limited instead: the exercise only runs inside its configured window,
// search results and the edit form show phone / email / date of birth only
// partly, every change is logged with before/after and IP, and a changed
// phone number is announced to the old one. A phone set here also pauses
// self-service password reset for that student (authController
// forgetPassword) -- see PHONE_RESET_HOLD_DAYS.

export const EXERCISE_ACTION = 'PROFILE_EXERCISE_UPDATED';
export const PHONE_RESET_HOLD_DAYS = 0;

class ExerciseError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

// Closed unless both ends of the window are configured (ISO date-times in
// .env), so the page can't be left open by accident.
function window() {
  const openAt = Date.parse(process.env.PROFILE_UPDATE_OPEN_AT || '');
  const closeAt = Date.parse(process.env.PROFILE_UPDATE_CLOSE_AT || '');
  const now = Date.now();
  const configured = Number.isFinite(openAt) && Number.isFinite(closeAt);
  return {
    open: configured && now >= openAt && now < closeAt,
    opensAt: configured ? new Date(openAt).toISOString() : null,
    closesAt: configured ? new Date(closeAt).toISOString() : null,
  };
}
const requireOpen = () => { if (!window().open) throw new ExerciseError('The profile update exercise is not open right now.', 403); };

const handler = (fn: (req: any, res: Response) => Promise<any>) => async (req: Request, res: Response) => {
  try { return await fn(req, res); }
  catch (e: any) {
    if (e instanceof ExerciseError) return res.status(e.status).json({ message: e.message });
    if (e?.name === 'SmsError') return res.status(400).json({ message: 'Enter a valid phone number, e.g. 0244123456.' });
    if (e?.code === 'P2002') return res.status(409).json({ message: 'That index number already belongs to another student.' });
    console.error('Profile exercise:', e);
    return res.status(500).json({ message: 'Your request could not be completed. Please try again.' });
  }
};

// Partial reveals: enough for a student to recognise their own record.
const maskPhone = (v?: string | null) => (v && v.length >= 7 ? `${v.slice(0, 3)}****${v.slice(-3)}` : null);
const maskEmail = (v?: string | null) => {
  if (!v || !v.includes('@')) return null;
  const [user, domain] = v.split('@');
  return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
};
const maskId = (v?: string | null) => (v && v.length > 4 ? `${v.slice(0, 2)}${'*'.repeat(v.length - 4)}${v.slice(-2)}` : v || null);
const fullName = (s: any) => [s.fname, s.mname, s.lname].filter(Boolean).join(' ');

// Only students still on roll take part.
const ACTIVE = { completeStatus: false, graduateStatus: false };
const SEARCH_LIMIT = 8;

const NAME = /^[\p{L}][\p{L}' .-]*$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDEX = /^\d{10}$/;
function nameField(value: unknown, label: string, max: number, required: boolean) {
  const v = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
  if (!v) { if (required) throw new ExerciseError(`${label} is required.`); return null; }
  if (v.length > max || !NAME.test(v)) throw new ExerciseError(`${label} may only contain letters, spaces, hyphens and apostrophes.`);
  return v;
}

async function activeStudent(id: string) {
  const st = await db.student.findFirst({ where: { id, ...ACTIVE }, select: { id: true, fname: true, mname: true, lname: true, dob: true, phone: true, email: true, indexno: true, semesterNum: true, program: { select: { shortName: true, longName: true } } } });
  if (!st) throw new ExerciseError('Record not found. Search again.', 404);
  return st;
}

export default class ProfileExerciseController {
  status = handler(async (_req, res) => res.json(window()));

  search = handler(async (req, res) => {
    requireOpen();
    const q: string = typeof req.query.q === 'string' ? req.query.q.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
    if (q.length < 3) throw new ExerciseError('Enter at least 3 characters: your student ID, index number, phone number or name.');
    const or: any[] = [{ id: q }, { indexno: q }];
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 9 && digits.length === q.replace(/[\s+()-]/g, '').length) or.push({ phone: { endsWith: digits.slice(-9) } });
    // Name search: every word must match one of the names, and at least one
    // word must be 3+ letters so a single initial can't list the whole school.
    const words = q.split(' ').filter((w) => /\p{L}/u.test(w));
    if (words.length && words.some((w) => w.length >= 3)) {
      or.push({ AND: words.map((w) => ({ OR: [{ fname: { contains: w } }, { mname: { contains: w } }, { lname: { contains: w } }] })) });
    }
    const rows = await db.student.findMany({ where: { ...ACTIVE, OR: or }, select: { id: true, fname: true, mname: true, lname: true, phone: true, semesterNum: true, program: { select: { shortName: true, longName: true } } }, orderBy: [{ lname: 'asc' }, { fname: 'asc' }], take: SEARCH_LIMIT + 1 });
    return res.json({
      results: rows.slice(0, SEARCH_LIMIT).map((s: any) => ({
        id: s.id, idHint: maskId(s.id), name: fullName(s), program: s.program?.shortName || s.program?.longName || null,
        year: s.semesterNum ? Math.ceil(s.semesterNum / 2) : null, phoneHint: maskPhone(s.phone),
      })),
      more: rows.length > SEARCH_LIMIT,
    });
  });

  fetch = handler(async (req, res) => {
    requireOpen();
    const st = await activeStudent(String(req.params.id));
    return res.json({
      id: st.id, fname: st.fname, mname: st.mname, lname: st.lname,
      program: st.program?.longName || null, year: st.semesterNum ? Math.ceil(st.semesterNum / 2) : null,
      indexno: st.indexno, indexLocked: !!st.indexno,
      phoneHint: maskPhone(st.phone), emailHint: maskEmail(st.email), dobYear: st.dob ? moment.utc(st.dob).format('YYYY') : null,
    });
  });

  update = handler(async (req, res) => {
    requireOpen();
    const id = String(req.params.id);
    const body = req.body || {};
    const next: any = {
      fname: nameField(body.fname, 'First name', 255, true),
      mname: nameField(body.mname, 'Middle name', 350, false),
      lname: nameField(body.lname, 'Last name', 255, true),
    };
    // Optional fields: left blank means "keep what's on record".
    if (typeof body.dob === 'string' && body.dob.trim()) {
      const ymd = body.dob.trim().slice(0, 10);
      const dob = new Date(`${ymd}T00:00:00.000Z`);
      const age = moment().diff(moment.utc(ymd), 'years');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || isNaN(dob.getTime()) || age < 10 || age > 100) throw new ExerciseError('Enter a valid date of birth.');
      next.dob = dob;
    }
    if (typeof body.phone === 'string' && body.phone.trim()) next.phone = sms.normalizePhone(body.phone);
    if (typeof body.email === 'string' && body.email.trim()) {
      const email = body.email.trim().toLowerCase();
      if (email.length > 255 || !EMAIL.test(email)) throw new ExerciseError('Enter a valid email address.');
      next.email = email;
    }
    const indexno = typeof body.indexno === 'string' ? body.indexno.trim() : '';

    const result = await db.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM ais_student WHERE id = ${id} FOR UPDATE`;
      const before = await tx.student.findFirst({ where: { id, ...ACTIVE }, select: { id: true, fname: true, mname: true, lname: true, dob: true, phone: true, email: true, indexno: true } });
      if (!before) throw new ExerciseError('Record not found. Search again.', 404);
      // Assessments, registrations and resits are keyed by index number, so
      // an assigned one is never changed here -- only a missing one is filled.
      if (indexno && !before.indexno) {
        if (!INDEX.test(indexno)) throw new ExerciseError('Index number must be 10 digits.');
        if (await tx.student.findFirst({ where: { indexno }, select: { id: true } })) throw new ExerciseError('That index number already belongs to another student. Contact the Registry.', 409);
        next.indexno = indexno;
      }
      const changes: Record<string, { from: any; to: any }> = {};
      for (const [k, v] of Object.entries(next)) {
        const from = (before as any)[k] ?? null;
        const same = v instanceof Date ? from && new Date(from).getTime() === v.getTime() : (from ?? null) === (v ?? null);
        if (!same) changes[k] = { from, to: v };
      }
      if (!Object.keys(changes).length) return { before, changes };
      await tx.student.update({ where: { id }, data: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])) });
      await tx.log.create({ data: { action: EXERCISE_ACTION, user: 'public', student: id, meta: { changes, phoneChanged: !!changes.phone, ip: req.clientIp || req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) } as any } });
      return { before, changes };
    });

    const changed = Object.keys(result.changes);
    // Tell the old number its record moved -- the cheapest tripwire when
    // there's no identity check. Best-effort.
    if (result.changes.phone && result.before.phone) {
      await sms.safe(result.before.phone, `Your phone number on your college student record was changed to ${maskPhone(result.changes.phone.to)}. If you did not make this change, contact the Registry immediately.`);
    }
    return res.json({ changed, message: changed.length ? 'Your profile has been updated.' : 'No changes to save -- your record already has these details.' });
  });
}
