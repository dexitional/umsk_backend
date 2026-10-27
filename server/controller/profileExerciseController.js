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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHONE_RESET_HOLD_DAYS = exports.EXERCISE_ACTION = void 0;
const moment_1 = __importDefault(require("moment"));
const client_1 = require("../prisma/client");
const sms = require('../config/sms');
const db = client_1.prisma;
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
exports.EXERCISE_ACTION = 'PROFILE_EXERCISE_UPDATED';
exports.PHONE_RESET_HOLD_DAYS = 0;
class ExerciseError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
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
const requireOpen = () => { if (!window().open)
    throw new ExerciseError('The profile update exercise is not open right now.', 403); };
const handler = (fn) => (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        return yield fn(req, res);
    }
    catch (e) {
        if (e instanceof ExerciseError)
            return res.status(e.status).json({ message: e.message });
        if ((e === null || e === void 0 ? void 0 : e.name) === 'SmsError')
            return res.status(400).json({ message: 'Enter a valid phone number, e.g. 0244123456.' });
        if ((e === null || e === void 0 ? void 0 : e.code) === 'P2002')
            return res.status(409).json({ message: 'That index number already belongs to another student.' });
        console.error('Profile exercise:', e);
        return res.status(500).json({ message: 'Your request could not be completed. Please try again.' });
    }
});
// Partial reveals: enough for a student to recognise their own record.
const maskPhone = (v) => (v && v.length >= 7 ? `${v.slice(0, 3)}****${v.slice(-3)}` : null);
const maskEmail = (v) => {
    if (!v || !v.includes('@'))
        return null;
    const [user, domain] = v.split('@');
    return `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
};
const maskId = (v) => (v && v.length > 4 ? `${v.slice(0, 2)}${'*'.repeat(v.length - 4)}${v.slice(-2)}` : v || null);
const fullName = (s) => [s.fname, s.mname, s.lname].filter(Boolean).join(' ');
// Only students still on roll take part.
const ACTIVE = { completeStatus: false, graduateStatus: false };
const SEARCH_LIMIT = 8;
const NAME = /^[\p{L}][\p{L}' .-]*$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDEX = /^\d{10}$/;
function nameField(value, label, max, required) {
    const v = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
    if (!v) {
        if (required)
            throw new ExerciseError(`${label} is required.`);
        return null;
    }
    if (v.length > max || !NAME.test(v))
        throw new ExerciseError(`${label} may only contain letters, spaces, hyphens and apostrophes.`);
    return v;
}
function activeStudent(id) {
    return __awaiter(this, void 0, void 0, function* () {
        const st = yield db.student.findFirst({ where: Object.assign({ id }, ACTIVE), select: { id: true, fname: true, mname: true, lname: true, dob: true, phone: true, email: true, indexno: true, semesterNum: true, program: { select: { shortName: true, longName: true } } } });
        if (!st)
            throw new ExerciseError('Record not found. Search again.', 404);
        return st;
    });
}
class ProfileExerciseController {
    constructor() {
        this.status = handler((_req, res) => __awaiter(this, void 0, void 0, function* () { return res.json(window()); }));
        this.search = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            requireOpen();
            const q = typeof req.query.q === 'string' ? req.query.q.trim().replace(/\s+/g, ' ').slice(0, 100) : '';
            if (q.length < 3)
                throw new ExerciseError('Enter at least 3 characters: your student ID, index number, phone number or name.');
            const or = [{ id: q }, { indexno: q }];
            const digits = q.replace(/\D/g, '');
            if (digits.length >= 9 && digits.length === q.replace(/[\s+()-]/g, '').length)
                or.push({ phone: { endsWith: digits.slice(-9) } });
            // Name search: every word must match one of the names, and at least one
            // word must be 3+ letters so a single initial can't list the whole school.
            const words = q.split(' ').filter((w) => /\p{L}/u.test(w));
            if (words.length && words.some((w) => w.length >= 3)) {
                or.push({ AND: words.map((w) => ({ OR: [{ fname: { contains: w } }, { mname: { contains: w } }, { lname: { contains: w } }] })) });
            }
            const rows = yield db.student.findMany({ where: Object.assign(Object.assign({}, ACTIVE), { OR: or }), select: { id: true, fname: true, mname: true, lname: true, phone: true, semesterNum: true, program: { select: { shortName: true, longName: true } } }, orderBy: [{ lname: 'asc' }, { fname: 'asc' }], take: SEARCH_LIMIT + 1 });
            return res.json({
                results: rows.slice(0, SEARCH_LIMIT).map((s) => {
                    var _a, _b;
                    return ({
                        id: s.id, idHint: maskId(s.id), name: fullName(s), program: ((_a = s.program) === null || _a === void 0 ? void 0 : _a.shortName) || ((_b = s.program) === null || _b === void 0 ? void 0 : _b.longName) || null,
                        year: s.semesterNum ? Math.ceil(s.semesterNum / 2) : null, phoneHint: maskPhone(s.phone),
                    });
                }),
                more: rows.length > SEARCH_LIMIT,
            });
        }));
        this.fetch = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            var _a;
            requireOpen();
            const st = yield activeStudent(String(req.params.id));
            return res.json({
                id: st.id, fname: st.fname, mname: st.mname, lname: st.lname,
                program: ((_a = st.program) === null || _a === void 0 ? void 0 : _a.longName) || null, year: st.semesterNum ? Math.ceil(st.semesterNum / 2) : null,
                indexno: st.indexno, indexLocked: !!st.indexno,
                phoneHint: maskPhone(st.phone), emailHint: maskEmail(st.email), dobYear: st.dob ? moment_1.default.utc(st.dob).format('YYYY') : null,
            });
        }));
        this.update = handler((req, res) => __awaiter(this, void 0, void 0, function* () {
            requireOpen();
            const id = String(req.params.id);
            const body = req.body || {};
            const next = {
                fname: nameField(body.fname, 'First name', 255, true),
                mname: nameField(body.mname, 'Middle name', 350, false),
                lname: nameField(body.lname, 'Last name', 255, true),
            };
            // Optional fields: left blank means "keep what's on record".
            if (typeof body.dob === 'string' && body.dob.trim()) {
                const ymd = body.dob.trim().slice(0, 10);
                const dob = new Date(`${ymd}T00:00:00.000Z`);
                const age = (0, moment_1.default)().diff(moment_1.default.utc(ymd), 'years');
                if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || isNaN(dob.getTime()) || age < 10 || age > 100)
                    throw new ExerciseError('Enter a valid date of birth.');
                next.dob = dob;
            }
            if (typeof body.phone === 'string' && body.phone.trim())
                next.phone = sms.normalizePhone(body.phone);
            if (typeof body.email === 'string' && body.email.trim()) {
                const email = body.email.trim().toLowerCase();
                if (email.length > 255 || !EMAIL.test(email))
                    throw new ExerciseError('Enter a valid email address.');
                next.email = email;
            }
            const indexno = typeof body.indexno === 'string' ? body.indexno.trim() : '';
            const result = yield db.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                var _a;
                yield tx.$queryRaw `SELECT id FROM ais_student WHERE id = ${id} FOR UPDATE`;
                const before = yield tx.student.findFirst({ where: Object.assign({ id }, ACTIVE), select: { id: true, fname: true, mname: true, lname: true, dob: true, phone: true, email: true, indexno: true } });
                if (!before)
                    throw new ExerciseError('Record not found. Search again.', 404);
                // Assessments, registrations and resits are keyed by index number, so
                // an assigned one is never changed here -- only a missing one is filled.
                if (indexno && !before.indexno) {
                    if (!INDEX.test(indexno))
                        throw new ExerciseError('Index number must be 10 digits.');
                    if (yield tx.student.findFirst({ where: { indexno }, select: { id: true } }))
                        throw new ExerciseError('That index number already belongs to another student. Contact the Registry.', 409);
                    next.indexno = indexno;
                }
                const changes = {};
                for (const [k, v] of Object.entries(next)) {
                    const from = (_a = before[k]) !== null && _a !== void 0 ? _a : null;
                    const same = v instanceof Date ? from && new Date(from).getTime() === v.getTime() : (from !== null && from !== void 0 ? from : null) === (v !== null && v !== void 0 ? v : null);
                    if (!same)
                        changes[k] = { from, to: v };
                }
                if (!Object.keys(changes).length)
                    return { before, changes };
                yield tx.student.update({ where: { id }, data: Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])) });
                yield tx.log.create({ data: { action: exports.EXERCISE_ACTION, user: 'public', student: id, meta: { changes, phoneChanged: !!changes.phone, ip: req.clientIp || req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) } } });
                return { before, changes };
            }));
            const changed = Object.keys(result.changes);
            // Tell the old number its record moved -- the cheapest tripwire when
            // there's no identity check. Best-effort.
            if (result.changes.phone && result.before.phone) {
                yield sms.safe(result.before.phone, `Your phone number on your college student record was changed to ${maskPhone(result.changes.phone.to)}. If you did not make this change, contact the Registry immediately.`);
            }
            return res.json({ changed, message: changed.length ? 'Your profile has been updated.' : 'No changes to save -- your record already has these details.' });
        }));
    }
}
exports.default = ProfileExerciseController;
