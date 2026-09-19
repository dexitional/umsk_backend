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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const moment_1 = __importDefault(require("moment"));
const client_1 = require("../prisma/client");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const helper_1 = require("../util/helper");
const paramStr_1 = require("../util/paramStr");
const sheetScope_1 = require("../util/sheetScope");
const resitScope_1 = require("../util/resitScope");
const ais = client_1.prisma;
// Exam Score Manager: exam scores are capped at 40 marks -- any upload or
// edit containing a row above this is rejected outright.
const EXAM_SCORE_MAX = 40;
// Carries which student record broke a batch commit (e.g. backlog approval)
// so callers can report the specific row instead of a generic 500.
class BacklogRecordError extends Error {
    constructor(indexno, reason) {
        super(`Record for student ${indexno || 'unknown'} failed: ${reason}`);
        this.indexno = indexno;
        this.reason = reason;
    }
}
const password_1 = require("../util/password");
const { customAlphabet } = require("nanoid");
const pwdgen = customAlphabet("1234567890abcdefghijklmnopqrstuvwzyx", 6);
// unlockPin is a VarChar(4) column (a short quick-access PIN, distinct from
// the full login password) — must stay 4 digits, not pwdgen's 6 characters.
const pin = customAlphabet("1234567890", 4);
const sms = require('../config/sms');
const ExcelJS = require('exceljs');
// Students who have no ais_activity_register row for this session — the
// same "unregistered" semantics as the loadDashboard stats block below,
// scoped to a single session instead of branching by MAIN/sub-stream tag.
// Plain function (not a class method) since AisController's methods are
// passed to Express as detached references (no `.bind`) — a `this.` call
// from inside another method would find `this` undefined at request time.
function unregisteredStudentsForSession(sessionId) {
    return __awaiter(this, void 0, void 0, function* () {
        const registered = yield ais.activityRegister.findMany({ where: { sessionId }, select: { indexno: true } });
        return ais.student.findMany({
            where: {
                completeStatus: false,
                deferStatus: false,
                phone: { not: null },
                indexno: { notIn: registered.map((r) => r.indexno).filter(Boolean) },
            },
            select: { indexno: true, phone: true },
        });
    });
}
// A program's department must be a genuine department-level unit (levelNum 2,
// ACADEMIC — see fetchDepartments/fetchFaculties for the same convention),
// not a faculty, a non-academic unit, or an arbitrary id. The frontend's
// department dropdown already only offers valid options, but postProgram/
// updateProgram had nothing stopping a direct request from connecting any
// unit id -- this is the server-side backstop.
function isValidDepartmentUnit(unitId) {
    return __awaiter(this, void 0, void 0, function* () {
        const unit = yield ais.unit.findFirst({ where: { id: unitId, levelNum: 2, type: 'ACADEMIC' }, select: { id: true } });
        return !!unit;
    });
}
// A student may have several outstanding resit courses tied to this
// session — dedupe by indexno so each student is reminded once, not once
// per course row.
function unresolvedResitStudentsForSession(trailSessionId) {
    return __awaiter(this, void 0, void 0, function* () {
        const rows = yield ais.resit.findMany({
            where: { trailSessionId, registeredAt: null, taken: false },
            include: { student: { select: { indexno: true, phone: true } } },
        });
        const uniqueStudents = new Map();
        rows.forEach((r) => {
            var _a, _b;
            if (((_a = r.student) === null || _a === void 0 ? void 0 : _a.phone) && ((_b = r.student) === null || _b === void 0 ? void 0 : _b.indexno))
                uniqueStudents.set(r.student.indexno, r.student.phone);
        });
        return uniqueStudents;
    });
}
class AisController {
    fetchTest(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const tag = '24010001';
                const resp = yield ais.election.findMany({
                    // where: { voterList: { array_contains: tag }},
                    where: { voterData: { path: '$[*].tag', array_contains: tag } },
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Reports */
    loadReport(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let { type, program, major, year, session, gsession, rsession, category } = req.body;
                let resp = { type };
                if (type == 'student_registration') {
                    let regs = yield ais.activityRegister.findMany({
                        where: Object.assign(Object.assign(Object.assign({ session: { default: true } }, program && ({ student: { programId: program } })), major && ({ student: { majorId: major } })), year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } })),
                        include: { student: { include: { program: true, major: true } }, session: true },
                        orderBy: [
                            { session: { createdAt: 'asc' } },
                            { student: { programId: 'asc' } },
                            { student: { majorId: 'asc' } },
                            { student: { semesterNum: 'asc' } },
                            { student: { lname: 'asc' } },
                        ]
                    });
                    if (regs.length) {
                        regs = regs.map((r) => {
                            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
                            return ({
                                'LAST NAME': (_b = (_a = r.student) === null || _a === void 0 ? void 0 : _a.lname) === null || _b === void 0 ? void 0 : _b.toUpperCase(),
                                'FIRST NAME': (_d = (_c = r.student) === null || _c === void 0 ? void 0 : _c.fname) === null || _d === void 0 ? void 0 : _d.toUpperCase(),
                                'MIDDLE NAME(S)': (_f = (_e = r.student) === null || _e === void 0 ? void 0 : _e.mname) === null || _f === void 0 ? void 0 : _f.toUpperCase(),
                                'INDEX NUMBER': (_g = r.student) === null || _g === void 0 ? void 0 : _g.indexno,
                                'STUDENT ID': (_h = r.student) === null || _h === void 0 ? void 0 : _h.id,
                                'GENDER': (_j = r.student) === null || _j === void 0 ? void 0 : _j.gender,
                                'YEAR': Math.ceil(r.semesterNum / 2),
                                'ACADEMIC SESSION': (_k = r.session) === null || _k === void 0 ? void 0 : _k.title,
                                'PROGRAM': (_m = (_l = r.student) === null || _l === void 0 ? void 0 : _l.program) === null || _m === void 0 ? void 0 : _m.shortName,
                                'MAJOR': (_p = (_o = r.student) === null || _o === void 0 ? void 0 : _o.major) === null || _p === void 0 ? void 0 : _p.shortName,
                                'COURSES': r.courses,
                                'REGISTRATION DATE': r.createdAt
                            });
                        });
                        resp = Object.assign(Object.assign({}, resp), { data: regs });
                    }
                }
                else if (type == 'student_deferment') {
                    let regs = yield ais.activityDefer.findMany({
                        where: Object.assign(Object.assign(Object.assign({}, program && ({ student: { programId: program } })), major && ({ student: { majorId: major } })), year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } })),
                        include: { student: { include: { program: true, major: true } } },
                        orderBy: [
                            { student: { programId: 'asc' } },
                            { student: { majorId: 'asc' } },
                            { student: { semesterNum: 'asc' } },
                            { student: { lname: 'asc' } },
                        ]
                    });
                    if (regs.length) {
                        regs = regs.map((r) => {
                            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
                            return ({
                                'LAST NAME': (_b = (_a = r.student) === null || _a === void 0 ? void 0 : _a.lname) === null || _b === void 0 ? void 0 : _b.toUpperCase(),
                                'FIRST NAME': (_d = (_c = r.student) === null || _c === void 0 ? void 0 : _c.fname) === null || _d === void 0 ? void 0 : _d.toUpperCase(),
                                'MIDDLE NAME(S)': (_f = (_e = r.student) === null || _e === void 0 ? void 0 : _e.mname) === null || _f === void 0 ? void 0 : _f.toUpperCase(),
                                'INDEX NUMBER': (_g = r.student) === null || _g === void 0 ? void 0 : _g.indexno,
                                'STUDENT ID': (_h = r.student) === null || _h === void 0 ? void 0 : _h.id,
                                'GENDER': (_j = r.student) === null || _j === void 0 ? void 0 : _j.gender,
                                'YEAR': Math.ceil(r.semesterNum / 2),
                                'PROGRAM': (_l = (_k = r.student) === null || _k === void 0 ? void 0 : _k.program) === null || _l === void 0 ? void 0 : _l.shortName,
                                'MAJOR': (_o = (_m = r.student) === null || _m === void 0 ? void 0 : _m.major) === null || _o === void 0 ? void 0 : _o.shortName,
                                'DURATION': r.durationInYears,
                                'RESUMPTION DATE': r.end
                            });
                        });
                        resp = Object.assign(Object.assign({}, resp), { data: regs });
                    }
                }
                else if (type == 'student_debtor') {
                    let regs = yield ais.student.findMany({
                        where: Object.assign(Object.assign(Object.assign({ 
                            //completeStatus: false,
                            accountNet: { gt: 0 } }, program && ({ programId: program })), major && ({ majorId: major })), year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } })),
                        include: { program: true, major: true },
                        orderBy: [
                            { programId: 'asc' },
                            { majorId: 'asc' },
                            { semesterNum: 'asc' },
                            { lname: 'asc' },
                        ]
                    });
                    if (regs.length) {
                        regs = regs.map((r) => {
                            var _a, _b, _c, _d, _e;
                            return ({
                                'LAST NAME': (_a = r.lname) === null || _a === void 0 ? void 0 : _a.toUpperCase(),
                                'FIRST NAME': (_b = r.fname) === null || _b === void 0 ? void 0 : _b.toUpperCase(),
                                'MIDDLE NAME(S)': (_c = r.mname) === null || _c === void 0 ? void 0 : _c.toUpperCase(),
                                'INDEX NUMBER': r.indexno,
                                'STUDENT ID': r.id,
                                'GENDER': r.gender,
                                'YEAR': Math.ceil(r.semesterNum / 2),
                                'PROGRAM': (_d = r.program) === null || _d === void 0 ? void 0 : _d.shortName,
                                'MAJOR': (_e = r.major) === null || _e === void 0 ? void 0 : _e.shortName,
                                'STUDENT ACCOUNT NET': r.accountNet,
                            });
                        });
                        resp = Object.assign(Object.assign({}, resp), { data: regs });
                    }
                }
                else if (type == 'student_profile') {
                    let regs = yield ais.student.findMany({
                        where: Object.assign(Object.assign(Object.assign({ completeStatus: false }, program && ({ programId: program })), major && ({ majorId: major })), year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } })),
                        include: { program: true, major: true },
                        orderBy: [
                            { programId: 'desc' },
                            { majorId: 'asc' },
                            { semesterNum: 'asc' },
                            { lname: 'asc' },
                        ]
                    });
                    if (regs.length) {
                        regs = regs.map((r) => {
                            var _a, _b, _c, _d, _e;
                            return ({
                                'LAST NAME': (_a = r.lname) === null || _a === void 0 ? void 0 : _a.toUpperCase(),
                                'FIRST NAME': (_b = r.fname) === null || _b === void 0 ? void 0 : _b.toUpperCase(),
                                'MIDDLE NAME(S)': (_c = r.mname) === null || _c === void 0 ? void 0 : _c.toUpperCase(),
                                'INDEX NUMBER': r.indexno,
                                'STUDENT ID': r.id,
                                'GENDER': r.gender,
                                'YEAR': Math.ceil(r.semesterNum / 2),
                                'PROGRAM': (_d = r.program) === null || _d === void 0 ? void 0 : _d.shortName,
                                'MAJOR': (_e = r.major) === null || _e === void 0 ? void 0 : _e.shortName,
                                'STATUS': r.deferStatus == 1 ? 'DEFERRED' : 'ACTIVE',
                            });
                        });
                        resp = Object.assign(Object.assign({}, resp), { data: regs });
                    }
                }
                else if (type == 'exam_eligible') {
                    let regs = yield ais.student.findMany({
                        where: {
                            OR: [
                                { accountNet: { lte: 0 } },
                                { flagPardon: true },
                            ],
                            AND: [
                                { completeStatus: false },
                                Object.assign({}, program && ({ programId: program })),
                                Object.assign({}, major && ({ majorId: major })),
                                Object.assign({}, year && ({ semesterNum: { in: [(Number(year) * 2), (Number(year) * 2) - 1] } })),
                            ],
                        },
                        include: { program: true, major: true },
                        orderBy: [
                            { programId: 'desc' },
                            { majorId: 'asc' },
                            { semesterNum: 'asc' },
                            { lname: 'asc' },
                        ]
                    });
                    if (regs.length) {
                        regs = regs.map((r) => {
                            var _a, _b, _c, _d, _e;
                            return ({
                                'LAST NAME': (_a = r.lname) === null || _a === void 0 ? void 0 : _a.toUpperCase(),
                                'FIRST NAME': (_b = r.fname) === null || _b === void 0 ? void 0 : _b.toUpperCase(),
                                'MIDDLE NAME(S)': (_c = r.mname) === null || _c === void 0 ? void 0 : _c.toUpperCase(),
                                'INDEX NUMBER': r.indexno,
                                'STUDENT ID': r.id,
                                'GENDER': r.gender,
                                'YEAR': Math.ceil(r.semesterNum / 2),
                                'PROGRAM': (_d = r.program) === null || _d === void 0 ? void 0 : _d.shortName,
                                'MAJOR': (_e = r.major) === null || _e === void 0 ? void 0 : _e.shortName,
                                'STATUS': r.deferStatus == 1 ? 'DEFERRED' : 'ACTIVE',
                            });
                        });
                        resp = Object.assign(Object.assign({}, resp), { data: regs });
                    }
                }
                else if (type == 'resit') {
                    let regs = yield ais.resit.findMany({
                        where: {
                            OR: [
                                Object.assign({}, session && ({ session: { default: true } })),
                                Object.assign({}, rsession && ({ trailSession: { default: true } })),
                            ]
                        },
                        include: { course: true, student: { include: { program: true, major: true } } },
                        orderBy: [
                            { student: { programId: 'asc' } },
                            { student: { majorId: 'asc' } },
                            { student: { semesterNum: 'asc' } },
                            { student: { lname: 'asc' } },
                        ]
                    });
                    if (regs.length) {
                        regs = regs.map((r) => {
                            var _a, _b, _c, _d, _e, _f, _g, _h;
                            return ({
                                'LAST NAME': (_a = r.student.lname) === null || _a === void 0 ? void 0 : _a.toUpperCase(),
                                'FIRST NAME': (_b = r.student.fname) === null || _b === void 0 ? void 0 : _b.toUpperCase(),
                                'MIDDLE NAME(S)': (_c = r.student.mname) === null || _c === void 0 ? void 0 : _c.toUpperCase(),
                                'INDEX NUMBER': (_d = r.student) === null || _d === void 0 ? void 0 : _d.indexno,
                                'STUDENT ID': (_e = r.student) === null || _e === void 0 ? void 0 : _e.id,
                                'GENDER': r.student.gender,
                                'YEAR': Math.ceil(r.student.semesterNum / 2),
                                'PROGRAM': (_f = r.student.program) === null || _f === void 0 ? void 0 : _f.shortName,
                                'COURSE': `${(_g = r.course) === null || _g === void 0 ? void 0 : _g.title} - ${(_h = r.course) === null || _h === void 0 ? void 0 : _h.id}`,
                                'REGISTRATION DATE': r.registeredAt ? 'YES' : 'NO',
                                'PAYMENT STATUS': r.paid ? 'YES' : 'NO',
                            });
                        });
                        resp = Object.assign(Object.assign({}, resp), { data: regs });
                    }
                }
                else if (type == 'graduate_list') {
                    let regs = yield ais.graduate.findMany({
                        where: Object.assign({}, gsession && ({ graduateSession: { default: true } })),
                        include: { graduateSession: true, student: { include: { program: true, major: true } } },
                        orderBy: [
                            { student: { programId: 'asc' } },
                            { student: { majorId: 'asc' } },
                            { student: { semesterNum: 'asc' } },
                            { student: { lname: 'asc' } },
                        ]
                    });
                    if (regs.length) {
                        regs = regs.map((r) => {
                            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                            return ({
                                'LAST NAME': (_a = r.student.lname) === null || _a === void 0 ? void 0 : _a.toUpperCase(),
                                'FIRST NAME': (_b = r.student.fname) === null || _b === void 0 ? void 0 : _b.toUpperCase(),
                                'MIDDLE NAME(S)': (_c = r.student.mname) === null || _c === void 0 ? void 0 : _c.toUpperCase(),
                                'INDEX NUMBER': (_d = r.student) === null || _d === void 0 ? void 0 : _d.indexno,
                                'STUDENT ID': (_e = r.student) === null || _e === void 0 ? void 0 : _e.id,
                                'GENDER': r.student.gender,
                                'PROGRAM': (_f = r.student.program) === null || _f === void 0 ? void 0 : _f.shortName,
                                'MAJOR': (_g = r.student.major) === null || _g === void 0 ? void 0 : _g.shortName,
                                'SESSION': (_j = (_h = r.graduateSession) === null || _h === void 0 ? void 0 : _h.title) === null || _j === void 0 ? void 0 : _j.toUpperCase(),
                                'CGPA': r.cgpa,
                                'CLASS': r.class,
                            });
                        });
                        resp = Object.assign(Object.assign({}, resp), { data: regs });
                    }
                }
                else if (type == 'staff') {
                    let regs = yield ais.staff.findMany({
                        where: Object.assign({}, category && ({ unit: { type: category } })),
                        include: { job: true, unit: true },
                        orderBy: [
                            { staffNo: 'asc' },
                        ]
                    });
                    if (regs.length) {
                        regs = regs.map((r) => {
                            var _a, _b, _c, _d, _e, _f, _g;
                            return ({
                                'LAST NAME': (_a = r.lname) === null || _a === void 0 ? void 0 : _a.toUpperCase(),
                                'FIRST NAME': (_b = r.fname) === null || _b === void 0 ? void 0 : _b.toUpperCase(),
                                'MIDDLE NAME(S)': (_c = r.mname) === null || _c === void 0 ? void 0 : _c.toUpperCase(),
                                'STAFF NUMBER': r.staffNo,
                                'PHONE NUMBER': r.phone,
                                'EMAIL': r === null || r === void 0 ? void 0 : r.email,
                                'INSTITUTIONAL EMAIL': r.instituteEmail,
                                'UNIT': (_e = (_d = r.unit) === null || _d === void 0 ? void 0 : _d.title) === null || _e === void 0 ? void 0 : _e.toUpperCase(),
                                'DESIGNATION': (_g = (_f = r.job) === null || _f === void 0 ? void 0 : _f.title) === null || _g === void 0 ? void 0 : _g.toUpperCase(),
                                'STAFF STATUS': r.staffStatus,
                            });
                        });
                        resp = Object.assign(Object.assign({}, resp), { data: regs });
                    }
                }
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Dashboard & Statistics */
    loadDashboard(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Main Statistics
                // const students:any = await ais.student.findMany({ where: { default: true } }); // students
                // Academic Session Statistics
                const sessions = yield ais.session.findMany({ where: { default: true } }); // Sessions
                const academic = yield Promise.all(sessions.map((s) => __awaiter(this, void 0, void 0, function* () {
                    // Registered
                    const reg = yield ais.activityRegister.findMany({ where: { sessionId: s.id } });
                    // const unregister:any = await ais.activityRegister.findMany({ where: { sessionId: s.id, student: { gender: 'F' }} });
                    // No more MAIN/January-SUB stream split -- every active student.
                    const unreg = yield ais.$queryRaw `select id from ais_student s where completeStatus = 0 and deferStatus = 0 and indexno not in (select indexno from ais_activity_register where sessionId = ${s.id})`;
                    return ({
                        label: s.title,
                        register: reg === null || reg === void 0 ? void 0 : reg.length,
                        unregister: unreg === null || unreg === void 0 ? void 0 : unreg.length
                    });
                })));
                // Resit Session Statistics
                const rsession = yield ais.resitSession.findFirst({ where: { default: true } }); // Resit Sessions
                const reg_resit = yield ais.resit.count({ where: { resitSession: { default: true }, registeredAt: { not: null }, taken: false } }); // Registered Resits
                const all_resit = yield ais.resit.count({ where: { resitSessionId: null } }); // All Students Resits
                const cs_resit = yield ais.resit.groupBy({
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
                    label: rsession === null || rsession === void 0 ? void 0 : rsession.title,
                    register: reg_resit,
                    estimate: all_resit,
                    courses: (cs_resit === null || cs_resit === void 0 ? void 0 : cs_resit.length) || 0,
                };
                // Graduation Session Statistics
                const gsession = yield ais.graduateSession.findFirst({ where: { default: true } }); // Resit Sessions
                const graduand = yield ais.graduate.count({ where: { graduateSession: { default: true } } }); // Registered Resits
                const completed = yield ais.student.count({ where: { completeStatus: true, graduateStatus: false } }); // All Students Resits
                const graduation = {
                    label: gsession === null || gsession === void 0 ? void 0 : gsession.title,
                    graduand,
                    complete: completed,
                };
                // Student Statistics
                const mactive = yield ais.student.count({ where: { completeStatus: false, deferStatus: false, gender: 'M' } });
                const factive = yield ais.student.count({ where: { completeStatus: false, deferStatus: false, gender: 'F' } });
                const mdefer = yield ais.student.count({ where: { completeStatus: false, deferStatus: true, gender: 'M' } });
                const fdefer = yield ais.student.count({ where: { completeStatus: false, deferStatus: true, gender: 'F' } });
                const mcomplete = yield ais.student.count({ where: { completeStatus: true, deferStatus: false, gender: 'M' } });
                const fcomplete = yield ais.student.count({ where: { completeStatus: true, deferStatus: false, gender: 'F' } });
                const mgraduate = yield ais.student.count({ where: { completeStatus: true, deferStatus: false, graduateStatus: true, gender: 'M' } });
                const fgraduate = yield ais.student.count({ where: { completeStatus: true, deferStatus: false, graduateStatus: true, gender: 'F' } });
                // Department Statistics
                const depts = yield ais.unit.findMany({ where: { type: 'ACADEMIC', levelNum: 2 } });
                const department = yield Promise.all(depts.map((r) => __awaiter(this, void 0, void 0, function* () {
                    const programs = yield ais.program.count({ where: { unitId: r.id } });
                    const students = yield ais.student.count({ where: { program: { unitId: r.id }, completeStatus: false } });
                    const staff = yield ais.staff.count({ where: { unitId: r.id, status: true } });
                    return ({
                        label: r.title,
                        programs,
                        students,
                        staff
                    });
                })));
                // Program Statistics
                const progs = yield ais.program.findMany();
                const program = yield Promise.all(progs.map((r) => __awaiter(this, void 0, void 0, function* () {
                    // // Applicant
                    // const m_applicant:any = await ais.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;
                    // const f_applicant:any = await ais.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;
                    const y1 = yield ais.student.count({ where: { programId: r.id, completeStatus: false, semesterNum: { in: [1, 2] } } });
                    const y2 = yield ais.student.count({ where: { programId: r.id, completeStatus: false, semesterNum: { in: [3, 4] } } });
                    const y3 = yield ais.student.count({ where: { programId: r.id, completeStatus: false, semesterNum: { in: [5, 6] } } });
                    const y4 = yield ais.student.count({ where: { programId: r.id, completeStatus: false, semesterNum: { in: [7, 8] } } });
                    return ({
                        label: r.code,
                        y1,
                        y2,
                        y3,
                        y4,
                    });
                })));
                let data = {
                    sessions: {
                        academic,
                        resit,
                        graduation
                    },
                    student: {
                        active: { f: factive, m: mactive },
                        defer: { f: fdefer, m: mdefer },
                        complete: { f: fcomplete, m: mcomplete },
                        graduate: { f: fgraduate, m: mgraduate }
                    },
                    department,
                    program,
                };
                if (data) {
                    res.status(200).json(data);
                }
                else {
                    res.status(204).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Session */
    fetchSessionList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.session.findMany({ where: { status: true }, orderBy: { createdAt: 'desc' } });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchSessions(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = { orderBy: { createdAt: 'desc' } };
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                                { id: { contains: keyword } },
                            ],
                        },
                        orderBy: { createdAt: 'desc' }
                    };
                const resp = yield ais.$transaction([
                    ais.session.count(Object.assign({}, (searchCondition))),
                    ais.session.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize) }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.session.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    activateSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { sessionId } = req.body;
                // Only one session can be the default at a time (no more per-tag
                // defaults now that MAIN/January-SUB stream is gone).
                const resx = yield ais.session.updateMany({ where: { NOT: { id: sessionId } }, data: { default: false } });
                const resp = yield ais.session.update({ where: { id: sessionId }, data: { default: true } });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchRegistrationReminderCount(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const session = yield ais.session.findUnique({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                if (!session)
                    return res.status(202).json({ message: `no record found` });
                const eligible = yield unregisteredStudentsForSession(session.id);
                res.status(200).json({ count: eligible.length, session: { title: session.title } });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    sendRegistrationReminder(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const session = yield ais.session.findUnique({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                if (!session)
                    return res.status(202).json({ message: `no record found` });
                const eligible = yield unregisteredStudentsForSession(session.id);
                const message = `Hi! Reminder: You have not yet registered for the ${session.title} semester. As a GTEC requirement, all students must register each semester or risk automatic deferment of their programme. Please register promptly.`;
                const sent = yield Promise.all(eligible.map((st) => __awaiter(this, void 0, void 0, function* () {
                    try {
                        const phone = st.phone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();
                        yield sms(phone, message);
                        return true;
                    }
                    catch (smsError) {
                        console.log('sendRegistrationReminder SMS send failed:', smsError === null || smsError === void 0 ? void 0 : smsError.message);
                        return false;
                    }
                })));
                const count = sent.filter(Boolean).length;
                yield ais.log.create({ data: { action: `SEND_REGISTRATION_REMINDER`, user: req === null || req === void 0 ? void 0 : req.userId, meta: { sessionId: session.id, count } } });
                res.status(200).json({ count: eligible.length, sent: count });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchResitReminderCount(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const uniqueStudents = yield unresolvedResitStudentsForSession((0, paramStr_1.paramStr)(req.params.id));
                res.status(200).json({ count: uniqueStudents.size });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    sendResitReminder(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const sessionId = (0, paramStr_1.paramStr)(req.params.id);
                const uniqueStudents = yield unresolvedResitStudentsForSession(sessionId);
                const message = `Hi! Reminder: You have an outstanding resit course that has not been registered or paid for. As a GTEC requirement, please complete your resit registration and payment promptly to avoid automatic deferment of your programme.`;
                const sent = yield Promise.all(Array.from(uniqueStudents.values()).map((rawPhone) => __awaiter(this, void 0, void 0, function* () {
                    try {
                        const phone = rawPhone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();
                        yield sms(phone, message);
                        return true;
                    }
                    catch (smsError) {
                        console.log('sendResitReminder SMS send failed:', smsError === null || smsError === void 0 ? void 0 : smsError.message);
                        return false;
                    }
                })));
                const count = sent.filter(Boolean).length;
                yield ais.log.create({ data: { action: `SEND_RESIT_REMINDER`, user: req === null || req === void 0 ? void 0 : req.userId, meta: { sessionId, count } } });
                res.status(200).json({ count: uniqueStudents.size, sent: count });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.session.create({ data: Object.assign({}, req.body) });
                if (resp) {
                    // Log Login Response
                    yield ais.log.create({ data: { action: `CALENDAR_CREATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: req.body } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.session.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    // Log Login Response
                    yield ais.log.create({ data: { action: `CALENDAR_UPDATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: req.body } });
                    //  Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.session.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    // Log Login Response
                    yield ais.log.create({ data: { action: `CALENDAR_DELETED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: req.body } });
                    // Return response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Student */
    fetchStudents(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
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
                    };
                const resp = yield ais.$transaction([
                    ais.student.count(Object.assign({}, (searchCondition))),
                    ais.student.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            title: { select: { label: true } },
                            country: { select: { longName: true } },
                            region: { select: { title: true } },
                            religion: { select: { title: true } },
                            disability: { select: { title: true } },
                            program: {
                                select: {
                                    longName: true,
                                    department: { select: { title: true } }
                                }
                            },
                        }, orderBy: [
                            { completeStatus: 'asc' },
                            { semesterNum: 'asc' }
                        ] }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.student.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    include: {
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
                                department: { select: { title: true } }
                            }
                        },
                        major: {
                            select: {
                                longName: true,
                                shortName: true,
                            }
                        },
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchStudentTranscript(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            try {
                const st = yield ais.student.findFirst({
                    where: {
                        OR: [
                            {
                                AND: [
                                    { indexno: { not: null } },
                                    { id: (0, paramStr_1.paramStr)(req.params.id) }
                                ]
                            },
                            { indexno: (0, paramStr_1.paramStr)(req.params.id) }
                        ]
                    },
                    select: { indexno: true, fname: true, mname: true, lname: true, id: true, gender: true, entryDate: true, exitDate: true, program: { select: { longName: true, shortName: true, stype: true, category: true } } }
                });
                if (!st)
                    throw ("No index number generated");
                const resp = yield ais.assessment.findMany({
                    where: {
                        indexno: st === null || st === void 0 ? void 0 : st.indexno,
                    },
                    include: {
                        //student: true,
                        //  student: { include: { program: true } },
                        //  student: { select: { indexno: true, fname: true, mname: true, lname: true, id: true, gender: true, entryDate: true, exitDate: true, program: { select: { longName: true, shortName: true, stype: true, category: true } } } },
                        scheme: { select: { gradeMeta: true, classMeta: true } },
                        session: { select: { title: true, year: true, semester: true } },
                        course: { select: { title: true } },
                    },
                    orderBy: { session: { createdAt: 'asc' } }
                });
                if (resp) {
                    // Class Awards
                    var mdata = new Map();
                    for (const sv of resp) {
                        const index = (_b = (_a = sv === null || sv === void 0 ? void 0 : sv.session) === null || _a === void 0 ? void 0 : _a.title) !== null && _b !== void 0 ? _b : 'none';
                        const grades = (_c = sv.scheme) === null || _c === void 0 ? void 0 : _c.gradeMeta;
                        const classes = (_d = sv.scheme) === null || _d === void 0 ? void 0 : _d.classMeta;
                        const zd = Object.assign(Object.assign({}, sv), { student: st, grade: yield (0, helper_1.getGrade)(sv.totalScore, grades), gradepoint: yield (0, helper_1.getGradePoint)(sv.totalScore, grades), classes });
                        // Data By Courses
                        if (mdata.has(index)) {
                            mdata.set(index, [...mdata.get(index), Object.assign({}, zd)]);
                        }
                        else {
                            mdata.set(index, [Object.assign({}, zd)]);
                        }
                    }
                    // Single source of truth for GPA/CGPA — computed here once so
                    // every page that renders a transcript (student self-service,
                    // admin view, ...) shows the same numbers instead of each
                    // re-deriving its own (which had drifted: one page filtered by
                    // published status, the other didn't). Only rows that are
                    // published (status===true) AND actually graded (totalScore not
                    // null — excludes "I" Incompletes) count toward attempted
                    // credit; an Incomplete contributes to neither the numerator nor
                    // the denominator until it's resolved to a real score.
                    let runningCredit = 0;
                    let runningGradepoint = 0;
                    const groups = Array.from(mdata).map(([title, rows]) => {
                        const gradedRows = rows.filter((r) => r.status === true && r.totalScore != null);
                        const semCredit = gradedRows.reduce((sum, cur) => sum + cur.credit, 0);
                        const semGradepoint = gradedRows.reduce((sum, cur) => sum + cur.credit * cur.gradepoint, 0);
                        runningCredit += semCredit;
                        runningGradepoint += semGradepoint;
                        const meta = {
                            credit: semCredit,
                            gradepoint: semGradepoint,
                            gpa: semCredit ? +(semGradepoint / semCredit).toFixed(2) : null,
                            cgpa: runningCredit ? +(runningGradepoint / runningCredit).toFixed(2) : null,
                        };
                        return [title, rows, meta];
                    });
                    return res.status(200).json(groups);
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(202).json({ message: error.message });
            }
        });
    }
    // Self-service dashboard summary — the two pieces of a student's own
    // status that have no existing endpoint: outstanding resits, and any
    // late-registration fine already posted (or the configured amount they'd
    // risk). Registration deadline/registered-status and evaluation status
    // are already available from existing endpoints, so aren't duplicated
    // here.
    fetchStudentNoticeSummary(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const st = yield ais.student.findFirst({
                    where: {
                        OR: [
                            { AND: [{ indexno: { not: null } }, { id: (0, paramStr_1.paramStr)(req.params.id) }] },
                            { indexno: (0, paramStr_1.paramStr)(req.params.id) }
                        ]
                    },
                    select: { id: true, indexno: true, entryGroup: true }
                });
                if (!st)
                    return res.status(202).json({ message: `no record found` });
                const [resitRows, fineCharges, lateTranstype] = yield Promise.all([
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
                const configuredAmount = st.entryGroup == 'GH' ? lateTranstype === null || lateTranstype === void 0 ? void 0 : lateTranstype.amountInGhc : lateTranstype === null || lateTranstype === void 0 ? void 0 : lateTranstype.amountInUsd;
                return res.status(200).json({
                    resit: {
                        count: resitRows.length,
                        items: resitRows.map((r) => {
                            var _a, _b;
                            return ({
                                courseId: r.courseId,
                                courseTitle: (_a = r.course) === null || _a === void 0 ? void 0 : _a.title,
                                trailSessionTitle: (_b = r.trailSession) === null || _b === void 0 ? void 0 : _b.title,
                            });
                        }),
                    },
                    fine: {
                        charged: !!latestFine,
                        amount: (_a = latestFine === null || latestFine === void 0 ? void 0 : latestFine.amount) !== null && _a !== void 0 ? _a : null,
                        currency: (_b = latestFine === null || latestFine === void 0 ? void 0 : latestFine.currency) !== null && _b !== void 0 ? _b : null,
                        configuredAmount: configuredAmount !== null && configuredAmount !== void 0 ? configuredAmount : null,
                        configuredCurrency: st.entryGroup == 'GH' ? 'GHC' : 'USD',
                    },
                });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchStudentTranscripts(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const cacheKey = `transcripts:${JSON.stringify(req.body.key)}`;
                const result = yield (0, helper_1.getOrSetCache)(cacheKey, () => __awaiter(this, void 0, void 0, function* () {
                    var _a, _b;
                    const resp = yield ais.broadsheet.findMany({
                        where: {
                            indexno: { in: (_a = req.body) === null || _a === void 0 ? void 0 : _a.data },
                        },
                        orderBy: { sessionCreatedAt: 'asc' }
                    });
                    if (resp === null || resp === void 0 ? void 0 : resp.length) {
                        var mdata = new Map();
                        for (const sv of resp) {
                            const index = sv.indexno;
                            if (mdata.has(index)) {
                                mdata.set(index, [...mdata.get(index), sv]);
                            }
                            else {
                                mdata.set(index, [sv]);
                            }
                        }
                        const vdata = yield Promise.all((_b = Array.from(mdata)) === null || _b === void 0 ? void 0 : _b.map((st) => __awaiter(this, void 0, void 0, function* () {
                            var _a;
                            let [indexno, tdata] = st;
                            let sdata = new Map();
                            for (const sv of tdata) {
                                const cindex = (_a = sv.title) !== null && _a !== void 0 ? _a : 'none';
                                const grades = sv.gradeMeta;
                                const classes = sv.classMeta;
                                const zd = Object.assign(Object.assign({}, sv), { grade: yield (0, helper_1.getGrade)(sv.totalScore, grades), gradepoint: yield (0, helper_1.getGradePoint)(sv.totalScore, grades), classes });
                                // Data By Courses
                                if (sdata.has(cindex)) {
                                    sdata.set(cindex, [...sdata.get(cindex), Object.assign({}, zd)]);
                                }
                                else {
                                    sdata.set(cindex, [Object.assign({}, zd)]);
                                }
                            }
                            return [indexno, Array.from(sdata)];
                        })));
                        return vdata;
                    }
                }));
                if (result) {
                    // Return Response
                    return res.status(200).json(result);
                }
                else {
                    return res.status(202).json({ message: `No records` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(202).json({ message: error.message });
            }
        });
    }
    fetchStudentFinance(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.studentAccount.findMany({
                    where: { studentId: (0, paramStr_1.paramStr)(req.params.id) },
                    include: {
                        student: { select: { fname: true, mname: true, indexno: true, program: { select: { longName: true } } } },
                        bill: { select: { narrative: true } },
                        charge: { select: { title: true } },
                        session: { select: { title: true } },
                        transaction: { select: { transtag: true } },
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchStudentActivity(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.student.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    include: {
                        country: true,
                        program: {
                            select: {
                                longName: true
                            }
                        },
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    stageStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const { studentId } = req.body;
                const password = pwdgen();
                const isUser = yield ais.user.findFirst({ where: { tag: studentId } });
                if (isUser)
                    throw ("Student Portal Account Exists!");
                const ssoData = { tag: studentId, username: studentId, password: (0, password_1.hashPassword)(password), unlockPin: pin() }; // AKATSICO only
                //   const ssoData = { tag:studentId, username:studentId, password:sha1(password), unlockPin: password }  // MLK & Others
                // Populate SSO Account
                const resp = yield ais.user.create({
                    data: Object.assign(Object.assign({}, ssoData), { group: { connect: { id: 1 } } }),
                });
                if (resp) {
                    // Send Credentials By SMS — isolated in its own try/catch (matching
                    // resetStudent below): a gateway hiccup shouldn't turn an
                    // already-successful account creation into a 500 with no visibility
                    // into what actually failed.
                    const st = yield ais.student.findFirst({ where: { id: studentId } });
                    if (st === null || st === void 0 ? void 0 : st.phone) {
                        try {
                            yield sms(st.phone, `Hi! Your new credentials is username: ${(_a = st === null || st === void 0 ? void 0 : st.instituteEmail) !== null && _a !== void 0 ? _a : studentId}, password: ${password}`);
                        }
                        catch (smsError) {
                            console.log('stageStudent SMS send failed:', smsError === null || smsError === void 0 ? void 0 : smsError.message);
                        }
                    }
                    // Log Login Response
                    yield ais.log.create({ data: { action: `STUDENT_ACCOUNT_STAGED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: ssoData } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    resetStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const { studentId } = req.body;
                const password = pwdgen();
                const resp = yield ais.user.updateMany({
                    where: { tag: studentId },
                    // data: { password: sha1(password), unlockPin: password },
                    data: { password: (0, password_1.hashPassword)(password) },
                    include: true
                });
                if (resp === null || resp === void 0 ? void 0 : resp.count) {
                    // Send Password By SMS — normalized the same way forgetPassword
                    // does (authController.ts), and isolated in its own try/catch:
                    // a gateway hiccup shouldn't turn an already-successful password
                    // change into a 500 with no visibility into what actually failed.
                    const st = yield ais.student.findFirst({ where: { id: studentId } });
                    if (st === null || st === void 0 ? void 0 : st.phone) {
                        const phone = st.phone.replaceAll("+233", "0").replaceAll(" ", "").replaceAll("-", "").replaceAll("(", "").replaceAll(")", "").split("/")[0].trim();
                        try {
                            yield sms(phone, `Hi! Your new credentials is username: ${(_a = st === null || st === void 0 ? void 0 : st.instituteEmail) !== null && _a !== void 0 ? _a : studentId}, password: ${password}`);
                        }
                        catch (smsError) {
                            console.log('resetStudent SMS send failed:', smsError === null || smsError === void 0 ? void 0 : smsError.message);
                        }
                    }
                    // Log Login Response
                    yield ais.log.create({ data: { action: `STUDENT_ACCOUNT_RESET`, user: req === null || req === void 0 ? void 0 : req.userId, meta: { password: (0, password_1.hashPassword)(password) } } });
                    // Return Password
                    res.status(200).json({ password });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    changePhoto(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { studentId } = req.body;
                const password = pwdgen();
                const resp = yield ais.user.updateMany({
                    where: { tag: studentId },
                    data: { password: (0, password_1.hashPassword)(password) },
                });
                if (resp) {
                    res.status(200).json({ password });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    generateIndex(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const { studentId } = req.body;
                let indexno;
                const student = yield ais.student.findUnique({
                    where: { id: studentId },
                    include: { program: { select: { prefix: true } } },
                });
                if (student === null || student === void 0 ? void 0 : student.indexno)
                    throw ("Index number exists for student!");
                // const students = await ais.$queryRaw`select * from ais_student where date_format(entryDate,'%m%y') = ${moment(student?.entryDate).format("MMYYYY")} and programId = ${student?.programId}`;
                const students = yield ais.$queryRaw `select * from ais_student where date_format(entryDate,'%m%y') = ${(0, moment_1.default)(student === null || student === void 0 ? void 0 : student.entryDate).format("MMYY")} and programId = ${student === null || student === void 0 ? void 0 : student.programId} and indexno is not null and (semesterNum = entrySemesterNum)`;
                // console.log("index student: ", students,moment(student?.entryDate).format("MMYY"));
                // AKATSICO INDEX NUMBER GENERATION
                let studentCount = (students === null || students === void 0 ? void 0 : students.length) + 1;
                let loop = true;
                while (loop) {
                    // Compute Index Number
                    const count = studentCount.toString().length == 1 ? `000${studentCount}` : studentCount.toString().length == 2 ? `00${studentCount}` : studentCount.toString().length == 3 ? `0${studentCount}` : studentCount;
                    indexno = `${(_a = student === null || student === void 0 ? void 0 : student.program) === null || _a === void 0 ? void 0 : _a.prefix}${(0, moment_1.default)((student === null || student === void 0 ? void 0 : student.entryDate) || new Date()).format("MMYY")}${count}`;
                    // console.log(student?.program?.prefix, moment(student?.entryDate || new Date()).format("MMYY"), studentCount, indexno)
                    // Check If Index Number Exists
                    const ck = yield ais.student.findFirst({ where: { indexno } });
                    if (ck) {
                        studentCount = studentCount + 1;
                    }
                    else {
                        loop = false;
                    }
                }
                // MLK INDEX NUMBER GENERATION
                // const count = student?.progCount?.toString().length == 1 ? `00${student?.progCount}`  : student?.progCount?.toString().length == 2 ? `0${student?.progCount}` : student?.progCount;
                // indexno = `${student?.program?.prefix}/${moment(student?.entryDate || new Date()).format("YY")}/${count}`
                const resp = yield ais.student.update({
                    where: { id: studentId },
                    data: { indexno },
                });
                if (resp) {
                    // Send Notfication
                    const msg = `Hi ${student.fname}! Your AKATSICO Index number has been generated: ${indexno}, Thank you!`;
                    yield sms(student === null || student === void 0 ? void 0 : student.phone, msg);
                    // Log Login Response
                    yield ais.log.create({ data: { action: `INDEX_NUMBER_GENERATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: { indexno } } });
                    // Return Password
                    res.status(200).json({ indexno });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    generateEmail(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                let count = 1;
                let isNew = true;
                const { studentId } = req.body;
                const st = yield ais.student.findFirst({ where: { id: studentId } });
                if (st === null || st === void 0 ? void 0 : st.instituteEmail) {
                    yield ais.user.updateMany({ where: { tag: studentId }, data: { username: st === null || st === void 0 ? void 0 : st.instituteEmail } });
                    throw ("mail already exists !");
                }
                let username = `${(_a = st === null || st === void 0 ? void 0 : st.fname) === null || _a === void 0 ? void 0 : _a.replaceAll(' ', '')}.${st === null || st === void 0 ? void 0 : st.lname}`.toLowerCase();
                while (isNew) {
                    const ck = yield ais.student.findFirst({ where: { instituteEmail: { startsWith: `${username}${count > 1 ? count : ''}` } } });
                    if (ck)
                        count = count + 1;
                    else
                        isNew = false;
                }
                // Update Student Email
                const instituteEmail = `${username}@${process.env.UMS_MAIL}`;
                const resp = yield ais.student.update({ where: { id: studentId }, data: { instituteEmail } });
                if (resp) {
                    // Update SSO User
                    yield ais.user.updateMany({ where: { tag: studentId }, data: { username: instituteEmail } });
                    // Log Login Response
                    yield ais.log.create({ data: { action: `STUDENT_EMAIL_GENERATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: { instituteEmail } } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    // Dedicated pardon action (route-gated to student::admin/student::finance,
    // see STUDENT_FINANCE_ROLES in aisRoute.ts) — kept separate from the
    // generic updateStudent PATCH so this specific, finance-sensitive action
    // gets its own audit log entry and role enforcement at the backend, not
    // just the Finance Pardon button's frontend gating.
    pardonStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { studentId } = req.body;
                const resp = yield ais.student.update({
                    where: { id: studentId },
                    data: { flagPardon: true },
                });
                if (resp) {
                    yield ais.log.create({ data: { action: `STUDENT_PARDON_ACTIVATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: { studentId } } });
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    postStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { titleId, programId, countryId, regionId, religionId, disabilityId, majorId } = req.body;
                delete req.body.titleId;
                delete req.body.programId;
                delete req.body.countryId;
                delete req.body.regionId;
                delete req.body.religionId;
                delete req.body.disabilityId;
                delete req.body.majorId;
                //if (req.body.entryDate) req.body.entryDate = moment(req.body.entryDate).toDate;
                req.body.indexno = !req.body.indexno ? null : req.body.indexno;
                req.body.completeType = !req.body.completeType ? null : req.body.completeType;
                //req.body.entryDate  = !req.body.entryDate ? null : moment(req.body.entryDate).toDate();
                if (req.body.entryDate)
                    req.body.entryDate = new Date(req.body.entryDate);
                if (req.body.dob)
                    req.body.dob = new Date(req.body.dob);
                const resp = yield ais.student.create({
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), programId && ({ program: { connect: { id: programId } } })), titleId && ({ title: { connect: { id: titleId } } })), countryId && ({ country: { connect: { id: countryId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), disabilityId && ({ disability: { connect: { id: disabilityId } } })), majorId && majorId == 'NONE' && ({ major: { disconnect: true } })), majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }))
                });
                if (resp) {
                    // Log Login Response
                    yield ais.log.create({
                        data: {
                            action: `STUDENT_CREATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), programId && ({ program: { connect: { id: programId } } })), titleId && ({ title: { connect: { id: titleId } } })), countryId && ({ country: { connect: { id: countryId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), disabilityId && ({ disability: { connect: { id: disabilityId } } })), majorId && majorId == 'NONE' && ({ major: { disconnect: true } })), majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }))
                        }
                    });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // Bulk-create students from an uploaded sheet. `ApplicantID` maps
    // directly onto student.id (the same free-typed "Student Number" field
    // the single-create form uses) -- there is no separate id auto-generation
    // for students, unlike indexno. `yearGroup` (1 = Year 1, 2 = Year 2, ...)
    // maps to the first-semester value of that year on student.semesterNum,
    // matching the single-create form's "Program Year and Semester" options
    // (YEAR 1 SEM1 = 1, YEAR 2 SEM1 = 3, YEAR 3 SEM1 = 5, ...).
    uploadStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const rows = req.body;
                if (!(rows === null || rows === void 0 ? void 0 : rows.length))
                    return res.status(202).json({ message: `no records found` });
                const missingId = [];
                const duplicateInSheet = [];
                const seenIds = new Set();
                const students = [];
                rows.forEach((row, i) => {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
                    const id = (_b = (_a = row.ApplicantID) === null || _a === void 0 ? void 0 : _a.toString()) === null || _b === void 0 ? void 0 : _b.trim();
                    if (!id) {
                        missingId.push(`row ${i + 1}`);
                        return;
                    }
                    if (seenIds.has(id)) {
                        duplicateInSheet.push(id);
                        return;
                    }
                    seenIds.add(id);
                    const yearGroup = row.yearGroup != null && row.yearGroup !== '' ? Number(row.yearGroup) : null;
                    const semesterNum = yearGroup ? (yearGroup - 1) * 2 + 1 : null;
                    students.push({
                        id,
                        fname: ((_d = (_c = row.fname) === null || _c === void 0 ? void 0 : _c.toString()) === null || _d === void 0 ? void 0 : _d.trim()) || null,
                        mname: ((_f = (_e = row.mname) === null || _e === void 0 ? void 0 : _e.toString()) === null || _f === void 0 ? void 0 : _f.trim()) || null,
                        lname: ((_h = (_g = row.lname) === null || _g === void 0 ? void 0 : _g.toString()) === null || _h === void 0 ? void 0 : _h.trim()) || null,
                        dob: row.dob ? new Date(row.dob) : null,
                        semesterNum,
                        gender: ((_k = (_j = row.gender) === null || _j === void 0 ? void 0 : _j.toString()) === null || _k === void 0 ? void 0 : _k.trim()) || null,
                        email: ((_m = (_l = row.email) === null || _l === void 0 ? void 0 : _l.toString()) === null || _m === void 0 ? void 0 : _m.trim()) || null,
                        phone: ((_p = (_o = row.phone) === null || _o === void 0 ? void 0 : _o.toString()) === null || _p === void 0 ? void 0 : _p.trim()) || null,
                        address: ((_r = (_q = row.address) === null || _q === void 0 ? void 0 : _q.toString()) === null || _r === void 0 ? void 0 : _r.trim()) || null,
                        hometown: ((_t = (_s = row.hometown) === null || _s === void 0 ? void 0 : _s.toString()) === null || _t === void 0 ? void 0 : _t.trim()) || null,
                        programId: ((_v = (_u = row.programId) === null || _u === void 0 ? void 0 : _u.toString()) === null || _v === void 0 ? void 0 : _v.trim()) || null,
                        majorId: ((_x = (_w = row.majorId) === null || _w === void 0 ? void 0 : _w.toString()) === null || _x === void 0 ? void 0 : _x.trim()) || null,
                    });
                });
                if (missingId.length || duplicateInSheet.length) {
                    return res.status(400).json({
                        message: `Upload rejected: ${missingId.length ? `ApplicantID is missing for ${missingId.join(', ')}. ` : ''}${duplicateInSheet.length ? `Duplicate ApplicantID within the uploaded sheet: ${duplicateInSheet.join(', ')}.` : ''}`,
                        errors: [
                            ...missingId.map((r) => ({ id: r, reason: 'ApplicantID is required' })),
                            ...duplicateInSheet.map((id) => ({ id, reason: 'Duplicate ApplicantID within the uploaded sheet' })),
                        ],
                    });
                }
                const existing = yield ais.student.findMany({ where: { id: { in: students.map((s) => s.id) } }, select: { id: true } });
                if (existing.length) {
                    const ids = existing.map((s) => s.id);
                    return res.status(400).json({
                        message: `Upload rejected: ${ids.length} of ${students.length} Applicant ID(s) already exist: ${ids.join(', ')}.`,
                        failedCount: ids.length,
                        totalCount: students.length,
                        errors: ids.map((id) => ({ id, reason: 'ApplicantID already exists' })),
                    });
                }
                const createdBy = req.userId;
                // All-or-nothing so a bad row (e.g. an invalid programId/majorId)
                // doesn't leave the batch half-created.
                const resp = yield ais.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                    const created = [];
                    for (const s of students) {
                        const { programId, majorId } = s, rest = __rest(s, ["programId", "majorId"]);
                        const row = yield tx.student.create({
                            data: Object.assign(Object.assign(Object.assign({}, rest), programId && ({ program: { connect: { id: programId } } })), majorId && ({ major: { connect: { id: majorId } } })),
                        });
                        created.push(row);
                    }
                    yield tx.log.create({ data: { action: `STUDENT_BULK_UPLOAD`, user: createdBy, meta: { count: created.length, ids: created.map((c) => c.id) } } });
                    return created;
                }));
                res.status(200).json({ success: true, count: resp.length, data: resp });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { titleId, programId, countryId, regionId, religionId, disabilityId, majorId, instituteEmail, indexno } = req.body;
                delete req.body.titleId;
                delete req.body.programId;
                delete req.body.countryId;
                delete req.body.regionId;
                delete req.body.religionId;
                delete req.body.disabilityId;
                delete req.body.majorId;
                // delete req.body.dob;
                // delete req.body.indexno;
                req.body.completeType = !req.body.completeType ? null : req.body.completeType;
                if (indexno != undefined)
                    req.body.indexno = !req.body.indexno ? null : req.body.indexno;
                if (req.body.entryDate)
                    req.body.entryDate = new Date(req.body.entryDate);
                if (req.body.dob)
                    req.body.dob = new Date(req.body.dob);
                const resp = yield ais.student.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), programId && ({ program: { connect: { id: programId } } })), titleId && ({ title: { connect: { id: titleId } } })), countryId && ({ country: { connect: { id: countryId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), disabilityId && ({ disability: { connect: { id: disabilityId } } })), majorId && majorId == 'NONE' && ({ major: { disconnect: true } })), majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }))
                });
                if (resp) {
                    // Update Email as tag in sso_user
                    if (instituteEmail)
                        yield ais.user.updateMany({ where: { tag: (0, paramStr_1.paramStr)(req.params.id) }, data: { username: instituteEmail } });
                    // Log Login Response
                    yield ais.log.create({
                        data: {
                            action: `STUDENT_UPDATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), programId && ({ program: { connect: { id: programId } } })), titleId && ({ title: { connect: { id: titleId } } })), countryId && ({ country: { connect: { id: countryId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), disabilityId && ({ disability: { connect: { id: disabilityId } } })), majorId && majorId == 'NONE' && ({ major: { disconnect: true } })), majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } }))
                        }
                    });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.student.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    // Log Response
                    yield ais.log.create({ data: { action: `STUDENT_DELETED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: resp } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    publishStudentTranscript(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                console.log(req.body.assessmentId);
                const resp = yield ais.$executeRaw `update ais_assessment set status = 1 where id = ${(0, paramStr_1.paramStr)(req.body.assessmentId)} and totalScore is not null`;
                if (resp) {
                    // Log Response
                    yield ais.log.create({ data: { action: `ASSESSMENT_PUBLISHED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: resp } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteStudentTranscript(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.assessment.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    // Log Response
                    yield ais.log.create({ data: { action: `ASSESSMENT_DELETED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: resp } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Courses */
    fetchCourseList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.course.findMany({ where: { status: true }, orderBy: { title: 'asc' } });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchCourses(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                                { id: { contains: keyword } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.course.count(Object.assign({}, (searchCondition))),
                    ais.course.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize) }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchCourse(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.course.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postCourse(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.course.create({
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    // Log Login Response
                    yield ais.log.create({ data: { action: `COURSE_CREATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: req.body } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateCourse(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.course.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    // Log Login Response
                    yield ais.log.create({ data: { action: `COURSE_UPDATED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: req.body } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteCourse(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.course.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    // Log Login Response
                    yield ais.log.create({ data: { action: `COURSE_DELETED`, user: req === null || req === void 0 ? void 0 : req.userId, meta: resp } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Structure & Curriculum */
    fetchCurriculums(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { courseId: { contains: keyword } },
                                { unit: { title: { contains: keyword } } },
                                { program: { longName: { contains: keyword } } },
                                { course: { title: { contains: keyword } } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.structure.count(Object.assign({}, (searchCondition))),
                    ais.structure.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            unit: { select: { title: true } },
                            program: { select: { longName: true } },
                            course: { select: { title: true } },
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                // } else {
                //   res.status(202).json({ message: `no records found` })
                // }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchCurriculumList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.structure.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchCurriculum(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.structure.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postCurriculum(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { unitId, programId, courseId, majorId } = req.body;
                delete req.body.courseId;
                delete req.body.programId;
                delete req.body.unitId;
                delete req.body.majorId;
                const resp = yield ais.structure.create({
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), programId && ({ program: { connect: { id: programId } } })), courseId && ({ course: { connect: { id: courseId } } })), unitId && ({ unit: { connect: { id: unitId } } })), majorId && ({ major: { connect: { id: majorId } } }))
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateCurriculum(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { unitId, programId, courseId, majorId } = req.body;
                delete req.body.courseId;
                delete req.body.programId;
                delete req.body.unitId;
                delete req.body.majorId;
                const resp = yield ais.structure.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), programId && ({ program: { connect: { id: programId } } })), courseId && ({ course: { connect: { id: courseId } } })), unitId && ({ unit: { connect: { id: unitId } } })), majorId && ({ major: { connect: { id: majorId } } }))
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteCurriculum(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.structure.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Schemes */
    fetchSchemes(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.scheme.count(Object.assign({}, (searchCondition))),
                    ais.scheme.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            _count: {
                                select: { program: true }
                            }
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchSchemeList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.scheme.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchScheme(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.scheme.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    include: { program: true }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postScheme(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                console.log(req.body);
                const resp = yield ais.scheme.create({
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateScheme(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                console.log(req.body);
                const resp = yield ais.scheme.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteScheme(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.scheme.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Registrations */
    fetchRegistrationList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityRegister.findMany({
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
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchRegistrations(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
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
                    };
                const resp = yield ais.$transaction([
                    ais.activityRegister.count(Object.assign({}, (searchCondition))),
                    ais.activityRegister.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), orderBy: { createdAt: 'desc' }, include: {
                            student: {
                                select: {
                                    fname: true, mname: true, lname: true, indexno: true,
                                    semesterNum: true, id: true, gender: true,
                                    program: { select: { longName: true } },
                                }
                            },
                            session: { select: { title: true } },
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                // } else {
                //    res.status(202).json({ message: `no records found` })
                // }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchRegistration(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let resp = [];
                const st = yield ais.student.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.indexno) },
                    select: { id: true, indexno: true, fname: true, mname: true, lname: true, gender: true, semesterNum: true, program: { select: { longName: true, department: true } } },
                });
                if (st) {
                    // Get Active Session Info -- no more MAIN/January-SUB stream split,
                    // just the one default session.
                    const session = yield ais.session.findFirst({ where: { default: true } });
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
                    resp = yield ais.assessment.findMany({
                        include: {
                            course: { select: { title: true, creditHour: true } },
                            session: { select: { title: true } },
                        },
                        where: {
                            indexno: st === null || st === void 0 ? void 0 : st.indexno,
                            sessionId: session === null || session === void 0 ? void 0 : session.id
                        },
                    });
                }
                // Resit Courses
                const resits = yield ais.resit.findMany({
                    where: {
                        indexno: (0, paramStr_1.paramStr)(req.params.indexno),
                        registerSession: { default: true }
                    },
                    select: {
                        course: { select: { title: true, creditHour: true } },
                        registerSession: { select: { title: true } },
                        courseId: true
                    }
                });
                if (resits.length) {
                    for (let rs of resits)
                        resp.push({ course: rs.course, session: rs.registerSession, courseId: rs.courseId, type: 'R' });
                }
                if (resp) {
                    // Add Student Bio
                    resp = resp.map((r) => (Object.assign(Object.assign({}, r), { student: st })));
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchRegistrationMount(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            try {
                const courses = [];
                const id = (0, paramStr_1.paramStr)(req.params.indexno);
                // Get Student Info
                const student = yield ais.student.findUnique({ include: { program: { select: { schemeId: true, hasMajor: true } } }, where: { id } });
                const indexno = student === null || student === void 0 ? void 0 : student.indexno;
                // Get Active Session Info -- no more MAIN/January-SUB stream split,
                // just the one default session.
                const session = yield ais.session.findFirst({ where: { default: true } });
                // console.log("Registration SemesterNum: ", student?.semesterNum);
                // Get Normal Courses with/without Majors
                const maincourses = yield ais.structure.findMany({
                    include: { course: { select: { title: true, creditHour: true } }, major: { select: { shortName: true } } },
                    where: {
                        semesterNum: student === null || student === void 0 ? void 0 : student.semesterNum,
                        programId: student === null || student === void 0 ? void 0 : student.programId,
                    },
                    orderBy: { type: 'asc' }
                });
                // Meta & Instructions
                const meta = yield ais.structmeta.findFirst({
                    where: { programId: student === null || student === void 0 ? void 0 : student.programId, majorId: student === null || student === void 0 ? void 0 : student.majorId, semesterNum: student === null || student === void 0 ? void 0 : student.semesterNum },
                });
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
                        const isAdded = courses.find((c) => c.code == course.courseId);
                        if (!isAdded)
                            courses.push(Object.assign({ code: course.courseId, course: (_a = course === null || course === void 0 ? void 0 : course.course) === null || _a === void 0 ? void 0 : _a.title, credit: (_b = course === null || course === void 0 ? void 0 : course.course) === null || _b === void 0 ? void 0 : _b.creditHour, type: course === null || course === void 0 ? void 0 : course.type, lock: course === null || course === void 0 ? void 0 : course.lock, sessionId: session === null || session === void 0 ? void 0 : session.id, schemeId: (_c = student === null || student === void 0 ? void 0 : student.program) === null || _c === void 0 ? void 0 : _c.schemeId, semesterNum: student === null || student === void 0 ? void 0 : student.semesterNum, indexno }, course.majorId && ({ major: (_d = course === null || course === void 0 ? void 0 : course.major) === null || _d === void 0 ? void 0 : _d.shortName })));
                    }
                }
                // Get Resit Courses
                const resitcourses = yield ais.resit.findMany({
                    include: { course: { select: { title: true, creditHour: true } } },
                    where: {
                        indexno, taken: false, trailSession: { semester: session === null || session === void 0 ? void 0 : session.semesterNum },
                    }
                });
                if (student && resitcourses.length) {
                    for (const course of resitcourses) {
                        const isAdded = courses.find((c) => c.code == course.courseId);
                        if (!isAdded)
                            courses.push(Object.assign({ code: course.courseId, course: (_e = course === null || course === void 0 ? void 0 : course.course) === null || _e === void 0 ? void 0 : _e.title, credit: (_f = course === null || course === void 0 ? void 0 : course.course) === null || _f === void 0 ? void 0 : _f.creditHour, type: 'R', lock: false, sessionId: session.id, schemeId: (_g = student === null || student === void 0 ? void 0 : student.program) === null || _g === void 0 ? void 0 : _g.schemeId, semesterNum: student.semesterNum, indexno }, course.majorId && ({ major: (_h = course === null || course === void 0 ? void 0 : course.major) === null || _h === void 0 ? void 0 : _h.shortName })));
                    }
                }
                // Conditions
                let condition = true; // Allow Registration
                let message; // Reason attached
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
                if (!(student === null || student === void 0 ? void 0 : student.indexno)) {
                    condition = false;
                    message = "No Index Number for Student!";
                }
                // If Semester Level or Program ID or (Major  ID for Year 3,4) is not Updated, Block Registration - Before
                if (!(student === null || student === void 0 ? void 0 : student.programId) || (student.program.hasMajor && student.semesterNum > 4 && !student.majorId) || !(student === null || student === void 0 ? void 0 : student.semesterNum)) {
                    condition = false;
                    message = "No Major or Program or Level Set!";
                }
                // If Student is Owing Fees, Lock Registration - Before
                // if(student?.accountNet > 0 && student?.accountNet < (Bill amount * Payment Percentage )) { condition = false; message = "No Index Number for Student!" }
                // If Student is Pardoned by Finance, Allow Registration - Before
                // If Registration Period is Inactive - Before
                // If Registration Period is Active and Halt status is ON - Before
                // If Registration Period is Extended for Late Finers - Before
                if (courses === null || courses === void 0 ? void 0 : courses.length) {
                    res.status(200).json({ session: session === null || session === void 0 ? void 0 : session.title, courses, meta, condition, message, registerStart: session === null || session === void 0 ? void 0 : session.registerStart, registerEnd: session === null || session === void 0 ? void 0 : session.registerEnd, registerEndLate: session === null || session === void 0 ? void 0 : session.registerEndLate });
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(202).json({ message: error.message });
            }
        });
    }
    postRegistration(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const courses = req.body;
                const data = [], rdata = [];
                // Get Active Session Info -- no more MAIN/January-SUB stream split,
                // just the one default session.
                const st = yield ais.student.findFirst({ include: { program: { select: { schemeId: true, hasMajor: true } } }, where: { indexno: courses[0].indexno } });
                const session = yield ais.session.findFirst({ where: { default: true } });
                if (!session)
                    return res.status(400).json({ message: "No active registration session found. Please contact the registry." });
                // Check If Registration Data exists
                const slip = yield ais.assessment.findFirst({ where: { indexno: courses[0].indexno, sessionId: session.id } });
                if (slip)
                    return res.status(400).json({ message: "Registration already submitted!" });
                const resitcourses = courses.filter((row) => row.type == 'R');
                const maincourses = courses.filter((row) => row.type != 'R');
                if (maincourses.length) {
                    for (const course of maincourses) {
                        data.push({
                            courseId: course.code,
                            sessionId: course.sessionId,
                            schemeId: course.schemeId,
                            credit: course.credit,
                            semesterNum: course.semesterNum,
                            indexno: course.indexno,
                            // totalScore: 0,
                            type: 'N'
                        });
                    }
                }
                if (resitcourses === null || resitcourses === void 0 ? void 0 : resitcourses.length) {
                    // Resit Session Info
                    const rsession = yield ais.resitSession.findFirst({ where: { default: true } });
                    // Save Resit Registration
                    for (const course of resitcourses) {
                        const ups = yield ais.resit.updateMany({
                            where: {
                                indexno: course === null || course === void 0 ? void 0 : course.indexno,
                                courseId: course === null || course === void 0 ? void 0 : course.code,
                                taken: false,
                                paid: true
                            },
                            data: {
                                resitSessionId: rsession.id,
                                registerSessionId: course === null || course === void 0 ? void 0 : course.sessionId
                                //registerSession: { connect: { id: course?.sessionId }},
                                //... rsession && ({ session: { connect: { id:rsession?.id }} }),
                                //taken: true  - Only when Resit Exam is taken
                            }
                        });
                        if (ups)
                            rdata.push(ups);
                    }
                }
                // Log Registration
                const isLogged = yield ais.activityRegister.findFirst({
                    where: {
                        indexno: maincourses[0].indexno,
                        sessionId: maincourses[0].sessionId
                    }
                });
                if (!isLogged)
                    yield ais.activityRegister.createMany({
                        data: [{
                                indexno: maincourses[0].indexno,
                                sessionId: maincourses[0].sessionId,
                                courses: courses === null || courses === void 0 ? void 0 : courses.length,
                                credits: courses === null || courses === void 0 ? void 0 : courses.reduce((sum, cur) => sum + cur.credit, 0),
                                semesterNum: maincourses[0].semesterNum,
                                dump: courses
                            }]
                    });
                else
                    yield ais.activityRegister.update({
                        where: { id: isLogged === null || isLogged === void 0 ? void 0 : isLogged.id },
                        data: {
                            indexno: maincourses[0].indexno,
                            sessionId: maincourses[0].sessionId,
                            courses: courses === null || courses === void 0 ? void 0 : courses.length,
                            credits: courses === null || courses === void 0 ? void 0 : courses.reduce((sum, cur) => sum + cur.credit, 0),
                            semesterNum: maincourses[0].semesterNum,
                            dump: courses
                        }
                    });
                // Save Registration Courses
                const mainresp = yield ais.assessment.createMany({ data });
                if (mainresp) {
                    res.status(200).json({ courses: mainresp, resits: rdata, totalCourses: courses.length });
                }
                else {
                    res.status(202).json({ message: `No selected courses found!` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: (error === null || error === void 0 ? void 0 : error.message) || error });
            }
        });
    }
    updateRegistration(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const indexno = (0, paramStr_1.paramStr)(req.params.indexno);
                const courses = req.body;
                const data = [], rdata = [];
                const resitcourses = courses.filter((row) => row.type == 'R');
                const maincourses = courses.filter((row) => row.type != 'R');
                if (maincourses.length) {
                    for (const course of maincourses) {
                        data.push({
                            courseId: course.courseId,
                            sessionId: course.sessionId,
                            schemeId: course.schemeId,
                            credit: course.credit,
                            semesterNum: course.semesterNum,
                            indexno,
                            // totalScore: 0
                        });
                    }
                }
                if (resitcourses.length) {
                    for (const course of resitcourses) {
                        const ups = yield ais.resit.updateMany({
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
                        });
                        if (ups)
                            rdata.push(ups);
                    }
                }
                const mainresp = yield ais.assessment.createMany({ data });
                if (mainresp) {
                    res.status(200).json({ courses: mainresp, resits: rdata });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteRegistration(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // const { data } =  req.body;
                // if(data?.length){
                // }
                // Delete Courses Registration
                const resp = yield ais.assessment.deleteMany({
                    where: {
                        indexno: (0, paramStr_1.paramStr)(req.params.indexno),
                        session: { default: true }
                    }
                });
                // Delete Registration Log
                const log = yield ais.activityRegister.deleteMany({
                    where: {
                        indexno: (0, paramStr_1.paramStr)(req.params.indexno),
                        session: { default: true }
                    }
                });
                // Reset Resit Registration
                const resit = yield ais.resit.updateMany({
                    where: {
                        indexno: (0, paramStr_1.paramStr)(req.params.indexno),
                        registerSession: { default: true }
                    },
                    data: {
                        taken: false,
                        resitSessionId: null,
                        registerSessionId: null,
                    }
                });
                if (resp === null || resp === void 0 ? void 0 : resp.count) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `Registration not deleted` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* programs */
    fetchProgramList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.program.findMany({
                    where: { status: true },
                    include: {
                        department: { select: { title: true } },
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchPrograms(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { code: { contains: keyword } },
                                { shortName: { contains: keyword } },
                                { longName: { contains: keyword } },
                                { prefix: { contains: keyword } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.program.count(Object.assign({}, (searchCondition))),
                    ais.program.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            department: { select: { title: true } },
                            student: { select: { _count: true } }
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchProgram(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.program.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    include: {
                        department: { select: { title: true } },
                        student: { select: { _count: true } }
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchProgramStructure(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            try {
                const resp = yield ais.program.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    include: {
                        structure: {
                            select: {
                                id: true,
                                type: true,
                                semesterNum: true,
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
                });
                if ((_a = resp === null || resp === void 0 ? void 0 : resp.structure) === null || _a === void 0 ? void 0 : _a.length) {
                    var mdata = new Map(), sdata = new Map();
                    for (const sv of resp === null || resp === void 0 ? void 0 : resp.structure) {
                        const index = `LEVEL ${Math.ceil(sv.semesterNum / 2) * 100}, ${sv.semesterNum % 2 == 0 ? 'SEMESTER 2' : 'SEMESTER 1'}` || 'none';
                        const zd = Object.assign(Object.assign({}, sv), { course: (_b = sv === null || sv === void 0 ? void 0 : sv.course) === null || _b === void 0 ? void 0 : _b.title, code: (_c = sv === null || sv === void 0 ? void 0 : sv.course) === null || _c === void 0 ? void 0 : _c.id, credit: (_d = sv === null || sv === void 0 ? void 0 : sv.course) === null || _d === void 0 ? void 0 : _d.creditHour, practical: (_e = sv === null || sv === void 0 ? void 0 : sv.course) === null || _e === void 0 ? void 0 : _e.practicalHour, theory: (_f = sv === null || sv === void 0 ? void 0 : sv.course) === null || _f === void 0 ? void 0 : _f.theoryHour, type: sv === null || sv === void 0 ? void 0 : sv.type });
                        // Data By Level - Semester
                        if (mdata.has(index)) {
                            mdata.set(index, [...mdata.get(index), Object.assign({}, zd)]);
                        }
                        else {
                            mdata.set(index, [Object.assign({}, zd)]);
                        }
                    }
                    for (const sv of resp === null || resp === void 0 ? void 0 : resp.structmeta) {
                        const index = `LEVEL ${Math.ceil(sv.semesterNum / 2) * 100}, ${sv.semesterNum % 2 == 0 ? 'SEMESTER 2' : 'SEMESTER 1'}` || 'none';
                        const zd = Object.assign({}, sv);
                        // Data By Level - Semester
                        if (sdata.has(index)) {
                            sdata.set(index, [...sdata.get(index), Object.assign({}, zd)]);
                        }
                        else {
                            sdata.set(index, [Object.assign({}, zd)]);
                        }
                    }
                    console.log(Object.fromEntries(sdata));
                    res.status(200).json({ data: Array.from(mdata), meta: Object.fromEntries(sdata) });
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchProgramStudents(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const resp = yield ais.program.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
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
                                program: { select: { shortName: true, longName: true } }
                            },
                            orderBy: { semesterNum: 'asc' }
                        }
                    },
                });
                if ((_a = resp === null || resp === void 0 ? void 0 : resp.student) === null || _a === void 0 ? void 0 : _a.length) {
                    var mdata = new Map();
                    for (const sv of resp === null || resp === void 0 ? void 0 : resp.student) {
                        const index = `LEVEL ${Math.ceil(sv.semesterNum / 2) * 100}` || 'none';
                        const zd = Object.assign({}, sv);
                        // Data By Level - Semester
                        if (mdata.has(index)) {
                            mdata.set(index, [...mdata.get(index), Object.assign({}, zd)]);
                        }
                        else {
                            mdata.set(index, [Object.assign({}, zd)]);
                        }
                    }
                    res.status(200).json(Array.from(mdata));
                }
                else {
                    res.status(200).json([]);
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchProgramStatistics(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.program.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    include: {
                        department: { select: { title: true } },
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postProgram(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { unitId, schemeId } = req.body;
                delete req.body.schemeId;
                delete req.body.unitId;
                if (unitId && !(yield isValidDepartmentUnit(unitId))) {
                    return res.status(400).json({ message: `Department must be a valid academic department (unit).` });
                }
                const resp = yield ais.program.create({
                    data: Object.assign(Object.assign(Object.assign({}, req.body), unitId && ({ department: { connect: { id: unitId } } })), schemeId && ({ scheme: { connect: { id: schemeId } } }))
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateProgram(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { unitId, schemeId } = req.body;
                delete req.body.schemeId;
                delete req.body.unitId;
                if (unitId && !(yield isValidDepartmentUnit(unitId))) {
                    return res.status(400).json({ message: `Department must be a valid academic department (unit).` });
                }
                const resp = yield ais.program.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign({}, req.body), unitId && ({ department: { connect: { id: unitId } } })), schemeId && ({ scheme: { connect: { id: schemeId } } }))
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteProgram(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.program.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Majors */
    fetchMajorList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.major.findMany({
                    where: { status: true },
                    include: {
                        program: { select: { shortName: true } },
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Departments */
    fetchDepartments(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.unit.findMany({
                    where: { status: true, levelNum: 2, type: 'ACADEMIC' },
                    include: {
                        level1: { select: { title: true, code: true } },
                        _count: {
                            select: {
                                staff: true,
                                program: true
                            }
                        },
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Faculties */
    fetchFaculties(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.unit.findMany({
                    where: { status: true, levelNum: 1, type: 'ACADEMIC' },
                    include: {
                        levelI: { select: { _count: { select: { program: true } } } },
                        _count: {
                            select: {
                                staff: true,
                                levelI: true
                            }
                        },
                    },
                    orderBy: {}
                });
                console.log("Faculties: ", resp);
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Units */
    fetchUnits(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                                { code: { contains: keyword } },
                                { headStaffNo: { contains: keyword } },
                            ],
                        },
                        //include: { level1: true },
                        //   orderBy: { createdAt: 'asc'}
                    };
                const resp = yield ais.$transaction([
                    ais.unit.count(Object.assign({}, (searchCondition))),
                    ais.unit.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize) }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: resp[1],
                    });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchUnitList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.unit.findMany({
                    where: { status: true },
                    include: { level1: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchUnit(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.unit.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    include: { level1: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postUnit(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { level1Id, level2Id } = req.body;
                delete req.body.level1Id;
                delete req.body.level2Id;
                const resp = yield ais.unit.create({
                    data: Object.assign(Object.assign(Object.assign({}, req.body), level1Id && ({ level1: { connect: { id: level1Id } } })), level2Id && ({ level2: { connect: { id: level2Id } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateUnit(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { level1Id, level2Id, headStaffNo: newHead } = req.body;
                delete req.body.level1Id;
                delete req.body.level2Id;
                const unit = yield ais.unit.findFirst({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                const resp = yield ais.unit.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), level1Id && ({ level1: { connect: { id: level1Id } } })), !level1Id && ({ level1: { disconnect: true } })), level2Id && ({ level2: { connect: { id: level2Id } } })), !level2Id && ({ level2: { disconnect: true } }))
                });
                if (resp) {
                    // Stage Head or Dean of Unit
                    if (['ACADEMIC'].includes(unit === null || unit === void 0 ? void 0 : unit.type) && newHead && newHead != unit.headStaffNo) {
                        //###### NEW HEAD/DEAN ####//
                        // Update Role of New Head or Dean
                        let userId;
                        const nrole = yield ais.userRole.findFirst({
                            where: {
                                user: { tag: newHead },
                                appRole: { id: { in: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16] } }
                            }
                        });
                        if (nrole) {
                            userId = nrole.userId;
                            // Remove AIS Roles
                            yield ais.userRole.deleteMany({
                                where: {
                                    user: { tag: newHead },
                                    appRole: { id: { in: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16] } }
                                }
                            });
                        }
                        else {
                            const user = yield ais.user.findFirst({ where: { tag: newHead } });
                            if (user)
                                userId = user.id;
                        }
                        if ((unit === null || unit === void 0 ? void 0 : unit.levelNum) == 1) {
                            yield ais.userRole.create({
                                data: {
                                    userId,
                                    appRoleId: 4,
                                    roleMeta: unit === null || unit === void 0 ? void 0 : unit.id
                                }
                            });
                        }
                        else {
                            yield ais.userRole.create({
                                data: {
                                    userId,
                                    appRoleId: 3,
                                    roleMeta: unit === null || unit === void 0 ? void 0 : unit.id
                                }
                            });
                        }
                        // ###### OLD HEAD/DEAN ###### //
                        if (unit === null || unit === void 0 ? void 0 : unit.headStaffNo) {
                            const orole = yield ais.userRole.findFirst({
                                where: {
                                    user: { tag: unit === null || unit === void 0 ? void 0 : unit.headStaffNo },
                                    appRole: { id: { in: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16] } }
                                }
                            });
                            if (orole) {
                                // Remove AIS Roles
                                yield ais.userRole.deleteMany({
                                    where: {
                                        user: { tag: unit === null || unit === void 0 ? void 0 : unit.headStaffNo },
                                        appRole: { id: { in: [1, 2, 3, 4, 5, 6, 13, 14, 15, 16] } }
                                    }
                                });
                                // Create Assessor Role
                                yield ais.userRole.create({
                                    data: {
                                        userId: orole === null || orole === void 0 ? void 0 : orole.userId,
                                        appRoleId: 1,
                                        roleMeta: null
                                    }
                                });
                            }
                        }
                    }
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteUnit(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.unit.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Jobs */
    fetchJobs(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                                { id: { contains: keyword } },
                            ],
                        },
                    };
                const resp = yield ais.$transaction([
                    ais.job.count(Object.assign({}, (searchCondition))),
                    ais.job.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize) }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: resp[1],
                    });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchJobList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.job.findMany({
                    where: { status: true }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchJob(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.job.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postJob(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.job.create({
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateJob(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.job.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteJob(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.job.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Progression */
    fetchProgressions(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {
                where: { session: { default: true } }
            };
            try {
                if (keyword)
                    searchCondition = {
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
                    };
                const resp = yield ais.$transaction([
                    ais.activityProgress.count(Object.assign({}, (searchCondition))),
                    ais.activityProgress.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            student: { include: { program: true } },
                            session: true
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                // } else {
                //    res.status(202).json({ message: `no records found` })
                // }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchProgression(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityProgress.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postProgression(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            try {
                const { indexno } = req.body;
                delete req.body.indexno;
                // Check If Student Exist with Index number
                const st = yield ais.student.findFirst({ where: { indexno, deferStatus: false, completeStatus: false }, include: { program: { select: { semesterTotal: true } } } });
                if (!st)
                    throw ("Student can't be progressed, check indexno,defer or complete status!");
                // Fetch Active Session for Student -- no more MAIN/January-SUB stream
                // split, just the one default session.
                const session = yield ais.session.findFirst({ where: { default: true } });
                // Check If Progressed
                const pg = yield ais.activityProgress.findFirst({ where: { indexno, sessionId: session === null || session === void 0 ? void 0 : session.id } });
                if (pg)
                    throw ("Student already progressed !");
                // Save Progression Data
                const resp = yield ais.activityProgress.create({
                    data: Object.assign(Object.assign({ semesterNum: (st.semesterNum + 1 > ((_a = st.program) === null || _a === void 0 ? void 0 : _a.semesterTotal) ? 0 : st.semesterNum + 1), status: true }, session && ({ session: { connect: { id: session === null || session === void 0 ? void 0 : session.id } } })), indexno && ({ student: { connect: { indexno } } }))
                });
                if (resp) {
                    // Update Student SemesterNum & CompleteStatus
                    yield ais.student.update({
                        where: { id: st === null || st === void 0 ? void 0 : st.id },
                        data: {
                            semesterNum: (st.semesterNum + 1 > ((_b = st.program) === null || _b === void 0 ? void 0 : _b.semesterTotal) ? 0 : st.semesterNum + 1),
                            completeStatus: (st.semesterNum + 1 > ((_c = st.program) === null || _c === void 0 ? void 0 : _c.semesterTotal) ? true : false)
                        }
                    });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(202).json({ message: error.message });
            }
        });
    }
    postAllProgression(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { sessionId } = req.body;
                delete req.body.sessionId;
                // Fetch Active Session for Student
                const session = yield ais.session.findFirst({ where: { id: sessionId } });
                // No more MAIN/January-SUB stream split -- every active student.
                const students = yield ais.$queryRaw `select s.id,indexno,semesterNum,p.semesterTotal from ais_student s left join ais_program p on s.programId = p.id where completeStatus = 0 and deferStatus = 0 and indexno is not NULL`;
                const resp = yield Promise.all(students.map((st) => __awaiter(this, void 0, void 0, function* () {
                    console.log("st: ", st);
                    // Check If Progressed
                    const pg = yield ais.activityProgress.findFirst({ where: { indexno: st === null || st === void 0 ? void 0 : st.indexno, sessionId: session === null || session === void 0 ? void 0 : session.id } });
                    if (pg)
                        return null;
                    // Update Student SemesterNum & CompleteStatus
                    yield ais.student.update({
                        where: { id: st === null || st === void 0 ? void 0 : st.id },
                        data: {
                            semesterNum: ((st === null || st === void 0 ? void 0 : st.semesterNum) + 1 > (st === null || st === void 0 ? void 0 : st.semesterTotal) ? 0 : Math.min(st === null || st === void 0 ? void 0 : st.semesterTotal, (st === null || st === void 0 ? void 0 : st.semesterNum) + 1)),
                            completeStatus: ((st === null || st === void 0 ? void 0 : st.semesterNum) + 1 > (st === null || st === void 0 ? void 0 : st.semesterTotal) ? true : false)
                        }
                    });
                    // Update Session Progression Status
                    yield ais.session.update({ where: { id: sessionId }, data: { progressStudent: true } });
                    // Return Response
                    return ais.activityProgress.create({
                        data: Object.assign({ student: { connect: { indexno: st.indexno } }, semesterNum: ((st === null || st === void 0 ? void 0 : st.semesterNum) + 1 > (st === null || st === void 0 ? void 0 : st.semesterTotal) ? 0 : Math.min(st === null || st === void 0 ? void 0 : st.semesterTotal, (st === null || st === void 0 ? void 0 : st.semesterNum) + 1)), status: true }, session && ({ session: { connect: { id: session === null || session === void 0 ? void 0 : session.id } } }))
                    });
                })));
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateProgression(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityProgress.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteProgression(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityProgress.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Sheets */
    fetchSheets(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 6, keyword = '', unit = '' } = req.query;
            const offset = (page - 1) * pageSize;
            try {
                // Data-level scoping (category/headStaffNo/assignStaffId) on top of the
                // route-level requireRole gate — see util/sheetScope.ts.
                const scopeWhere = (0, sheetScope_1.sheetScopeWhere)(req.roles, req.userId);
                const andClauses = [
                    { session: { OR: [{ default: true }, { assignLateSheet: true }] } },
                ];
                if (scopeWhere)
                    andClauses.push(scopeWhere);
                if (unit)
                    andClauses.push({
                        OR: [
                            { unit: { id: unit, levelNum: 2 } },
                            { unit: { level1Id: unit, levelNum: 2 } },
                        ]
                    });
                if (keyword)
                    andClauses.push({
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
                const resp = yield ais.$transaction([
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
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchMySheets(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const assignStaffId = req.userId;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {
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
                if (keyword)
                    searchCondition = {
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
                    };
                const resp = yield ais.$transaction([
                    ais.sheet.count(Object.assign({}, (searchCondition))),
                    ais.sheet.findMany(Object.assign(Object.assign({}, (searchCondition &&
                        (Object.assign(Object.assign({}, searchCondition), { include: {
                                session: true,
                                program: true,
                                course: true,
                                major: true,
                                assignee: true,
                            } })))), { skip: offset, take: Number(pageSize), 
                        // orderBy: [{ sessionId:'desc'},{ semesterNum:'asc'}]
                        orderBy: [
                            { session: { createdAt: 'desc' } },
                            { semesterNum: 'asc' }
                        ] }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                // } else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    stageSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Fetch Active Semester
                const { sessionId } = req.body;
                // Fetch Session Info
                const session = yield ais.session.findFirst({ where: { id: sessionId, default: true } });
                if (session) {
                    // Fetch Mounted Courses all Program Levels — one sheet per
                    // program/session/semester, no mode-based split.
                    let mounts = yield ais.structure.findMany({ where: { status: true }, include: { program: true } });
                    mounts = mounts.filter((meta) => ((meta === null || meta === void 0 ? void 0 : meta.semesterNum) % 2) == ((session === null || session === void 0 ? void 0 : session.semester) == 'SEM2' ? 0 : 1));
                    let data = mounts;
                    // Check whether Sheets are generated
                    const form = yield ais.sheet.findFirst({ where: { sessionId, status: true } });
                    if (form) {
                        // Update Generated Flag
                        yield ais.session.update({ where: { id: sessionId }, data: { stageSheet: true } });
                        // Return Response
                        return res.status(202).json({ message: `sheets exists for calendar` });
                    }
                    // Upsert Bulk into Sheet
                    const resp = yield Promise.all(data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                        let { courseId, programId, unitId, majorId } = row;
                        return yield ais.sheet.create({
                            data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ semesterNum: row.semesterNum }, sessionId && ({ session: { connect: { id: sessionId } } })), courseId && ({ course: { connect: { id: courseId } } })), programId && ({ program: { connect: { id: programId } } })), majorId && ({ major: { connect: { id: majorId } } })), unitId && ({ unit: { connect: { id: unitId } } }))
                        });
                    })));
                    if (resp) {
                        // Update Stage Status in Calendar
                        yield ais.session.update({ where: { id: sessionId }, data: { stageSheet: true } });
                        return res.status(200).json(resp);
                    }
                    else {
                        return res.status(202).json({ message: `no record found` });
                    }
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    cleanSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
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
                const session = yield ais.session.findFirst({ where: { id: sessionId } });
                if (session) {
                    // Fetch Mounted Courses all Program Levels — one sheet per
                    // program/session/semester, no mode-based split.
                    let mounts = yield ais.structure.findMany({ where: { status: true }, include: { program: true } });
                    mounts = mounts.filter((meta) => ((meta === null || meta === void 0 ? void 0 : meta.semesterNum) % 2) == ((session === null || session === void 0 ? void 0 : session.semester) == 'SEM2' ? 0 : 1));
                    let data = mounts;
                    // Upsert Bulk into Sheet
                    const resp = yield Promise.all(data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                        let { courseId, programId, unitId, majorId } = row;
                        const sheetM = yield ais.sheet.findFirst({ where: { semesterNum: row.semesterNum, sessionId, programId, courseId } });
                        yield ais.$executeRaw `set foreign_key_checks=0`;
                        if (sheetM) {
                            return yield ais.$executeRaw `UPDATE ais_sheet SET semesterNum = ${row.semesterNum}, assignStaffId = ${(sheetM === null || sheetM === void 0 ? void 0 : sheetM.assignStaffId) || null}, sessionId = ${sessionId || null}, courseId = ${courseId || null}, programId = ${programId || null}, majorId = ${majorId || null}, unitId = ${unitId || null}, updatedAt = NOW() WHERE id = ${sheetM.id}`;
                        }
                        else {
                            return yield ais.$executeRaw `INSERT INTO ais_sheet (id,semesterNum,assignStaffId,sessionId,courseId,programId,majorId,unitId,status,createdAt,updatedAt) VALUES (UUID(),${row.semesterNum}, ${(sheetM === null || sheetM === void 0 ? void 0 : sheetM.assignStaffId) || null}, ${sessionId || null}, ${courseId || null}, ${programId || null}, ${majorId || null}, ${unitId || null}, 1, NOW(),NOW())`;
                        }
                    })));
                    if (resp) {
                        return res.status(200).json(resp);
                    }
                    else {
                        return res.status(202).json({ message: `no record found` });
                    }
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    loadSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Fetch Active Semester
                const { sheetId } = req.body;
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, sheetId, req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                // Fetch Session Info
                const sheet = yield ais.sheet.findFirst({ where: { id: sheetId, status: true }, include: { program: true, unit: true, session: true, course: true, major: true } });
                if (sheet) {
                    // Fetch Mounted Courses all Program Levels
                    let mounts = yield ais.assessment.findMany({
                        where: {
                            semesterNum: sheet.semesterNum,
                            sessionId: sheet === null || sheet === void 0 ? void 0 : sheet.sessionId,
                            courseId: sheet === null || sheet === void 0 ? void 0 : sheet.courseId,
                            student: { programId: sheet === null || sheet === void 0 ? void 0 : sheet.programId },
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
                    });
                    let resp = mounts === null || mounts === void 0 ? void 0 : mounts.map((row) => {
                        var _a, _b;
                        const grade = (0, helper_1.getGrade)(row.totalScore, (_a = row.scheme) === null || _a === void 0 ? void 0 : _a.gradeMeta);
                        const gradepoint = (0, helper_1.getGradePoint)(row.totalScore, (_b = row.scheme) === null || _b === void 0 ? void 0 : _b.gradeMeta);
                        return (Object.assign(Object.assign({}, row), { grade,
                            gradepoint }));
                    });
                    console.log("resp: ", resp);
                    if (resp) {
                        res.status(200).json(resp);
                    }
                    else {
                        res.status(202).json({ message: `no record found` });
                    }
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    uploadSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Fetch Active Semester
                const { id, data } = req.body;
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, id, req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                // const createdBy = req.userId;
                let resp;
                const sheet = yield ais.sheet.findFirst({ where: { id } });
                if ((data === null || data === void 0 ? void 0 : data.length) && sheet && !sheet.assessed) {
                    const { sessionId, courseId } = sheet;
                    resp = yield Promise.all(data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                        const { indexno, quiz, assignment, midsem } = row;
                        const scoreA = quiz !== '' && quiz != null ? parseFloat(quiz) : null;
                        const scoreB = assignment !== '' && assignment != null ? parseFloat(assignment) : null;
                        const scoreC = midsem !== '' && midsem != null ? parseFloat(midsem) : null;
                        // Class score is always the sum of Quiz/Assignment/Midsem — same
                        // rule as the manual capture form (saveSheet). Never trust a
                        // pre-computed class/total column from the uploaded file.
                        const classScore = (scoreA !== null && scoreA !== void 0 ? scoreA : 0) + (scoreB !== null && scoreB !== void 0 ? scoreB : 0) + (scoreC !== null && scoreC !== void 0 ? scoreC : 0);
                        let isExist = yield ais.assessment.findFirst({ where: { sessionId, courseId, indexno } });
                        if (isExist) {
                            // Exam score isn't part of this upload — total is recomputed
                            // from the new class score plus whatever exam score already
                            // exists on the record, left untouched here.
                            const totalScore = classScore + (isExist.examScore || 0);
                            return yield ais.assessment.update({ where: { id: isExist === null || isExist === void 0 ? void 0 : isExist.id }, data: { scoreA, scoreB, scoreC, classScore, totalScore } });
                        }
                        return null;
                    })));
                }
                else
                    return resp;
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `Upload failed` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    saveSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Fetch Active Semester
                const { count, data, sheetId } = req.body;
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, sheetId, req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                const sheet = yield ais.sheet.findUnique({ where: { id: sheetId }, select: { programId: true, majorId: true } });
                if (!sheet)
                    return res.status(202).json({ message: `no record found` });
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
                    const classScore = (scoreA !== null && scoreA !== void 0 ? scoreA : 0) + (scoreB !== null && scoreB !== void 0 ? scoreB : 0) + (scoreC !== null && scoreC !== void 0 ? scoreC : 0);
                    let examScore = parseFloat(data[`${i}_exam`]);
                    examScore = !isNaN(examScore) ? examScore : null;
                    let totalScore = classScore + examScore;
                    totalScore = !isNaN(totalScore) ? totalScore : null;
                    const indexno = data[`${i}_idx`];
                    const id = data[`${i}_id`];
                    mounts.push({
                        where: {
                            id, course: { id: courseId }, session: { id: sessionId }, indexno,
                            // Constrain to this sheet's own student population, not just
                            // any row that happens to share course+session+indexno —
                            // closes the gap where saveSheet couldn't otherwise verify a
                            // captured score belongs to the sheet it was authorized for.
                            student: Object.assign({ programId: sheet.programId }, sheet.majorId && ({ majorId: sheet.majorId })),
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
                    });
                }
                // Bulk Score Update
                const resp = yield Promise.all(mounts === null || mounts === void 0 ? void 0 : mounts.map((query) => __awaiter(this, void 0, void 0, function* () {
                    return yield ais.assessment.updateMany(query);
                })));
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, (0, paramStr_1.paramStr)(req.params.id), req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                const resp = yield ais.sheet.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    include: {
                        session: { select: { title: true, cohort: true } },
                        program: { select: { longName: true, category: true } },
                        course: { select: { title: true, id: true, creditHour: true } },
                        major: { select: { longName: true } },
                        assignee: true,
                        assessor: true,
                        certifier: true
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Optional relation fields (majorId, assignStaffId, assessorId,
                // certifierId) come through as "" when left blank, or "NONE" for
                // the Major field's explicit no-major option — either passed
                // straight through as a scalar foreign key, MariaDB rejects it as
                // pointing to a row that doesn't exist. stripBlank drops them so
                // Prisma just omits the field instead.
                const resp = yield ais.sheet.create({
                    data: (0, helper_1.stripBlank)(req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: (0, helper_1.friendlyDbError)(error) });
            }
        });
    }
    submitSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const assessorId = req.userId;
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, (0, paramStr_1.paramStr)(req.params.id), req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                const resp = yield ais.sheet.update({ where: { id: (0, paramStr_1.paramStr)(req.params.id) }, data: { assessed: true, assessorId } });
                if (resp) {
                    console.log(resp);
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    closeSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.sheet.findUnique({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                if (resp) {
                    let { courseId, programId, unitId, majorId, sessionId, semesterNum } = resp;
                    // Fetch Affected Students
                    const assessments = yield ais.assessment.findMany({
                        where: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, sessionId && ({ sessionId })), courseId && ({ courseId })), programId && ({ student: { programId } })), majorId && ({ student: { majorId } })), semesterNum && ({ semesterNum: Number(semesterNum) })),
                        include: { scheme: true }
                    });
                    // Generate Resit Data on Sheet Close
                    //const rsession = await ais.resitSession.findFirst({ where: { default: true }});
                    const all = yield Promise.all(assessments.filter((a) => a.totalScore < a.scheme.passMark).map((r) => __awaiter(this, void 0, void 0, function* () {
                        const { sessionId, indexno, courseId, schemeId, semesterNum } = r;
                        return yield ais.resit.upsert({
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
                        });
                    })));
                    // Update Student Assessment Publish Status
                    yield ais.assessment.updateMany({
                        where: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, sessionId && ({ sessionId })), courseId && ({ courseId })), programId && ({ student: { programId } })), majorId && ({ student: { majorId } })), semesterNum && ({ semesterNum: Number(semesterNum) })),
                        data: { status: true },
                    });
                    console.log(all);
                    // Update Sheet
                    yield ais.sheet.update({ where: { id: (0, paramStr_1.paramStr)(req.params.id) }, data: { finalized: true } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    moderateSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, (0, paramStr_1.paramStr)(req.params.id), req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                const resp = yield ais.sheet.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: { moderated: true }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    publishSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const certifierId = req.userId;
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, (0, paramStr_1.paramStr)(req.params.id), req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                const resp = yield ais.sheet.findUnique({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                if (resp) {
                    if (!resp.moderated) {
                        return res.status(400).json({ message: `This sheet must be moderated before it can be published.` });
                    }
                    let { courseId, programId, unitId, majorId, sessionId, semesterNum } = resp;
                    // Update Student Assessment Publish Status
                    const ups = yield ais.assessment.updateMany({
                        where: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, sessionId && ({ sessionId })), courseId && ({ courseId })), programId && ({ student: { programId } })), majorId && ({ student: { majorId } })), semesterNum && ({ semesterNum: Number(semesterNum) })),
                        data: { status: true }
                    });
                    // Update Sheet
                    yield ais.sheet.update({ where: { id: (0, paramStr_1.paramStr)(req.params.id) }, data: { certified: true, certifierId } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    unpublishSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, (0, paramStr_1.paramStr)(req.params.id), req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                const resp = yield ais.sheet.findUnique({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                if (resp) {
                    let { courseId, programId, unitId, majorId, sessionId, semesterNum } = resp;
                    // Update Student Assessment Publish Status
                    const ups = yield ais.assessment.updateMany({
                        where: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, sessionId && ({ sessionId })), courseId && ({ courseId })), programId && ({ student: { programId } })), majorId && ({ student: { majorId } })), semesterNum && ({ semesterNum: Number(semesterNum) })),
                        data: { status: false }
                    });
                    console.log(ups);
                    // Update Sheet
                    yield ais.sheet.update({ where: { id: (0, paramStr_1.paramStr)(req.params.id) }, data: { certified: false, certifierId: null } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let { courseId, programId, unitId, majorId, sessionId, semesterNum, assignStaffId } = req.body;
                // This endpoint serves two different callers behind the same route:
                // the admin-only edit form (arbitrary fields) and the "assign sheet"
                // action (only assignStaffId), which hod/registry roles may also
                // trigger — so authorization branches by request body shape.
                const isAssignOnly = !!assignStaffId && !courseId && !programId && !unitId && !majorId && !sessionId && !semesterNum;
                if (isAssignOnly) {
                    const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, (0, paramStr_1.paramStr)(req.params.id), req.roles, req.userId);
                    if (!inScope)
                        return res.status(403).json({ message: `You do not have access to this sheet.` });
                }
                else if (!(0, sheetScope_1.isSheetAdmin)(req.roles)) {
                    return res.status(403).json({ message: `You do not have permission to edit this sheet.` });
                }
                const sheet = yield ais.sheet.findUnique({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                const resp = yield ais.sheet.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, semesterNum && ({ semesterNum: Number(semesterNum) })), sessionId && ({ session: { connect: { id: sessionId } } })), courseId && ({ course: { connect: { id: courseId } } })), programId && ({ program: { connect: { id: programId } } })), unitId && ({ unit: { connect: { id: unitId } } })), majorId && majorId == 'NONE' && ({ major: { disconnect: true } })), majorId && majorId != 'NONE' && ({ major: { connect: { id: majorId } } })), assignStaffId && ({ assignee: { connect: { staffNo: assignStaffId } } }))
                });
                if (resp) {
                    // Send SMS
                    if (assignStaffId && (assignStaffId != sheet.assignStaffId)) {
                        const st = yield ais.staff.findFirst({ where: { staffNo: assignStaffId } });
                        if (st === null || st === void 0 ? void 0 : st.phone)
                            yield sms(st === null || st === void 0 ? void 0 : st.phone, `Hi! You have been assigned a course with course code: ${sheet === null || sheet === void 0 ? void 0 : sheet.courseId} for Year ${Math.ceil((sheet === null || sheet === void 0 ? void 0 : sheet.semesterNum) / 2)}. Please login to assess your students.`);
                    }
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: (0, helper_1.friendlyDbError)(error) });
            }
        });
    }
    reverseSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                // The route (POST /sheets/reverse) has no :id param — the frontend
                // sends the target sheet's id as sheetId in the body.
                const sheetId = (0, paramStr_1.paramStr)((_a = req.body) === null || _a === void 0 ? void 0 : _a.sheetId);
                const inScope = yield (0, sheetScope_1.isSheetInScope)(ais, sheetId, req.roles, req.userId);
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to this sheet.` });
                const resp = yield ais.sheet.update({
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
                });
                if (resp) {
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteSheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.sheet.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Backlog */
    fetchBacklogs(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                const where = Object.assign({}, keyword && ({
                    OR: [
                        { title: { contains: keyword } },
                        { session: { title: { contains: keyword } } },
                    ],
                }));
                if (Object.keys(where).length)
                    searchCondition = { where };
                const resp = yield ais.$transaction([
                    ais.activityBacklog.count(Object.assign({}, (searchCondition))),
                    ais.activityBacklog.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            session: true
                        } }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    return res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: resp[1],
                    });
                }
                else {
                    return res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchBacklog(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityBacklog.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    include: { session: true }
                });
                if (resp) {
                    // Flag rows whose indexno has no matching student so the UI can
                    // highlight them before an approval attempt rejects the batch.
                    const indexnos = [...new Set((resp.meta || []).map((r) => { var _a; return (_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(); }).filter(Boolean))];
                    if (indexnos.length) {
                        const students = yield ais.student.findMany({ where: { indexno: { in: indexnos } }, select: { indexno: true } });
                        const foundIndexnos = new Set(students.map((s) => s.indexno));
                        resp.meta = resp.meta.map((r) => { var _a; return (Object.assign(Object.assign({}, r), { studentExists: foundIndexnos.has((_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim()) })); });
                    }
                    return res.status(200).json(resp);
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    approveBacklog(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const approvedBy = req.userId;
                const rs = yield ais.activityBacklog.findUnique({
                    where: { id: (_a = req.body) === null || _a === void 0 ? void 0 : _a.backlogId },
                });
                if (rs) {
                    const { id, type, meta, sessionId, schemeId } = rs;
                    // Validate the whole batch up front so a bad row fails cleanly
                    // instead of leaving the backlog partially committed.
                    if (type == 'ASSESSMENT') {
                        const missingScore = (meta || []).filter((r) => r.scoreTotal === null || r.scoreTotal === undefined || Number.isNaN(r.scoreTotal));
                        if (missingScore.length) {
                            const indexnos = [...new Set(missingScore.map((r) => { var _a; return (_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(); }))];
                            return res.status(400).json({
                                message: `Backlog not committed: total score is missing for ${missingScore.length} of ${meta.length} student record(s): ${indexnos.join(', ')}. Please provide a total score before committing this backlog.`,
                                failedCount: missingScore.length,
                                totalCount: meta.length,
                                errors: indexnos.map((indexno) => ({ indexno, reason: 'Total score is missing' })),
                            });
                        }
                    }
                    const indexnos = [...new Set((meta || []).map((r) => { var _a; return (_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(); }).filter(Boolean))];
                    if (indexnos.length) {
                        const students = yield ais.student.findMany({ where: { indexno: { in: indexnos } }, select: { indexno: true } });
                        const foundIndexnos = new Set(students.map((s) => s.indexno));
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
                    let resp;
                    try {
                        resp = yield ais.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                            let data = [];
                            if (type == 'ASSESSMENT') { // BACKLOG ASSESSMENT
                                data = yield Promise.all(meta.map((r) => __awaiter(this, void 0, void 0, function* () {
                                    var _a, _b;
                                    try {
                                        const as = yield tx.assessment.findFirst({ where: { sessionId, courseId: r.courseId, indexno: r.indexno.trim() } });
                                        const cs = yield tx.course.findUnique({ where: { id: r.courseId } });
                                        // Log Existing Data
                                        yield tx.log.create({ data: { action: `BACKLOG_${type}`, user: req.userId, student: r.indexno.trim(), meta: as } });
                                        // Upsert New Data
                                        return yield tx.assessment.upsert({
                                            where: {
                                                id: (_a = as === null || as === void 0 ? void 0 : as.id) !== null && _a !== void 0 ? _a : ''
                                            },
                                            create: {
                                                indexno: r.indexno.trim(),
                                                courseId: r.courseId,
                                                semesterNum: Number(r.semesterNum),
                                                classScore: r.scoreClass,
                                                examScore: r.scoreExam,
                                                totalScore: r.scoreTotal,
                                                type: r.scoreType,
                                                status: true,
                                                credit: cs === null || cs === void 0 ? void 0 : cs.creditHour,
                                                sessionId,
                                                schemeId
                                            },
                                            update: {
                                                semesterNum: Number(r.semesterNum),
                                                classScore: r.scoreClass,
                                                examScore: r.scoreExam,
                                                totalScore: r.scoreTotal,
                                                type: r.scoreType,
                                                credit: cs === null || cs === void 0 ? void 0 : cs.creditHour,
                                                schemeId
                                            },
                                        });
                                    }
                                    catch (recordError) {
                                        throw new BacklogRecordError((_b = r.indexno) === null || _b === void 0 ? void 0 : _b.trim(), (0, helper_1.friendlyDbError)(recordError));
                                    }
                                })));
                            }
                            else if (type == 'REGISTRATION') { // BACKLOG REGISTRATION
                                data = yield Promise.all(meta.map((r) => __awaiter(this, void 0, void 0, function* () {
                                    var _a;
                                    try {
                                        const cs = yield tx.course.findUnique({ where: { id: r.courseId } });
                                        return yield tx.assessment.create({
                                            data: {
                                                indexno: r.indexno.trim(),
                                                courseId: r.courseId,
                                                semesterNum: Number(r.semesterNum),
                                                type: r.scoreType,
                                                status: true,
                                                credit: cs === null || cs === void 0 ? void 0 : cs.creditHour,
                                                sessionId,
                                                schemeId
                                            }
                                        });
                                    }
                                    catch (recordError) {
                                        throw new BacklogRecordError((_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(), (0, helper_1.friendlyDbError)(recordError));
                                    }
                                })));
                            }
                            else if (type == 'DELETION') { // BACKLOG DELETION
                                data = yield Promise.all(meta.map((r) => __awaiter(this, void 0, void 0, function* () {
                                    var _a;
                                    try {
                                        const as = yield tx.assessment.findFirst({ where: { sessionId, courseId: r.courseId, indexno: r.indexno } });
                                        // Log Existing Data
                                        yield tx.log.create({ data: { action: `BACKLOG_${type}`, user: req.userId, student: r.indexno, meta: as } });
                                        // Delete Existing Data
                                        return yield tx.assessment.deleteMany({ where: { indexno: r.indexno, courseId: r.courseId, sessionId } });
                                    }
                                    catch (recordError) {
                                        throw new BacklogRecordError((_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(), (0, helper_1.friendlyDbError)(recordError));
                                    }
                                })));
                            }
                            const committed = { count: data === null || data === void 0 ? void 0 : data.length };
                            if (committed.count) {
                                // Update Backlog Status
                                yield tx.activityBacklog.update({ where: { id }, data: { approvedBy, status: true } });
                            }
                            return committed;
                        }));
                    }
                    catch (txError) {
                        if (txError instanceof BacklogRecordError) {
                            console.log(txError);
                            return res.status(400).json({
                                message: `Backlog not committed: record for student ${txError.indexno || 'unknown'} failed (${txError.reason}). No changes were saved — please fix this record and try again.`,
                                failedCount: 1,
                                totalCount: meta.length,
                                errors: [{ indexno: txError.indexno, reason: txError.reason }],
                            });
                        }
                        throw txError;
                    }
                    console.log(resp);
                    if (resp === null || resp === void 0 ? void 0 : resp.count) {
                        res.status(200).json({ success: true, data: resp });
                    }
                    else {
                        res.status(202).json({ message: `no records found` });
                    }
                }
                else
                    throw ("Invalid Backlog Id");
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    uploadBacklog(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const data = req.body;
                let resp;
                if (data === null || data === void 0 ? void 0 : data.length) {
                    const createdBy = req.userId;
                    let sessionId = data[0].sessionId, schemeId = data[0].schemeId;
                    let meta = [];
                    data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                        let { courseId, type, status, semesterNum, indexno, classScore, examScore, totalScore } = row;
                        indexno = indexno.trim();
                        courseId = courseId.trim();
                        schemeId = schemeId.trim();
                        type = type.trim();
                        semesterNum = +semesterNum;
                        classScore = classScore != '' ? parseFloat(classScore) : null;
                        examScore = examScore != '' ? parseFloat(examScore) : null;
                        totalScore = totalScore != '' ? parseFloat(totalScore) : null;
                        status = !!status;
                        meta.push({ indexno, courseId, semesterNum, scoreType: type, scoreClass: classScore, scoreExam: examScore, scoreTotal: totalScore });
                    }));
                    resp = yield ais.activityBacklog.create({
                        data: Object.assign(Object.assign(Object.assign({ title: `UPLOAD - ${(_a = (0, moment_1.default)().format('LLL')) === null || _a === void 0 ? void 0 : _a.toUpperCase()} - ${createdBy}`, type: `ASSESSMENT`, meta }, createdBy && ({ creator: { connect: { staffNo: createdBy } } })), sessionId && ({ session: { connect: { id: sessionId } } })), schemeId && ({ scheme: { connect: { id: schemeId } } })),
                    });
                }
                else
                    return resp;
                if (resp) {
                    console.log(resp);
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(202).json({ message: error.message });
            }
        });
    }
    // Exam Score Manager upload -- a narrower clone of uploadBacklog. The
    // sample/upload file only has exam score, sessionId, semesterNum,
    // courseId, indexno, and type (scoreType N/R): no classScore/totalScore
    // and no schemeId, since this never creates an assessment record, only
    // updates the examScore (and recomputed totalScore) on an existing one.
    // Stages a pending activityExam batch the same way uploadBacklog does;
    // approveExamScore commits it. `tag` is a free-text label the uploader
    // gives the batch (picked in the upload popup alongside the file), not
    // part of the sheet itself.
    uploadExamScore(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const { tag, rows } = req.body;
                let resp;
                if (rows === null || rows === void 0 ? void 0 : rows.length) {
                    const createdBy = req.userId;
                    let sessionId = rows[0].sessionId;
                    let meta = [];
                    rows === null || rows === void 0 ? void 0 : rows.map((row) => {
                        let { courseId, type, semesterNum, indexno, examScore } = row;
                        indexno = indexno.trim();
                        courseId = courseId.trim();
                        type = type.trim();
                        semesterNum = +semesterNum;
                        examScore = examScore != '' ? parseFloat(examScore) : null;
                        meta.push({ indexno, courseId, semesterNum, scoreType: type, scoreExam: examScore });
                    });
                    const overMax = meta.filter((r) => r.scoreExam != null && r.scoreExam > EXAM_SCORE_MAX);
                    if (overMax.length) {
                        const indexnos = [...new Set(overMax.map((r) => r.indexno))];
                        return res.status(400).json({
                            message: `Upload rejected: exam score exceeds the maximum of ${EXAM_SCORE_MAX} for ${overMax.length} of ${meta.length} student record(s): ${indexnos.join(', ')}.`,
                            failedCount: overMax.length,
                            totalCount: meta.length,
                            errors: indexnos.map((indexno) => ({ indexno, reason: `Exam score exceeds maximum of ${EXAM_SCORE_MAX}` })),
                        });
                    }
                    resp = yield ais.activityExam.create({
                        data: Object.assign(Object.assign({ title: `EXAM SCORE UPLOAD - ${(_a = (0, moment_1.default)().format('LLL')) === null || _a === void 0 ? void 0 : _a.toUpperCase()} - ${createdBy}`, tag: (tag === null || tag === void 0 ? void 0 : tag.trim()) || null, meta }, createdBy && ({ creator: { connect: { staffNo: createdBy } } })), sessionId && ({ session: { connect: { id: sessionId } } })),
                    });
                }
                else
                    return resp;
                if (resp) {
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(202).json({ message: error.message });
            }
        });
    }
    fetchExamScores(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                const where = Object.assign({}, keyword && ({
                    OR: [
                        { title: { contains: keyword } },
                        { session: { title: { contains: keyword } } },
                    ],
                }));
                if (Object.keys(where).length)
                    searchCondition = { where };
                const resp = yield ais.$transaction([
                    ais.activityExam.count(Object.assign({}, (searchCondition))),
                    ais.activityExam.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            session: true
                        } }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    return res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: resp[1],
                    });
                }
                else {
                    return res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchExamScore(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityExam.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    include: { session: true }
                });
                if (resp) {
                    // Flag rows with no matching assessment record (the row an
                    // approval actually updates) so the UI can highlight them before
                    // an approval attempt rejects the batch. Checking the `student`
                    // table here would be wrong: this module only updates existing
                    // assessment rows, which can outlive or predate a student record.
                    const meta = resp.meta || [];
                    if (meta.length) {
                        const existing = yield ais.assessment.findMany({
                            where: {
                                sessionId: resp.sessionId,
                                OR: meta.map((r) => {
                                    var _a;
                                    return ({
                                        courseId: r.courseId,
                                        semesterNum: Number(r.semesterNum),
                                        indexno: (_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(),
                                        type: r.scoreType,
                                    });
                                }),
                            },
                            select: { courseId: true, semesterNum: true, indexno: true, type: true },
                        });
                        const foundKeys = new Set(existing.map((a) => `${a.courseId}|${a.semesterNum}|${a.indexno}|${a.type}`));
                        resp.meta = meta.map((r) => { var _a; return (Object.assign(Object.assign({}, r), { studentExists: foundKeys.has(`${r.courseId}|${Number(r.semesterNum)}|${(_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim()}|${r.scoreType}`) })); });
                    }
                    return res.status(200).json(resp);
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    approveExamScore(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const approvedBy = req.userId;
                const rs = yield ais.activityExam.findUnique({
                    where: { id: (_a = req.body) === null || _a === void 0 ? void 0 : _a.examId },
                });
                if (rs) {
                    const { id, meta, sessionId } = rs;
                    // Validate the whole batch up front so a bad row fails cleanly
                    // instead of leaving the batch partially committed.
                    const missingExam = (meta || []).filter((r) => r.scoreExam === null || r.scoreExam === undefined || Number.isNaN(r.scoreExam));
                    if (missingExam.length) {
                        const indexnos = [...new Set(missingExam.map((r) => { var _a; return (_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(); }))];
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
                    const existing = yield ais.assessment.findMany({
                        where: {
                            sessionId,
                            OR: (meta || []).map((r) => {
                                var _a;
                                return ({
                                    courseId: r.courseId,
                                    semesterNum: Number(r.semesterNum),
                                    indexno: (_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(),
                                    type: r.scoreType,
                                });
                            }),
                        },
                        select: { courseId: true, semesterNum: true, indexno: true, type: true },
                    });
                    const foundKeys = new Set(existing.map((a) => `${a.courseId}|${a.semesterNum}|${a.indexno}|${a.type}`));
                    const missingRecords = (meta || []).filter((r) => { var _a; return !foundKeys.has(`${r.courseId}|${Number(r.semesterNum)}|${(_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim()}|${r.scoreType}`); });
                    if (missingRecords.length) {
                        const indexnos = [...new Set(missingRecords.map((r) => { var _a; return (_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(); }))];
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
                    let resp;
                    try {
                        resp = yield ais.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                            // Updates an existing assessment record only -- sessionId,
                            // courseId, semesterNum, indexno, and scoreType (N/R) are
                            // used purely to find/confirm the right row, never to
                            // create one. totalScore is always recomputed as
                            // classScore + examScore.
                            const data = yield Promise.all(meta.map((r) => __awaiter(this, void 0, void 0, function* () {
                                var _a, _b, _c, _d;
                                try {
                                    const as = yield tx.assessment.findFirst({ where: { sessionId, courseId: r.courseId, semesterNum: Number(r.semesterNum), indexno: r.indexno.trim(), type: r.scoreType } });
                                    if (!as)
                                        throw new BacklogRecordError((_a = r.indexno) === null || _a === void 0 ? void 0 : _a.trim(), 'No matching assessment record found for that session, course, semester, and assessment type');
                                    // Log Existing Data
                                    yield tx.log.create({ data: { action: `EXAM_SCORE`, user: req.userId, student: r.indexno.trim(), meta: as } });
                                    // Update Exam + Total Score
                                    const totalScore = ((_b = as.classScore) !== null && _b !== void 0 ? _b : 0) + ((_c = r.scoreExam) !== null && _c !== void 0 ? _c : 0);
                                    return yield tx.assessment.update({
                                        where: { id: as.id },
                                        data: { examScore: r.scoreExam, totalScore },
                                    });
                                }
                                catch (recordError) {
                                    if (recordError instanceof BacklogRecordError)
                                        throw recordError;
                                    throw new BacklogRecordError((_d = r.indexno) === null || _d === void 0 ? void 0 : _d.trim(), (0, helper_1.friendlyDbError)(recordError));
                                }
                            })));
                            const committed = { count: data === null || data === void 0 ? void 0 : data.length };
                            if (committed.count) {
                                // Update Batch Status
                                yield tx.activityExam.update({ where: { id }, data: { approvedBy, status: true } });
                            }
                            return committed;
                        }));
                    }
                    catch (txError) {
                        if (txError instanceof BacklogRecordError) {
                            console.log(txError);
                            return res.status(400).json({
                                message: `Batch not committed: record for student ${txError.indexno || 'unknown'} failed (${txError.reason}). No changes were saved — please fix this record and try again.`,
                                failedCount: 1,
                                totalCount: meta.length,
                                errors: [{ indexno: txError.indexno, reason: txError.reason }],
                            });
                        }
                        throw txError;
                    }
                    console.log(resp);
                    if (resp === null || resp === void 0 ? void 0 : resp.count) {
                        res.status(200).json({ success: true, data: resp });
                    }
                    else {
                        res.status(202).json({ message: `no records found` });
                    }
                }
                else
                    throw ("Invalid Exam Score Batch Id");
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // Edits a pending Exam Score batch's rows before it's committed. Mirrors
    // updateBacklog's flat-form -> meta[] shape, narrowed to this module's
    // fields (indexno, courseId, semesterNum, scoreType, scoreExam -- no
    // classScore/scoreTotal/schemeId). Rejected once the batch is approved,
    // since a committed batch's meta is the audit record of what was applied.
    updateExamScore(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const existing = yield ais.activityExam.findUnique({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                if (!existing)
                    return res.status(202).json({ message: `No records found` });
                if (existing.status)
                    return res.status(400).json({ message: `Batch already committed -- pending batches only can be edited.` });
                const { sessionId } = req.body;
                let meta = [];
                const metaNum = parseInt(req.body.metaNum);
                if (metaNum)
                    for (let i = 1; i <= metaNum; i++) {
                        const indexno = (_a = req.body[`${i}_indexno`]) === null || _a === void 0 ? void 0 : _a.trim();
                        const courseId = req.body[`${i}_courseId`];
                        const semesterNum = req.body[`${i}_semesterNum`];
                        const scoreType = req.body[`${i}_scoreType`];
                        const scoreExam = req.body[`${i}_scoreExam`] != '' ? parseFloat(req.body[`${i}_scoreExam`]) : null;
                        meta.push({ indexno, courseId, semesterNum: Number(semesterNum), scoreType, scoreExam });
                    }
                const overMax = meta.filter((r) => r.scoreExam != null && r.scoreExam > EXAM_SCORE_MAX);
                if (overMax.length) {
                    const indexnos = [...new Set(overMax.map((r) => r.indexno))];
                    return res.status(400).json({
                        message: `Not saved: exam score exceeds the maximum of ${EXAM_SCORE_MAX} for ${overMax.length} of ${meta.length} student record(s): ${indexnos.join(', ')}.`,
                        failedCount: overMax.length,
                        totalCount: meta.length,
                        errors: indexnos.map((indexno) => ({ indexno, reason: `Exam score exceeds maximum of ${EXAM_SCORE_MAX}` })),
                    });
                }
                const resp = yield ais.activityExam.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign({ meta }, sessionId && ({ session: { connect: { id: sessionId } } })),
                });
                if (resp) {
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postBacklog(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
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
                        const scoreClass = parseFloat(req.body[`${i}_scoreClass`]);
                        const scoreExam = parseFloat(req.body[`${i}_scoreExam`]);
                        const scoreTotal = parseFloat(req.body[`${i}_scoreTotal`]);
                        if (type == 'REGISTRATION')
                            meta.push({ indexno, courseId, semesterNum, scoreType });
                        else if (type == 'ASSESSMENT')
                            meta.push({ indexno, courseId, semesterNum, scoreType, scoreClass, scoreExam, scoreTotal });
                        else
                            meta.push({ indexno, courseId, semesterNum });
                    }
                const resp = yield ais.activityBacklog.create({
                    data: Object.assign(Object.assign(Object.assign({ title: `ENTRY - ${(_a = (0, moment_1.default)().format('LLL')) === null || _a === void 0 ? void 0 : _a.toUpperCase()} - ${createdBy}`, type,
                        meta }, createdBy && ({ creator: { connect: { staffNo: createdBy } } })), sessionId && ({ session: { connect: { id: sessionId } } })), schemeId && ({ scheme: { connect: { id: schemeId } } })),
                });
                if (resp) {
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateBacklog(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
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
                        const scoreClass = parseFloat(req.body[`${i}_scoreClass`]);
                        const scoreExam = parseFloat(req.body[`${i}_scoreExam`]);
                        const scoreTotal = parseFloat(req.body[`${i}_scoreTotal`]);
                        if (type == 'REGISTRATION')
                            meta.push({ indexno, courseId, semesterNum, scoreType });
                        else if (type == 'ASSESSMENT')
                            meta.push({ indexno, courseId, semesterNum, scoreType, scoreClass, scoreExam, scoreTotal });
                        else
                            meta.push({ indexno, courseId, semesterNum });
                    }
                const resp = yield ais.activityBacklog.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign({ 
                        // title,
                        type,
                        meta }, sessionId && ({ session: { connect: { id: sessionId } } })), schemeId && ({ scheme: { connect: { id: schemeId } } })),
                });
                if (resp) {
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteBacklog(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityBacklog.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Resit */
    fetchResits(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
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
                    };
                const resp = yield ais.$transaction([
                    ais.resit.count(Object.assign({}, (searchCondition))),
                    ais.resit.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            resitSession: true,
                            trailSession: true,
                            registerSession: true,
                            course: true,
                            student: { include: { program: true } },
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                return res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                // } else {
                //    return res.status(202).json({ message: `no records found` })
                // }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchResit(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.resit.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    include: { session: true }
                });
                if (resp) {
                    return res.status(200).json(resp);
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postResit(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const createdBy = req.userId;
                const { sessionId, schemeId, type, title } = req.body;
                const resp = yield ais.resit.create({
                    data: Object.assign(Object.assign(Object.assign({ title,
                        type }, createdBy && ({ creator: { connect: { staffNo: createdBy } } })), sessionId && ({ resitSession: { connect: { id: sessionId } } })), schemeId && ({ scheme: { connect: { id: schemeId } } })),
                });
                if (resp) {
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateResit(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const createdBy = req.userId;
                const { sessionId, schemeId, type, title } = req.body;
                const resp = yield ais.resit.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign({ title,
                        type }, createdBy && ({ creator: { connect: { staffNo: createdBy } } })), sessionId && ({ resitSession: { connect: { id: sessionId } } })), schemeId && ({ scheme: { connect: { id: schemeId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteResit(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.resit.delete({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Resit Session */
    fetchResitSessions(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                            ],
                        },
                    };
                const resp = yield ais.$transaction([
                    ais.resitSession.count(Object.assign({}, (searchCondition))),
                    ais.resitSession.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize) }))
                ]);
                //if(resp && resp[1]?.length){
                return res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                // } else {
                //    return res.status(202).json({ message: `no records found` })
                // }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchResitSessionsList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.resitSession.findMany({
                    orderBy: { createdAt: 'desc' }
                });
                // Return Response
                return res.status(200).json(resp);
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchResitSessionList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
            try {
                const resp = yield ais.resit.findMany({
                    where: Object.assign({ resitSessionId: (0, paramStr_1.paramStr)(req.params.id) }, (yield (0, resitScope_1.resitScopeWhere)(ais, req.roles, req.userId))),
                    include: { course: true, student: true, scheme: true }
                });
                if (resp.length) {
                    const grades = (_a = resp[0].scheme) === null || _a === void 0 ? void 0 : _a.gradeMeta;
                    const dm = yield Promise.all(resp.map((r) => __awaiter(this, void 0, void 0, function* () {
                        return (Object.assign(Object.assign({}, r), { grade: yield (0, helper_1.getGrade)(r === null || r === void 0 ? void 0 : r.totalScore, grades) }));
                    })));
                    let courseMap = new Map();
                    for (let d of dm) {
                        if (courseMap.has(`${(_b = d === null || d === void 0 ? void 0 : d.course) === null || _b === void 0 ? void 0 : _b.id} - ${(_c = d === null || d === void 0 ? void 0 : d.course) === null || _c === void 0 ? void 0 : _c.title}`)) {
                            let cs = courseMap.get(`${(_d = d === null || d === void 0 ? void 0 : d.course) === null || _d === void 0 ? void 0 : _d.id} - ${(_e = d === null || d === void 0 ? void 0 : d.course) === null || _e === void 0 ? void 0 : _e.title}`);
                            cs.push(d);
                            courseMap.set(`${(_f = d === null || d === void 0 ? void 0 : d.course) === null || _f === void 0 ? void 0 : _f.id} - ${(_g = d === null || d === void 0 ? void 0 : d.course) === null || _g === void 0 ? void 0 : _g.title}`, cs);
                        }
                        else {
                            courseMap.set(`${(_h = d === null || d === void 0 ? void 0 : d.course) === null || _h === void 0 ? void 0 : _h.id} - ${(_j = d === null || d === void 0 ? void 0 : d.course) === null || _j === void 0 ? void 0 : _j.title}`, [d]);
                        }
                    }
                    // Return Response
                    return res.status(200).json(Array.from(courseMap));
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // Lightweight per-course cards for the "My Resits" list — always the
    // active resit session (My Resits never lets an assessor pick an
    // arbitrary session), scoped to whichever courses the caller's
    // department owns via resitScopeWhere.
    fetchMyResitCourses(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            try {
                const activeSession = yield ais.resitSession.findFirst({ where: { default: true } });
                if (!activeSession)
                    return res.status(202).json({ message: `no active resit session found` });
                const resp = yield ais.resit.findMany({
                    where: Object.assign({ resitSessionId: activeSession.id }, (yield (0, resitScope_1.resitScopeWhere)(ais, req.roles, req.userId))),
                    include: { course: true }
                });
                if (resp.length) {
                    let courseMap = new Map();
                    for (let r of resp) {
                        const key = (_a = r === null || r === void 0 ? void 0 : r.course) === null || _a === void 0 ? void 0 : _a.id;
                        if (courseMap.has(key)) {
                            courseMap.get(key).count += 1;
                        }
                        else {
                            courseMap.set(key, { courseId: (_b = r === null || r === void 0 ? void 0 : r.course) === null || _b === void 0 ? void 0 : _b.id, courseTitle: (_c = r === null || r === void 0 ? void 0 : r.course) === null || _c === void 0 ? void 0 : _c.title, creditHour: (_d = r === null || r === void 0 ? void 0 : r.course) === null || _d === void 0 ? void 0 : _d.creditHour, count: 1 });
                        }
                    }
                    return res.status(200).json(Array.from(courseMap.values()));
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // Same row/grouping shape as fetchResitSessionList (Array.from(courseMap),
    // one [label, rows[]] tuple) so AISResitStudentCard/ScoreCard/CaptureCard
    // need no changes — just resolved against the active session and
    // narrowed to one course, so "My Resits" never needs a session id in
    // the URL at all.
    fetchMyResitCourseList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            try {
                const activeSession = yield ais.resitSession.findFirst({ where: { default: true } });
                if (!activeSession)
                    return res.status(202).json({ message: `no active resit session found` });
                const resp = yield ais.resit.findMany({
                    where: Object.assign({ resitSessionId: activeSession.id, courseId: (0, paramStr_1.paramStr)(req.params.courseId) }, (yield (0, resitScope_1.resitScopeWhere)(ais, req.roles, req.userId))),
                    include: { course: true, student: true, scheme: true }
                });
                if (resp.length) {
                    const grades = (_a = resp[0].scheme) === null || _a === void 0 ? void 0 : _a.gradeMeta;
                    const dm = yield Promise.all(resp.map((r) => __awaiter(this, void 0, void 0, function* () {
                        return (Object.assign(Object.assign({}, r), { grade: yield (0, helper_1.getGrade)(r === null || r === void 0 ? void 0 : r.totalScore, grades) }));
                    })));
                    let courseMap = new Map();
                    for (let d of dm) {
                        const key = `${(_b = d === null || d === void 0 ? void 0 : d.course) === null || _b === void 0 ? void 0 : _b.id} - ${(_c = d === null || d === void 0 ? void 0 : d.course) === null || _c === void 0 ? void 0 : _c.title}`;
                        if (courseMap.has(key)) {
                            courseMap.get(key).push(d);
                        }
                        else {
                            courseMap.set(key, [d]);
                        }
                    }
                    return res.status(200).json(Array.from(courseMap));
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchResitSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.resitSession.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp) {
                    return res.status(200).json(resp);
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    saveResitSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Fetch Active Semester
                const { count, data } = req.body;
                console.log(req.body);
                let mounts = [];
                let ids = [];
                let scored = [];
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
                    });
                    if (totalScore !== null)
                        scored.push({ id, totalScore });
                }
                // A non-admin assessor may only submit rows that belong to a
                // department they head — fail the whole batch closed if any one
                // row is out of scope, rather than silently applying the rest.
                const inScope = yield Promise.all(ids.map((id) => (0, resitScope_1.isResitInScope)(ais, id, req.roles, req.userId)));
                if (inScope.some((ok) => !ok)) {
                    return res.status(403).json({ message: `You do not have access to one or more of these resit records.` });
                }
                // Bulk Score Update
                const resp = yield Promise.all(mounts === null || mounts === void 0 ? void 0 : mounts.map((query) => __awaiter(this, void 0, void 0, function* () {
                    return yield ais.resit.updateMany(query);
                })));
                // Mirror the captured score into the assessment table (type: 'R')
                // so it surfaces wherever the rest of the system reads scores from
                // assessment (transcripts, broadsheets, GPA) — the resit table
                // alone is invisible everywhere outside this module.
                yield Promise.all(scored.map((_a) => __awaiter(this, [_a], void 0, function* ({ id, totalScore }) {
                    var _b;
                    const resit = yield ais.resit.findUnique({
                        where: { id },
                        select: { indexno: true, courseId: true, schemeId: true, semesterNum: true, trailSessionId: true, registerSessionId: true },
                    });
                    if (!resit || !resit.registerSessionId)
                        return;
                    const existing = yield ais.assessment.findFirst({
                        where: { indexno: resit.indexno, courseId: resit.courseId, sessionId: resit.registerSessionId, type: 'R' },
                    });
                    if (existing) {
                        yield ais.assessment.update({ where: { id: existing.id }, data: { totalScore, status: true } });
                    }
                    else {
                        // assessment has no credit of its own on `resit` — pull it
                        // from the original failing assessment row that produced
                        // this resit in the first place (closeSheet's upsert).
                        const original = yield ais.assessment.findFirst({
                            where: { indexno: resit.indexno, courseId: resit.courseId, sessionId: resit.trailSessionId, type: 'N' },
                            select: { credit: true },
                        });
                        yield ais.assessment.create({
                            data: {
                                indexno: resit.indexno,
                                courseId: resit.courseId,
                                sessionId: resit.registerSessionId,
                                schemeId: resit.schemeId,
                                semesterNum: resit.semesterNum,
                                credit: (_b = original === null || original === void 0 ? void 0 : original.credit) !== null && _b !== void 0 ? _b : 0,
                                type: 'R',
                                totalScore,
                                status: true,
                            },
                        });
                    }
                })));
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postResitSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.resitSession.create({
                    data: req.body,
                });
                if (resp) {
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateResitSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.resitSession.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: req.body,
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteResitSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.resitSession.delete({ where: { id: (0, paramStr_1.paramStr)(req.params.id) } });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Graduate Session */
    /* Graduate Session */
    fetchGraduateSessions(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                                { description: { contains: keyword } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.graduateSession.count(Object.assign({}, (searchCondition))),
                    ais.graduateSession.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            _count: {
                                select: { graduate: true }
                            }
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchGraduateSessionsList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduateSession.findMany();
                // Return Response
                return res.status(200).json(resp);
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchGraduateSessionList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f, _g, _h;
            try {
                const resp = yield ais.graduate.findMany({
                    where: { graduateSessionId: (0, paramStr_1.paramStr)(req.params.id) },
                    include: { student: { include: { program: true } } },
                    orderBy: {
                        student: { lname: 'asc' }
                    }
                });
                if (resp.length) {
                    const dm = resp;
                    let programMap = new Map();
                    for (let d of dm) {
                        if (programMap.has((_b = (_a = d === null || d === void 0 ? void 0 : d.student) === null || _a === void 0 ? void 0 : _a.program) === null || _b === void 0 ? void 0 : _b.longName)) {
                            let cs = programMap.get((_d = (_c = d === null || d === void 0 ? void 0 : d.student) === null || _c === void 0 ? void 0 : _c.program) === null || _d === void 0 ? void 0 : _d.longName);
                            cs.push(d);
                            programMap.set((_f = (_e = d === null || d === void 0 ? void 0 : d.student) === null || _e === void 0 ? void 0 : _e.program) === null || _f === void 0 ? void 0 : _f.longName, cs);
                        }
                        else {
                            programMap.set((_h = (_g = d === null || d === void 0 ? void 0 : d.student) === null || _g === void 0 ? void 0 : _g.program) === null || _h === void 0 ? void 0 : _h.longName, [d]);
                        }
                    }
                    // Return Response
                    return res.status(200).json(Array.from(programMap));
                }
                else {
                    res.status(202).json([]);
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    generateGraduateSessionList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduateSession.findFirst({ where: { default: true } });
                if (resp) {
                    // Delete + rebuild happen in one transaction — previously a
                    // failure partway through the Promise.all below (e.g. a DB
                    // connection hiccup) would leave the session's graduate list
                    // half-deleted with only some students re-upserted. A generous
                    // timeout since a full cohort's worth of per-student lookups can
                    // take a while; Prisma's interactive-transaction default (5s)
                    // would abort a real run well before it finishes.
                    yield ais.$transaction((tx) => __awaiter(this, void 0, void 0, function* () {
                        // Clean Graduates
                        yield tx.graduate.deleteMany({
                            where: { graduateSessionId: resp === null || resp === void 0 ? void 0 : resp.id }
                        });
                        // Fetch All students with Completed Status, Graduated Status with Program link
                        const sts = yield tx.student.findMany({
                            where: {
                                completeStatus: true,
                                graduateStatus: false,
                                indexno: { not: null },
                                semesterNum: 0
                            },
                            include: { program: true },
                        });
                        yield Promise.all(sts.map((st) => __awaiter(this, void 0, void 0, function* () {
                            var _a, _b, _c;
                            let verified = true;
                            let verifiedRemark = [];
                            let incompleteCount = 0;
                            // Get Credit Total — this stays "all attempted credit"
                            // (including IC courses) since it answers "has this student
                            // registered/attempted enough credit hours," not "how many
                            // are graded."
                            const as = yield tx.assessment.aggregate({ _sum: { credit: true }, where: { indexno: st.indexno } }); // Credit Total
                            // Get CGPA for Student
                            let ax = yield tx.assessment.findMany({ where: { indexno: st.indexno }, include: { scheme: true } });
                            // Only graded courses count toward CGPA — an IC (null
                            // totalScore) used to zero-fill into the average (silently
                            // scoring it as a fail) and its credit still sat in the
                            // denominator via as._sum.credit, dragging the CGPA down
                            // before staff ever saw the "IC Identified" flag. Track a
                            // separate gradedCredit total instead.
                            let gradedCredit = 0;
                            let az = ax.reduce((acc, r) => {
                                var _a;
                                // Check for IC
                                if (r.totalScore === undefined || r.totalScore == null) {
                                    incompleteCount += 1;
                                    return acc;
                                }
                                // Compute Gradepoint
                                const grades = (_a = r.scheme) === null || _a === void 0 ? void 0 : _a.gradeMeta;
                                const gv = (0, helper_1.getGradePoint)(r.totalScore, grades);
                                gradedCredit += r.credit;
                                return acc + (gv * r.credit);
                            }, 0);
                            const cgpa = (az / (gradedCredit || 1)).toFixed(2);
                            const classes = (ax === null || ax === void 0 ? void 0 : ax.length) ? (_a = ax[0].scheme) === null || _a === void 0 ? void 0 : _a.classMeta : null;
                            const graduateClass = (0, helper_1.getClass)(cgpa, classes);
                            // #1. Check From Resit Table, whether Student doesnt have Pending and Untaken Resits
                            const rs = yield tx.resit.count({ where: { indexno: st.indexno, taken: false } });
                            const isPassedResit = !Boolean(rs);
                            if (!isPassedResit) {
                                verified = false;
                                verifiedRemark.push(`Untaken Resit(s)`);
                            }
                            // #2. Check Whether Total Credit hours in assessment is greater or equal to Program Credit Minimum
                            const isPassedCreditTotal = (((_b = as === null || as === void 0 ? void 0 : as._sum) === null || _b === void 0 ? void 0 : _b.credit) || 0) >= ((_c = st === null || st === void 0 ? void 0 : st.program) === null || _c === void 0 ? void 0 : _c.creditTotal);
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
                            return yield tx.graduate.upsert({
                                where: { indexno: st === null || st === void 0 ? void 0 : st.indexno },
                                create: { cgpa, verified, verifiedRemark: verifiedRemark ? verifiedRemark === null || verifiedRemark === void 0 ? void 0 : verifiedRemark.join(", ") : null, class: graduateClass, indexno: st === null || st === void 0 ? void 0 : st.indexno, graduateSessionId: resp === null || resp === void 0 ? void 0 : resp.id },
                                update: { cgpa, verified, verifiedRemark: verifiedRemark ? verifiedRemark === null || verifiedRemark === void 0 ? void 0 : verifiedRemark.join(", ") : null, class: graduateClass }
                            });
                        })));
                    }), { timeout: 60000 });
                    // Return Response
                    return res.status(200).json(resp);
                }
                else {
                    return res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchGraduateSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduateSession.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postGraduateSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduateSession.create({
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateGraduateSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduateSession.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteGraduateSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduateSession.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Graduate */
    fetchGraduates(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
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
                    };
                const resp = yield ais.$transaction([
                    ais.graduate.count(Object.assign({}, (searchCondition))),
                    ais.graduate.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            student: { include: { program: true } },
                            graduateSession: true
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchGraduateList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduate.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchGraduate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduate.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    include: { program: true }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    uploadGraduate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = req.body;
                let resp;
                console.log("Data: ", data === null || data === void 0 ? void 0 : data.length);
                if (data === null || data === void 0 ? void 0 : data.length) {
                    let logs = [];
                    const certPrintedBy = req.userId;
                    let count = 0;
                    // for(let row of data){
                    yield Promise.all(data.map((row) => __awaiter(this, void 0, void 0, function* () {
                        var _a, _b, _c, _d, _e, _f;
                        let { certno: certNo, indexno, year, cgpa } = row;
                        // Log Record
                        logs.push({ indexno, graduateSession: `${year} GRADUATION ` });
                        // Get Student Data - Check If  student Exist
                        const st = yield ais.student.findFirst({
                            where: { indexno },
                            include: {
                                program: {
                                    include: {
                                        scheme: {
                                            select: { classMeta: true }
                                        }
                                    }
                                }
                            }
                        });
                        //console.log("st: ", !!st)
                        if (!st)
                            count += 1;
                        if (st === null || st === void 0 ? void 0 : st.indexno) {
                            console.log("st: ", !!st), st === null || st === void 0 ? void 0 : st.fname;
                            try {
                                let graduateSessionId;
                                const classes = ((_b = (_a = st === null || st === void 0 ? void 0 : st.program) === null || _a === void 0 ? void 0 : _a.scheme) === null || _b === void 0 ? void 0 : _b.classMeta) || null;
                                const graduateClass = (0, helper_1.getClass)(cgpa, classes);
                                // Upsert Graduation Session, 
                                const gs = yield ais.graduateSession.findFirst({ where: { title: `${year} GRADUATION` } });
                                if (gs) {
                                    graduateSessionId = gs === null || gs === void 0 ? void 0 : gs.id;
                                }
                                else {
                                    const insGs = yield ais.graduateSession.create({ data: { title: `${year} GRADUATION`, description: `${year} GRADUATION`, start: new Date(`${year}-11-15`), end: new Date(`${year}-11-20`), status: true, default: false } });
                                    console.log("insGs: ", insGs);
                                    graduateSessionId = insGs === null || insGs === void 0 ? void 0 : insGs.id;
                                }
                                // Update Graduation Data and Status
                                const gst = yield ais.graduate.upsert({
                                    where: { indexno: (_c = st === null || st === void 0 ? void 0 : st.indexno) === null || _c === void 0 ? void 0 : _c.trim() },
                                    create: { cgpa: String(cgpa), certNo: String(certNo), class: graduateClass, certPrinted: true, certPrintedAt: new Date(`${year}-11-01`), certPrintedBy, indexno: (_d = st === null || st === void 0 ? void 0 : st.indexno) === null || _d === void 0 ? void 0 : _d.trim(), graduateSessionId },
                                    update: { cgpa: String(cgpa), certNo: String(certNo), class: graduateClass }
                                });
                                if (gst) {
                                    // Remove from Log
                                    logs = logs === null || logs === void 0 ? void 0 : logs.filter((r) => r.indexno != indexno);
                                    // Update CGPA, Graduate Status, Complete Status in Student Model
                                    yield ais.student.update({ where: { id: st === null || st === void 0 ? void 0 : st.id }, data: { graduateStatus: true, completeStatus: true, completeType: 'GRADUATION' } });
                                }
                            }
                            catch (error) {
                                // Remove from Log
                                logs = logs === null || logs === void 0 ? void 0 : logs.filter((r) => r.indexno != indexno);
                                const lg = yield ais.graduateLog.upsert({
                                    where: { indexno_graduateSession: { indexno, graduateSession: `${year} GRADUATION` } },
                                    create: { indexno, graduateSession: `${year} GRADUATION`, reason: (_e = error === null || error === void 0 ? void 0 : error.code) === null || _e === void 0 ? void 0 : _e.toUpperCase() },
                                    update: { reason: (_f = error === null || error === void 0 ? void 0 : error.code) === null || _f === void 0 ? void 0 : _f.toUpperCase() }
                                });
                                console.log(`LOG ${indexno}: `, lg);
                            }
                        }
                        else {
                            // Remove from Log
                            logs = logs === null || logs === void 0 ? void 0 : logs.filter((r) => r.indexno != indexno);
                            // const lg = await ais.graduateLog.create({ data: { indexno, graduateSession: `${year} GRADUATION`, reason: `STUDENT NOT FOUND - CHECK INDEXNO`  }});
                            const lg = yield ais.graduateLog.upsert({
                                where: { indexno_graduateSession: { indexno, graduateSession: `${year} GRADUATION` } },
                                create: { indexno, graduateSession: `${year} GRADUATION`, reason: `STUDENT NOT FOUND` },
                                update: { reason: `STUDENT NOT FOUND` }
                            });
                            console.log(`LOG ${indexno}: `, lg);
                        }
                    })));
                    // 
                    console.log("MAIN LOGS: ", logs === null || logs === void 0 ? void 0 : logs.length);
                    // Commit Skipped Logs
                    yield Promise.all(logs.map((row) => __awaiter(this, void 0, void 0, function* () {
                        const lg = yield ais.graduateLog.upsert({
                            where: { indexno_graduateSession: { indexno: row.indexno, graduateSession: row.graduateSession } },
                            create: { indexno: row.indexno, graduateSession: row.graduateSession, reason: 'STUDENT SKIPPED' },
                            update: { reason: 'STUDENT SKIPPED' }
                        });
                        console.log(`MAIN LOG ${row.indexno}: `, lg);
                    })));
                    resp = data === null || data === void 0 ? void 0 : data.length;
                }
                if (resp) {
                    console.log(resp);
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log("Return Error", error.message);
                return res.status(202).json({ message: error.message });
            }
        });
    }
    uploadGraduateSupplement(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = req.body;
                let resp;
                console.log("Data: ", data === null || data === void 0 ? void 0 : data.length);
                if (data === null || data === void 0 ? void 0 : data.length) {
                    const certPrintedBy = req.userId;
                    let count = 0;
                    // for(let row of data){
                    yield Promise.all(data.map((row) => __awaiter(this, void 0, void 0, function* () {
                        let { indexno } = row;
                        const st = yield ais.student.updateMany({
                            where: { indexno: String(indexno) },
                            data: { graduateStatus: false }
                        });
                        if (st === null || st === void 0 ? void 0 : st.count)
                            count += 1;
                    })));
                    resp = count;
                }
                if (resp) {
                    return res.status(200).json({ success: true, data: resp });
                }
                else {
                    return res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log("Return Error", error.message);
                return res.status(202).json({ message: error.message });
            }
        });
    }
    excludeGraduate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            console.log("body: ", req.body);
            try {
                const resp = yield ais.student.updateMany({
                    where: {
                        indexno: (0, paramStr_1.paramStr)((_a = req === null || req === void 0 ? void 0 : req.params) === null || _a === void 0 ? void 0 : _a.id)
                    },
                    data: Object.assign({}, req.body)
                });
                console.log("resp: ", resp);
                if (resp) {
                    res.status(200).json({ success: true, data: resp });
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postGraduate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduate.create({
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateGraduate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduate.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteGraduate(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.graduate.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Academic Broadsheet */
    fetchBroadsheetOld(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const workbook = new ExcelJS.Workbook();
                const worksheet = workbook.addWorksheet('Final Year Broadsheet');
                let students = [], courseData = new Map();
                // Get Final and Completing Student
                let finalStudents = yield ais.$queryRaw `select s.fname,s.mname,s.lname,s.indexno,p.longName as program,semesterNum,s.completeStatus,s.deferStatus from ais_student s left join ais_program p on s.programId = p.id where s.semesterNum = p.semesterTotal`;
                const indexnos = finalStudents.filter((r) => r.indexno).map((r) => r.indexno);
                let results = yield ais.assessment.findMany({
                    where: { indexno: { in: indexnos } },
                    include: { course: true }
                });
                results.map((row) => {
                    var _a, _b, _c, _d;
                    if (courseData.has(`${(_a = row.course) === null || _a === void 0 ? void 0 : _a.title} (${row.courseId})`)) {
                        let courseRecs = courseData.get(`${(_b = row.course) === null || _b === void 0 ? void 0 : _b.title} (${row.courseId})`);
                        if (courseRecs[row.indexno])
                            courseRecs[row.indexno].push(row);
                        else
                            courseRecs[row.indexno] = [row];
                        courseData.set(`${(_c = row.course) === null || _c === void 0 ? void 0 : _c.title} (${row.courseId})`, courseRecs);
                    }
                    else {
                        let courseRecs = { [row.indexno]: [row] };
                        courseData.set(`${(_d = row.course) === null || _d === void 0 ? void 0 : _d.title} (${row.courseId})`, courseRecs);
                    }
                });
                students = finalStudents.map((row) => {
                    let studentData = {
                        'INDEX NUMBER': row.indexno,
                        'NAME OF STUDENT': row.fname + ' ' + (row.mname ? row.mname + ' ' : '') + row.lname,
                        'PROGRAM OF STUDY': row.program,
                    };
                    const cs = Object.keys(Object.fromEntries(courseData));
                    for (const key of cs) {
                        // const hasData:any = Array.from(courseData).map(([key, data]: any) => { console.log(Object.values(data)); return Object.values(data) }).flat(1).filter((r: any) => r.indexno == row.indexno && r.courseId == key);
                        const hasData = Array.from(courseData).map(([key, data]) => { console.log(Object.values(data)); return Object.values(data); }).flat(2);
                        // studentData[key] = hasData.length > 1 ? hasData.join(',') : hasData.length == 1 ? (hasData[0].totalScore || ''):'';
                        // studentData[key] = hasData.length > 0 ?  hasData[0].totalScore:'';
                        console.log('hasData: ', hasData);
                    }
                    return studentData;
                });
                // Excel Column names
                const columnNames = Object.keys(students[0]);
                worksheet.columns = columnNames.map((column) => ({ header: column, key: column }));
                // Excel Data
                students.map((student) => worksheet.addRow(student));
                console.log("results: ", Array.from(courseData));
                if (students) {
                    // Excel File
                    //   const buffer = await workbook.xlsx.writeBuffer();
                    const filename = 'Final Year Broadsheet.xlsx';
                    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                    res.setHeader('Content-Disposition', 'attachment; filename=' + filename);
                    // Write the workbook to the response stream
                    yield workbook.xlsx.write(res);
                    res.end();
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // VIEW SCRIPT:  create view broadsheet as select x.*,o.title,o.semester,o.year,o.createdAt as sessionCreatedAt,m.gradeMeta,m.classMeta,c.title as courseTitle,upper(s.fname) as fname,upper(s.mname) as mname,upper(s.lname) as lname,p.longName as program,p.shortName as programShortName,j.longName as major,j.shortName as majorShortName,p.stype,p.category,s.semesterNum as curSemesterNum,s.completeStatus,s.deferStatus,s.graduateStatus,s.gender,s.entryDate,s.programId,s.majorId,g.cgpa,g.class,s.id as studentId from ais_assessment x left join ais_course c on x.courseId = c.id left join ais_student s on s.indexno = x.indexno left join ais_program p on s.programId = p.id left join ais_major j on s.majorId = j.id left join ais_session o on x.sessionId = o.id left join ais_scheme m on x.schemeId = m.id left join ais_graduate g on s.indexno = g.indexno left join ais_graduate_session n on g.graduateSessionId = n.id where x.indexno in (select s.indexno from ais_student s left join ais_program p on s.programId = p.id where s.semesterNum = 0 and s.completeStatus = 1 order by s.programId,s.indexno,x.semesterNum);
    fetchBroadsheet(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const { program } = req.body;
                let students = [], courseData = new Map(), finalStudents = new Map();
                let results = yield ais.broadsheet.findMany({
                    where: Object.assign({}, (program && program != 'all' && ({ programId: program }))),
                    orderBy: [
                        { program: 'asc' },
                        { majorId: 'asc' },
                        { lname: 'asc' }
                    ]
                });
                results.map((row) => {
                    // Set Final Year Student Bio
                    if (!finalStudents.has(row.indexno))
                        finalStudents.set(row.indexno, { fname: row.fname, mname: row.mname, lname: row.lname, indexno: row.indexno, semesterNum: row.curSemesterNum, program: row.program, major: row.major, fgpa: row.cgpa, class: row.class });
                    // Set Course & Assessment Data
                    if (courseData.has(`${row.courseTitle} (${row.courseId})`)) {
                        let courseRecs = courseData.get(`${row.courseTitle} (${row.courseId})`);
                        if (courseRecs[row.indexno])
                            courseRecs[row.indexno].push(row);
                        else
                            courseRecs[row.indexno] = [row];
                        courseData.set(`${row.courseTitle} (${row.courseId})`, courseRecs);
                    }
                    else {
                        let courseRecs = { [row.indexno]: [row] };
                        courseData.set(`${row.courseTitle} (${row.courseId})`, courseRecs);
                    }
                });
                // Populate Final Year Broadsheet
                students = Object.keys(Object.fromEntries(finalStudents)).map((rowKey) => {
                    var _a, _b, _c;
                    const studentBio = finalStudents.get(rowKey);
                    let studentData = {
                        'INDEX NUMBER': studentBio.indexno,
                        'STUDENT NAME': studentBio.lname + ', ' + studentBio.fname + ' ' + (studentBio.mname ? studentBio.mname + ' ' : ''),
                        // 'SURNAME': studentBio.lname,
                        // 'OTHERNAME(S)': studentBio.fname + ' ' + (studentBio.mname ? studentBio.mname + ' ' : ''),
                        'STUDY PROGRAM': studentBio.program,
                        'STUDY MAJOR ': studentBio.major,
                        'FGPA': studentBio.fgpa,
                        'CLASS': studentBio.class,
                    };
                    const cs = Object.keys(Object.fromEntries(courseData));
                    for (const cskey of cs) {
                        const hasData2 = (_c = (_b = (_a = Array.from(courseData)) === null || _a === void 0 ? void 0 : _a.filter(([key, _]) => key == cskey)) === null || _b === void 0 ? void 0 : _b.map(([_, data]) => data)[0][rowKey]) !== null && _c !== void 0 ? _c : null;
                        studentData[cskey] = (hasData2 === null || hasData2 === void 0 ? void 0 : hasData2.length) ? hasData2.map((m) => m.totalScore).join(" | ") : '';
                    }
                    return studentData;
                });
                if (students) {
                    res.status(200).json({ type: (_a = req.body) === null || _a === void 0 ? void 0 : _a.type, data: students });
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Circulars */
    fetchNotices(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { reference: { contains: keyword } },
                                { title: { contains: keyword } },
                                { receiver: { contains: keyword } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.informer.count(Object.assign({}, (searchCondition))),
                    ais.informer.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize) }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    sendNotice(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.informer.findUnique({
                    where: { id: req.body.noticeId }
                });
                if (resp) {
                    let receivers = [];
                    if (resp.receiver == 'FRESHER') {
                        const rs = yield ais.student.findMany({
                            where: { completeStatus: false, deferStatus: false, phone: { not: null } },
                            select: { semesterNum: true, entrySemesterNum: true, phone: true },
                        });
                        receivers = rs === null || rs === void 0 ? void 0 : rs.filter((r) => ((r.semesterNum == r.entrySemesterNum) || (r.semesterNum == r.entrySemesterNum + 1))).map((r) => r === null || r === void 0 ? void 0 : r.phone);
                    }
                    else if (resp.receiver == 'FINAL') {
                        const rs = yield ais.student.findMany({
                            where: { completeStatus: false, deferStatus: false, phone: { not: null } },
                            select: { semesterNum: true, phone: true, program: { select: { semesterTotal: true } } },
                        });
                        receivers = rs === null || rs === void 0 ? void 0 : rs.filter((r) => ((r.semesterNum == r.program.semesterTotal) || (r.semesterNum == r.program.semesterTotal - 1))).map((r) => r === null || r === void 0 ? void 0 : r.phone);
                    }
                    else if (resp.receiver == 'STUDENT') {
                        const rs = yield ais.student.findMany({
                            where: { completeStatus: false, deferStatus: false, phone: { not: null } },
                            select: { phone: true },
                        });
                        receivers = rs === null || rs === void 0 ? void 0 : rs.map((r) => r === null || r === void 0 ? void 0 : r.phone);
                    }
                    else if (resp.receiver == 'UNDERGRAD') {
                        const rs = yield ais.student.findMany({
                            where: { completeStatus: false, deferStatus: false, program: { category: 'UG' }, phone: { not: null } },
                            select: { phone: true },
                        });
                        receivers = rs === null || rs === void 0 ? void 0 : rs.map((r) => r === null || r === void 0 ? void 0 : r.phone);
                    }
                    else if (resp.receiver == 'POSTGRAD') {
                        const rs = yield ais.student.findMany({
                            where: { completeStatus: false, deferStatus: false, program: { category: 'PG' }, phone: { not: null } },
                            select: { phone: true },
                        });
                        receivers = rs === null || rs === void 0 ? void 0 : rs.map((r) => r === null || r === void 0 ? void 0 : r.phone);
                    }
                    else if (resp.receiver == 'ALUMNI') {
                        const rs = yield ais.student.findMany({
                            where: { completeStatus: true, graduateStatus: true, phone: { not: null } },
                            select: { phone: true },
                        });
                        receivers = rs === null || rs === void 0 ? void 0 : rs.map((r) => r === null || r === void 0 ? void 0 : r.phone);
                    }
                    else if (resp.receiver == 'STAFF') {
                        const rs = yield ais.staff.findMany({
                            where: { status: true, phone: { not: null } },
                            select: { phone: true },
                        });
                        receivers = rs === null || rs === void 0 ? void 0 : rs.map((r) => r === null || r === void 0 ? void 0 : r.phone);
                    }
                    else if (resp.receiver == 'HOD') {
                        const rs = yield ais.unit.findMany({
                            where: { type: 'ACADEMIC', levelNum: 2 },
                            select: { phone: true, headStaffNo: true },
                        });
                        receivers = yield Promise.all(rs === null || rs === void 0 ? void 0 : rs.map((r) => __awaiter(this, void 0, void 0, function* () {
                            const st = yield ais.staff.findFirst({ where: { staffNo: r === null || r === void 0 ? void 0 : r.headStaffNo, phone: { not: null } } });
                            return st === null || st === void 0 ? void 0 : st.phone;
                        })));
                    }
                    else if (resp.receiver == 'DEAN') {
                        const rs = yield ais.unit.findMany({
                            where: { type: 'ACADEMIC', levelNum: 1 },
                            select: { phone: true, headStaffNo: true },
                        });
                        receivers = yield Promise.all(rs === null || rs === void 0 ? void 0 : rs.map((r) => __awaiter(this, void 0, void 0, function* () {
                            const st = yield ais.staff.findFirst({ where: { staffNo: r === null || r === void 0 ? void 0 : r.headStaffNo, phone: { not: null } } });
                            return st === null || st === void 0 ? void 0 : st.phone;
                        })));
                    }
                    else if (resp.receiver == 'ASSESSOR') {
                        const rs = yield ais.unit.findMany({
                            where: { type: 'ACADEMIC', levelNum: 1 },
                            select: { phone: true, headStaffNo: true },
                        });
                        receivers = yield Promise.all(rs === null || rs === void 0 ? void 0 : rs.map((r) => __awaiter(this, void 0, void 0, function* () {
                            const st = yield ais.staff.findFirst({ where: { staffNo: r === null || r === void 0 ? void 0 : r.headStaffNo, phone: { not: null } } });
                            return st === null || st === void 0 ? void 0 : st.phone;
                        })));
                    }
                    else if (resp.receiver == 'DEBTOR') {
                        const rs = yield ais.student.findMany({
                            where: { completeStatus: true, deferStatus: true, accountNet: { gt: 0 }, phone: { not: null } },
                            select: { phone: true },
                        });
                        receivers = rs === null || rs === void 0 ? void 0 : rs.map((r) => r === null || r === void 0 ? void 0 : r.phone);
                    }
                    // Clean Receivers phone numbers
                    const send = receivers === null || receivers === void 0 ? void 0 : receivers.map((phone) => __awaiter(this, void 0, void 0, function* () {
                        const mobile = phone.replace('-', '').replace(' ', '').replace('+233', '0').replace('.', '').replace('_', '');
                        console.log(mobile);
                        if ((mobile === null || mobile === void 0 ? void 0 : mobile.length) == 10 || (mobile === null || mobile === void 0 ? void 0 : mobile.length) == 11)
                            return yield sms(mobile, resp.smsContent);
                        return;
                    }));
                    // Return Response
                    res.status(200).json(send);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchNotice(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.informer.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postNotice(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.informer.create({
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateNotice(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.informer.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteNotice(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.informer.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Deferments */
    fetchDeferments(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { student: { id: { contains: keyword } } },
                                { student: { indexno: { contains: keyword } } },
                                { student: { fname: { contains: keyword } } },
                                { student: { lname: { contains: keyword } } },
                                { session: { title: { contains: keyword } } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.activityDefer.count(Object.assign({}, (searchCondition))),
                    ais.activityDefer.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            student: { include: { program: true } },
                            session: true
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchDefermentList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityDefer.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchDeferment(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let resp = yield ais.activityDefer.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    include: { student: { include: { program: true } }, session: true }
                });
                if (resp) {
                    // Calculate Resumption 
                    const year = Number((0, moment_1.default)(resp.letterDate).add(resp === null || resp === void 0 ? void 0 : resp.durationInYears, "years").format("YYYY"));
                    const academicYear = `${year}/${year + 1}`;
                    // Fetch Deferment Letter
                    const letter = yield ais.letter.findFirst({ where: { tag: resp.status == 'RESUMED' ? 'res' : 'def' } });
                    resp.letter = Object.assign(Object.assign({}, letter), { academicYear, student: resp === null || resp === void 0 ? void 0 : resp.student });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postDeferment(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { indexno, sessionId, semesterNum, reason, durationInYears, start, end, letterDate } = req.body;
                const resp = yield ais.activityDefer.create({
                    data: Object.assign(Object.assign({ semesterNum: Number(semesterNum), reason, durationInYears: Number(durationInYears), start,
                        end,
                        letterDate }, indexno && ({ student: { connect: { indexno } } })), sessionId && ({ session: { connect: { id: sessionId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateDeferment(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let { indexno, sessionId, semesterNum, reason, durationInYears, status, start, end, letterDate } = req.body;
                delete req.body.indexno;
                delete req.body.sessionId;
                let deferStatus = status == 'APPROVED' ? true : false;
                start = ['APPROVED', 'RESUMED'].includes(status) ? (start != null ? start : new Date()) : null;
                end = ['RESUMED'].includes(status) ? (end != null ? end : new Date()) : null;
                const resp = yield ais.activityDefer.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign({ semesterNum: Number(semesterNum), reason, durationInYears: Number(durationInYears), status,
                        start,
                        end,
                        letterDate }, indexno && ({ student: { connect: { indexno } } })), sessionId && ({ session: { connect: { id: sessionId } } }))
                });
                if (resp) {
                    // Update Student Status
                    yield ais.student.update({ where: { indexno }, data: { deferStatus } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    upgradeDeferment(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let { indexno, status } = req.body;
                let deferStatus = status == 'APPROVED' ? true : false;
                let start = ['APPROVED'].includes(status) ? new Date() : null;
                let end = ['RESUMED'].includes(status) ? new Date() : null;
                const resp = yield ais.activityDefer.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign({ status }, end && ({ end })), start && ({ start }))
                });
                if (resp) {
                    // Update Student Status
                    yield ais.student.update({ where: { indexno }, data: { deferStatus } });
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteDeferment(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.activityDefer.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Service Letters */
    fetchLetters(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { tag: { contains: keyword } },
                                { title: { contains: keyword } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.letter.count(Object.assign({}, (searchCondition))),
                    ais.letter.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize) }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchLetterList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.letter.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchLetter(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.letter.findFirst({
                    where: {
                        OR: [
                            { id: (0, paramStr_1.paramStr)(req.params.id) },
                            { tag: (0, paramStr_1.paramStr)(req.params.id) },
                        ]
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postLetter(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.letter.create({
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateLetter(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.letter.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteLetter(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.letter.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Transwift  */
    fetchTranswifts(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
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
                    };
                const resp = yield ais.$transaction([
                    ais.transwift.count(Object.assign({}, (searchCondition))),
                    ais.transwift.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), orderBy: { 'createdAt': 'desc' }, include: {
                            student: { include: { program: true } },
                            issuer: true,
                            transact: { include: { transtype: true } }
                        } }))
                ]);
                //if(resp && resp[1]?.length){
                res.status(200).json({
                    totalPages: (_a = Math.ceil(resp[0] / pageSize)) !== null && _a !== void 0 ? _a : 0,
                    totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                    data: resp[1],
                });
                //} else {
                //res.status(202).json({ message: `no records found` })
                //}
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchTranswiftList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.transwift.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchTranswiftByStudent(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.transwift.findMany({
                    where: { studentId: (0, paramStr_1.paramStr)(req.params.id) },
                    include: {
                        student: { include: { program: true } },
                        transact: { include: { transtype: true } }
                    },
                    orderBy: { 'createdAt': 'desc' }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchTranswift(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.transwift.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    include: {
                        student: { include: { program: true } },
                        issuer: true,
                        transact: { include: { transtype: true } }
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postTranswift(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.transwift.create({
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    upgradeTranswift(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const {} = req.body;
                const resp = yield ais.transwift.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateTranswift(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.transwift.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteTranswift(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.transwift.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Evaluations */
    fetchEvaluations(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const { page = 1, pageSize = 10, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            try {
                // Course-only — this view and EvaluationCardItem.tsx are entirely
                // course-oriented (a "COURSES: {count}" badge, print-slip link);
                // without this scoping, non-course (sts/ims) submissions would show
                // up here as phantom extra cards once students start completing them.
                let searchCondition = { where: { courseId: { not: null } } };
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
                const resp = yield ais.$transaction([
                    ais.courseEvaluation.groupBy(Object.assign({ by: ['sessionId', 'indexno'], _count: {
                            indexno: true
                        } }, (searchCondition))),
                    ais.courseEvaluation.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            student: { include: { program: true } },
                            session: true,
                        }, distinct: ['sessionId', 'indexno'], orderBy: { createdAt: 'desc' } }))
                ]);
                console.log('Evals: ', resp[0].length);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    console.log('Evals: ', resp);
                    res.status(200).json({
                        totalPages: Math.ceil(resp[0] / pageSize) || 0,
                        totalData: (_b = resp[1]) === null || _b === void 0 ? void 0 : _b.length,
                        data: resp[1]
                    });
                }
                else {
                    res.status(204).json({ message: "No evaluations found" });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* App Roles */
    fetchARoleList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let resp = yield ais.appRole.findMany({
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
                        { appModule: { app: { createdAt: 'asc' } } },
                        { appModule: { createdAt: 'asc' } },
                        { createdAt: 'asc' }
                    ]
                });
                if (resp) {
                    resp = resp.map((r) => {
                        var _a, _b, _c, _d, _e;
                        return ({
                            roleId: r === null || r === void 0 ? void 0 : r.id,
                            role: `${(_a = r.appModule) === null || _a === void 0 ? void 0 : _a.tag}::${(_b = r === null || r === void 0 ? void 0 : r.title) === null || _b === void 0 ? void 0 : _b.toLowerCase()}`,
                            roleDesc: r === null || r === void 0 ? void 0 : r.description,
                            module: (_c = r.appModule) === null || _c === void 0 ? void 0 : _c.tag,
                            app: (_e = (_d = r.appModule) === null || _d === void 0 ? void 0 : _d.app) === null || _e === void 0 ? void 0 : _e.tag
                        });
                    });
                    return res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* User Roles */
    fetchURoleList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { staffId } = req.body;
                let resp = yield ais.userRole.findMany({
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
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    resp = resp.map((r) => {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
                        return ({
                            id: r.id,
                            userId: r.userId,
                            roleId: (_a = r.appRole) === null || _a === void 0 ? void 0 : _a.id,
                            role: `${(_c = (_b = r.appRole) === null || _b === void 0 ? void 0 : _b.appModule) === null || _c === void 0 ? void 0 : _c.tag}::${(_e = (_d = r.appRole) === null || _d === void 0 ? void 0 : _d.title) === null || _e === void 0 ? void 0 : _e.toLowerCase()}`,
                            roleDesc: (_f = r.appRole) === null || _f === void 0 ? void 0 : _f.description,
                            module: (_h = (_g = r.appRole) === null || _g === void 0 ? void 0 : _g.appModule) === null || _h === void 0 ? void 0 : _h.tag,
                            app: (_l = (_k = (_j = r.appRole) === null || _j === void 0 ? void 0 : _j.appModule) === null || _k === void 0 ? void 0 : _k.app) === null || _l === void 0 ? void 0 : _l.tag
                        });
                    });
                    return res.status(200).json(resp);
                }
                else {
                    res.status(200).json([]);
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    fetchURoles(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            try {
                const where = keyword ? {
                    OR: [
                        { user: { tag: { contains: keyword } } },
                        { appRole: { title: { contains: keyword } } },
                    ],
                } : {};
                const [count, roles] = yield ais.$transaction([
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
                if (roles === null || roles === void 0 ? void 0 : roles.length) {
                    // Staff details aren't on the sso.user record itself, so batch-fetch
                    // them from hr.staff by tag and merge in.
                    const tags = [...new Set(roles.map((r) => { var _a; return (_a = r.user) === null || _a === void 0 ? void 0 : _a.tag; }).filter(Boolean))];
                    const staffList = tags.length
                        ? yield ais.staff.findMany({ where: { staffNo: { in: tags } }, select: { staffNo: true, fname: true, mname: true, lname: true, email: true } })
                        : [];
                    const staffMap = new Map(staffList.map((s) => [s.staffNo, s]));
                    const data = roles.map((r) => {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
                        const staff = staffMap.get((_a = r.user) === null || _a === void 0 ? void 0 : _a.tag);
                        return {
                            id: r.id,
                            tag: (_b = r.user) === null || _b === void 0 ? void 0 : _b.tag,
                            name: staff ? `${staff.fname} ${staff.mname ? staff.mname + ' ' : ''}${staff.lname}` : (_c = r.user) === null || _c === void 0 ? void 0 : _c.tag,
                            mail: staff === null || staff === void 0 ? void 0 : staff.email,
                            role: `${(_e = (_d = r.appRole) === null || _d === void 0 ? void 0 : _d.appModule) === null || _e === void 0 ? void 0 : _e.tag}::${(_g = (_f = r.appRole) === null || _f === void 0 ? void 0 : _f.title) === null || _g === void 0 ? void 0 : _g.toLowerCase()}`,
                            roleTitle: (_h = r.appRole) === null || _h === void 0 ? void 0 : _h.title,
                            roleDesc: (_j = r.appRole) === null || _j === void 0 ? void 0 : _j.description,
                            module: (_l = (_k = r.appRole) === null || _k === void 0 ? void 0 : _k.appModule) === null || _l === void 0 ? void 0 : _l.tag,
                            app: (_p = (_o = (_m = r.appRole) === null || _m === void 0 ? void 0 : _m.appModule) === null || _o === void 0 ? void 0 : _o.app) === null || _p === void 0 ? void 0 : _p.tag,
                            roleMeta: r.roleMeta,
                            createdAt: r.createdAt,
                        };
                    });
                    res.status(200).json({
                        totalPages: Math.ceil(count / pageSize) || 1,
                        totalData: count,
                        data,
                    });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchURole(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.userRole.findUnique({
                    where: {
                        id: Number((0, paramStr_1.paramStr)(req.params.id))
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postURole(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            try {
                const { appRoleId, staffNo } = req.body;
                delete req.body.appRoleId;
                delete req.body.staffNo;
                let resp;
                const user = yield ais.user.findFirst({ where: { tag: staffNo.toString() } });
                if (!user)
                    throw new Error(`No SSO account found for staff ${staffNo}`);
                const targetRole = yield ais.appRole.findUnique({
                    where: { id: Number(appRoleId) },
                    select: {
                        title: true,
                        appModule: { select: { tag: true, title: true } }
                    }
                });
                if (!targetRole)
                    throw new Error(`Selected role could not be found`);
                // A staff member may hold roles across many modules, but only one
                // role within any single module at a time (e.g. can't be both
                // student::admin and student::clerk simultaneously) — assigning a
                // second role in the same module must replace, not stack on top
                // of, the one already held there.
                const existingInModule = yield ais.userRole.findFirst({
                    where: {
                        userId: user.id,
                        appRole: { appModule: { tag: (_a = targetRole.appModule) === null || _a === void 0 ? void 0 : _a.tag } },
                    },
                    select: { appRole: { select: { title: true } } },
                });
                if (existingInModule) {
                    const moduleLabel = ((_b = targetRole.appModule) === null || _b === void 0 ? void 0 : _b.title) || ((_c = targetRole.appModule) === null || _c === void 0 ? void 0 : _c.tag);
                    throw new Error(`This staff member already holds the "${(_d = existingInModule.appRole) === null || _d === void 0 ? void 0 : _d.title}" role in the ${moduleLabel} module. Remove it before assigning "${targetRole.title}".`);
                }
                resp = yield ais.userRole.create({
                    data: Object.assign(Object.assign(Object.assign({ roleMeta: '' }, req.body), appRoleId && ({ appRole: { connect: { id: Number(appRoleId) } } })), { user: { connect: { id: user.id } } }),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateURole(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.userRole.update({
                    where: {
                        id: Number((0, paramStr_1.paramStr)(req.params.id))
                    },
                    data: Object.assign({}, req.body)
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteURole(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.userRole.delete({
                    where: { id: Number((0, paramStr_1.paramStr)(req.params.id)) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    checkUser(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { userId } = req.body;
                const resp = yield ais.user.findFirst({ where: { tag: userId === null || userId === void 0 ? void 0 : userId.toString() } });
                res.status(200).json(!!resp);
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Staff */
    fetchStaffs(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 6, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { staffNo: { contains: keyword } },
                                { fname: { contains: keyword } },
                                { lname: { contains: keyword } },
                                { phone: { contains: keyword } },
                                { email: { contains: keyword } },
                            ],
                        }
                    };
                const resp = yield ais.$transaction([
                    ais.staff.count(Object.assign({}, (searchCondition))),
                    ais.staff.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            title: { select: { label: true } },
                            country: { select: { longName: true } },
                            region: { select: { title: true } },
                            religion: { select: { title: true } },
                            marital: { select: { title: true } },
                            unit: { select: { title: true } },
                            job: { select: { title: true } },
                            //promotion:{ select: { job: { select: { title:true }}}},
                        } }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: resp[1],
                    });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchStaff(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.staff.findUnique({
                    where: {
                        staffNo: (0, paramStr_1.paramStr)(req.params.id)
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
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    stageStaff(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const { staffId } = req.body;
                const password = pwdgen();
                const st = yield ais.staff.findFirst({ where: { staffNo: staffId.toString() } });
                const isUser = yield ais.user.findFirst({ where: { tag: staffId.toString(), groupId: 2 } });
                if (isUser)
                    throw ("Staff User Account Exists!");
                const ssoData = { tag: staffId.toString(), username: (st === null || st === void 0 ? void 0 : st.instituteEmail) ? st === null || st === void 0 ? void 0 : st.instituteEmail.trim() : staffId.toString(), password: (0, password_1.hashPassword)(password) }; // Others
                // Populate SSO Account
                const resp = yield ais.user.create({
                    data: Object.assign(Object.assign({}, ssoData), { group: { connect: { id: 2 } } }),
                });
                if (resp) {
                    // Send Password By SMS
                    if (st === null || st === void 0 ? void 0 : st.phone)
                        yield sms(st === null || st === void 0 ? void 0 : st.phone, `Hi! Your new credentials are Username: ${(_a = st === null || st === void 0 ? void 0 : st.instituteEmail) !== null && _a !== void 0 ? _a : staffId}, Password: ${password}`);
                    // Send Password By Email
                    res.status(200).json(Object.assign(Object.assign({}, resp), { password }));
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    resetStaff(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const { staffId } = req.body;
                const password = pwdgen();
                const st = yield ais.staff.findFirst({ where: { staffNo: staffId.toString() } });
                const resp = yield ais.user.updateMany({
                    where: { tag: staffId.toString(), groupId: 2 },
                    data: { password: (0, password_1.hashPassword)(password) },
                });
                if (resp === null || resp === void 0 ? void 0 : resp.count) {
                    if (st === null || st === void 0 ? void 0 : st.phone)
                        yield sms(st === null || st === void 0 ? void 0 : st.phone, `Hi! Your credentials are Username: ${(_a = st === null || st === void 0 ? void 0 : st.instituteEmail) !== null && _a !== void 0 ? _a : staffId}, Password: ${password}`);
                    res.status(200).json({ password });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    staffRole(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { staffId } = req.body;
                const resp = yield ais.userRole.findMany({
                    where: { user: { tag: staffId.toString() } },
                    include: { appRole: { select: { title: true, appModule: { select: { app: true } } } } }
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp.map((r) => { var _a, _b, _c; return (Object.assign(Object.assign({}, r), { appRole: { title: (_a = r.appRole) === null || _a === void 0 ? void 0 : _a.title, app: (_c = (_b = r.appRole) === null || _b === void 0 ? void 0 : _b.appModule) === null || _c === void 0 ? void 0 : _c.app } })); }));
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    changeStaffPhoto(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { staffId } = req.body;
                const password = pwdgen();
                const resp = yield ais.user.updateMany({
                    where: { tag: staffId },
                    data: { password: (0, password_1.hashPassword)(password) },
                });
                if (resp) {
                    res.status(200).json({ password });
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: 'Internal server error' });
            }
        });
    }
    postStaff(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const st = yield ais.staff.findFirst({ where: { staffNo: { notIn: ['16000', '15666'] } }, orderBy: { 'staffNo': 'desc' } });
                const { titleId, maritalId, countryId, regionId, religionId, unitId, jobId } = req.body;
                req.body.staffNo = req.body.staffNo ? (_a = req.body.staffNo) === null || _a === void 0 ? void 0 : _a.toString() : (parseInt(st.staffNo) + 1).toString();
                delete req.body.titleId;
                delete req.body.maritalId;
                delete req.body.countryId;
                delete req.body.regionId;
                delete req.body.religionId;
                delete req.body.unitId;
                delete req.body.jobId;
                req.body.exitDate = req.body.exitDate ? (0, moment_1.default)(req.body.exitDate).toDate() : null;
                req.body.phone = req.body.phone ? req.body.phone : null;
                req.body.email = req.body.email ? req.body.email : null;
                req.body.ssnitNo = req.body.ssnitNo ? req.body.ssnitNo : null;
                req.body.ghcardNo = req.body.ghcardNo ? req.body.ghcardNo : null;
                const resp = yield ais.staff.create({
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), maritalId && ({ marital: { connect: { id: maritalId } } })), titleId && ({ title: { connect: { id: titleId } } })), countryId && ({ country: { connect: { id: countryId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), unitId && ({ unit: { connect: { id: unitId } } })), jobId && ({ job: { connect: { id: jobId } } }))
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateStaff(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            try {
                const st = yield ais.staff.findFirst({ where: { staffNo: { notIn: ['16000', '15666'] } }, orderBy: { 'staffNo': 'desc' } });
                const { titleId, maritalId, countryId, regionId, religionId, unitId, jobId, instituteEmail } = req.body;
                delete req.body.titleId;
                delete req.body.maritalId;
                delete req.body.countryId;
                delete req.body.regionId;
                delete req.body.religionId;
                delete req.body.unitId;
                delete req.body.jobId; //   
                req.body.staffNo = req.body.staffNo > 0 ? (_a = req.body.staffNo) === null || _a === void 0 ? void 0 : _a.toString() : (parseInt(st === null || st === void 0 ? void 0 : st.staffNo) + 1).toString();
                req.body.exitDate = req.body.exitDate ? (0, moment_1.default)(req.body.exitDate).toDate() : null;
                req.body.phone = req.body.phone ? req.body.phone : null;
                req.body.email = req.body.email ? req.body.email : null;
                req.body.ssnitNo = req.body.ssnitNo ? req.body.ssnitNo : null;
                req.body.ghcardNo = req.body.ghcardNo ? req.body.ghcardNo : null;
                const resp = yield ais.staff.update({
                    where: { staffNo: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), maritalId && ({ marital: { connect: { id: maritalId } } })), titleId && ({ title: { connect: { id: titleId } } })), countryId && ({ country: { connect: { id: countryId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), unitId && ({ unit: { connect: { id: unitId } } })), jobId && ({ job: { connect: { id: jobId } } }))
                });
                if (resp) {
                    if ((0, paramStr_1.paramStr)(req.params.id) != req.body.staffNo) {
                        // Update SSO User with New (Tag/Username)
                        yield ais.user.updateMany({ where: { tag: (0, paramStr_1.paramStr)(req.params.id), groupId: 2 }, data: { tag: req.body.staffNo, username: instituteEmail ? instituteEmail : (_b = req.body.staffNo) === null || _b === void 0 ? void 0 : _b.toString() } });
                        // Update Photo FileName
                        const tag = (_c = (0, paramStr_1.paramStr)(req.params.id)) === null || _c === void 0 ? void 0 : _c.toString().split("/").join("").trim().toLowerCase();
                        const dtag = req.body.staffNo.split("/").join("").trim().toLowerCase();
                        var file = path_1.default.join(__dirname, "/../../public/cdn/photo/staff/", tag + '.jpg');
                        var dfile = path_1.default.join(__dirname, "/../../public/cdn/photo/staff/", dtag + '.jpg');
                        var stats = fs_1.default.statSync(file);
                        if (stats)
                            fs_1.default.renameSync(file, dfile);
                    }
                    else {
                        // Update Email as tag in sso_user
                        if (instituteEmail)
                            yield ais.user.updateMany({ where: { tag: (0, paramStr_1.paramStr)(req.params.id) }, data: { username: instituteEmail } });
                    }
                    // Return Response
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteStaff(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Remove User Account
                yield ais.user.deleteMany({ where: { tag: (0, paramStr_1.paramStr)(req.params.id) } });
                // Hard Delete Staff Record
                const resp = yield ais.staff.delete({ where: { staffNo: (0, paramStr_1.paramStr)(req.params.id) } });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Helpers */
    fetchCountries(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.country.findMany({
                    where: { status: true },
                    orderBy: { createdAt: 'asc' }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchRegions(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.region.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchReligions(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.religion.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchDisabilities(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.disability.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchCategories(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.category.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchRelations(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.relation.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchMarital(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.marital.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchTitles(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.title.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchCollectors(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.collector.findMany();
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchAppRoles(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ais.appRole.findMany();
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    runData(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
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
                    res.status(200).json(vouchers);
                }
                else {
                    res.status(202).json({ message: `no record found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    runAccount(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let resp = [];
                const students = yield ais.student.findMany();
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
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    academicStatus(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const id = (0, paramStr_1.paramStr)(req.params.id);
                // Get Student Info
                const student = yield ais.student.findUnique({ include: { program: { select: { schemeId: true, hasMajor: true } } }, where: { id } });
                const indexno = student === null || student === void 0 ? void 0 : student.indexno;
                // Get Active Session Info -- no more MAIN/January-SUB stream split,
                // just the one default session.
                const session = yield ais.session.findFirst({ where: { default: true } });
                const assessment = yield ais.assessment.findFirst({ where: { sessionId: id, indexno } });
                const events = {
                    'medicals': { start: session.medicalStart, end: session.medicalEnd },
                    'orientation': { start: session.orientStart, end: session.orientEnd },
                    'matriculation': { start: session.matriculateStart, end: session.matriculateStart },
                    'registration': { start: session.registerStart, end: session.registerEndLate },
                    'examination': { start: session.examStart, end: session.examEnd },
                    'evaluation': { start: session.evaluationStart, end: session.evaluationEnd },
                };
                const event = Object.entries(events).find(([title, row]) => (0, moment_1.default)(new Date()).isBetween((0, moment_1.default)(row === null || row === void 0 ? void 0 : row.start), (0, moment_1.default)(row === null || row === void 0 ? void 0 : row.end)));
                return res.status(200).json({ success: true, data: { student, session, events, event, isRegistered: !!assessment } });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    nextClass(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                let resp = [];
                const students = yield ais.student.findMany();
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
}
exports.default = AisController;
