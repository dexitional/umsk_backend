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
const authModel_1 = __importDefault(require("../model/authModel"));
const evsModel_1 = __importDefault(require("../model/evsModel"));
const client_1 = require("../prisma/client");
// import { PrismaClient } from "../prisma/client";
const moment_1 = __importDefault(require("moment"));
const helper_1 = require("../util/helper");
const paramStr_1 = require("../util/paramStr");
const amsScope_1 = require("../util/amsScope");
const amsFileStorage_1 = require("../util/amsFileStorage");
const path = require('path');
const password_1 = require("../util/password");
const { customAlphabet } = require("nanoid");
const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwzyx", 8);
const pwdgen = customAlphabet("1234567890abcdefghijklmnopqrstuvwzyx", 6);
const digit = customAlphabet("1234567890", 4);
const sms = require('../config/sms');
const evs = new evsModel_1.default();
const Auth = new authModel_1.default();
const ams = client_1.prisma;
const SENDERID = process.env.UMS_SENDERID;
const DOMAIN = process.env.UMS_DOMAIN;
// Shared by fetchApplicantPreview (admin, :id-scoped, category-checked) and
// fetchMyApplicantPreview (self-service, req.userId-scoped, no check needed
// since it's always "me") — a plain function, not a class method, since
// AmsController's methods are passed to Express as detached references (no
// `.bind`); a `this.x()` call from inside another method would find `this`
// undefined at request time.
// Every application, regardless of applyType, walks the same fixed set of
// step tags — this used to be read from applicant.meta (a per-record copy
// of that same static list), but meta only exists on the *applicant* row,
// which is deleted once someone is shortlisted (see resolveApplicantCategory
// below), permanently breaking the preview for anyone past pure-applicant
// status. Reading it as a hardcoded list instead removes that dependency;
// a step nobody filled in just returns empty and is skipped below exactly
// as before, so this changes nothing for a still-in-progress applicant.
const APPLICANT_PREVIEW_STEPS = ['profile', 'guardian', 'education', 'result', 'choice', 'document', 'employment', 'referee'];
function buildApplicantPreview(serial) {
    return __awaiter(this, void 0, void 0, function* () {
        const output = new Map();
        for (const tag of APPLICANT_PREVIEW_STEPS) {
            if (tag == 'profile') {
                const res = yield ams.stepProfile.findUnique({ where: { serial }, include: { title: true, disability: true, religion: true, region: true, country: true, nationality: true, marital: true } });
                if (res)
                    output.set('profile', res);
            }
            if (tag == 'guardian') {
                const res = yield ams.stepGuardian.findUnique({ where: { serial }, include: { title: true, relation: true } });
                if (res)
                    output.set('guardian', res);
            }
            if (tag == 'education') {
                const res = yield ams.stepEducation.findMany({ where: { serial }, include: { instituteCategory: true, certCategory: true } });
                if (res === null || res === void 0 ? void 0 : res.length)
                    output.set('education', res);
            }
            if (tag == 'result') {
                const res = yield ams.stepResult.findMany({ where: { serial }, include: { certCategory: true, grades: { select: { gradeWeight: true, subject: { select: { title: true } } } } } });
                if (res === null || res === void 0 ? void 0 : res.length)
                    output.set('result', res);
            }
            if (tag == 'choice') {
                const res = yield ams.stepChoice.findMany({ where: { serial }, include: { program: true, major: true } });
                if (res === null || res === void 0 ? void 0 : res.length)
                    output.set('choice', res);
            }
            if (tag == 'document') {
                const res = yield ams.stepDocument.findMany({ where: { serial }, include: { documentCategory: true }, orderBy: { 'createdAt': 'asc' } });
                if (res === null || res === void 0 ? void 0 : res.length)
                    output.set('document', res);
            }
            if (tag == 'employment') {
                const res = yield ams.stepEmployment.findMany({ where: { serial }, orderBy: { 'createdAt': 'asc' } });
                if (res === null || res === void 0 ? void 0 : res.length)
                    output.set('employment', res);
            }
            if (tag == 'referee') {
                const res = yield ams.stepReferee.findMany({ where: { serial }, include: { title: true }, orderBy: { 'createdAt': 'asc' } });
                if (res === null || res === void 0 ? void 0 : res.length)
                    output.set('referee', res);
            }
        }
        return output.size ? Object.fromEntries(output) : null;
    });
}
// The applicant row itself is deleted once someone is shortlisted (their
// data moves onto sortedApplicant instead, which persists unchanged through
// admission — see postMatriculant, which only ever updates it, never
// deletes it). fetchApplicant/fetchApplicantPreview are shared by the
// applicant, shortlist, and matriculant-admin pages alike, so they need to
// find whichever of those two rows currently represents this serial to
// resolve a category for the UG/PG scope check, rather than assuming the
// applicant row is always still there.
function resolveApplicantCategory(serial) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        const applicant = yield ams.applicant.findFirst({ where: { serial }, select: { stage: { select: { categoryId: true } } } });
        if (applicant)
            return (_b = (_a = applicant.stage) === null || _a === void 0 ? void 0 : _a.categoryId) !== null && _b !== void 0 ? _b : null;
        const sorted = yield ams.sortedApplicant.findFirst({ where: { serial }, select: { categoryId: true } });
        if (sorted)
            return (_c = sorted.categoryId) !== null && _c !== void 0 ? _c : null;
        return null;
    });
}
class AmsController {
    /* Reports */
    // Route-gated to admreport::admin only (see amsRoute.ts) — that role has
    // full/unrestricted visibility across UG and PG alike, unlike every other
    // AMS role, which is why this never applies categoryScope/categoryWhere.
    loadReport(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { type, session, program } = req.body;
                const admissionCondition = session ? { admissionId: session } : { admission: { default: true } };
                let resp = { type };
                if (type == 'applicants') {
                    const rows = yield ams.applicant.findMany({
                        where: Object.assign(Object.assign({}, admissionCondition), (program && { choice: { programId: program } })),
                        include: { stage: true, applyType: true, choice: { include: { program: true } }, profile: true },
                        orderBy: { createdAt: 'desc' },
                    });
                    resp.data = rows.map((r) => {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
                        return ({
                            'SERIAL': r === null || r === void 0 ? void 0 : r.serial,
                            'LAST NAME': (_a = r === null || r === void 0 ? void 0 : r.profile) === null || _a === void 0 ? void 0 : _a.lname,
                            'FIRST NAME': (_b = r === null || r === void 0 ? void 0 : r.profile) === null || _b === void 0 ? void 0 : _b.fname,
                            'MIDDLE NAME(S)': (_c = r === null || r === void 0 ? void 0 : r.profile) === null || _c === void 0 ? void 0 : _c.mname,
                            'GENDER': (_d = r === null || r === void 0 ? void 0 : r.profile) === null || _d === void 0 ? void 0 : _d.gender,
                            'PHONE': (_e = r === null || r === void 0 ? void 0 : r.profile) === null || _e === void 0 ? void 0 : _e.phone,
                            'EMAIL': (_f = r === null || r === void 0 ? void 0 : r.profile) === null || _f === void 0 ? void 0 : _f.email,
                            'PROGRAM CHOICE': (_h = (_g = r === null || r === void 0 ? void 0 : r.choice) === null || _g === void 0 ? void 0 : _g.program) === null || _h === void 0 ? void 0 : _h.longName,
                            'ADMISSION GROUP': (_j = r === null || r === void 0 ? void 0 : r.stage) === null || _j === void 0 ? void 0 : _j.title,
                            'APPLY TYPE': (_k = r === null || r === void 0 ? void 0 : r.applyType) === null || _k === void 0 ? void 0 : _k.title,
                            'SUBMITTED': (r === null || r === void 0 ? void 0 : r.submitted) ? 'YES' : 'NO',
                            'SUBMITTED ON': r === null || r === void 0 ? void 0 : r.submittedAt,
                        });
                    });
                }
                else if (type == 'shortlisted') {
                    const rows = yield ams.sortedApplicant.findMany({
                        where: Object.assign(Object.assign({}, admissionCondition), (program && { OR: [{ choice1: { programId: program } }, { choice2: { programId: program } }] })),
                        include: { stage: true, applyType: true, category: true, choice1: { include: { program: true } }, choice2: { include: { program: true } }, profile: true },
                        orderBy: { createdAt: 'desc' },
                    });
                    resp.data = rows.map((r) => {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
                        return ({
                            'SERIAL': r === null || r === void 0 ? void 0 : r.serial,
                            'LAST NAME': (_a = r === null || r === void 0 ? void 0 : r.profile) === null || _a === void 0 ? void 0 : _a.lname,
                            'FIRST NAME': (_b = r === null || r === void 0 ? void 0 : r.profile) === null || _b === void 0 ? void 0 : _b.fname,
                            'MIDDLE NAME(S)': (_c = r === null || r === void 0 ? void 0 : r.profile) === null || _c === void 0 ? void 0 : _c.mname,
                            'GENDER': (_d = r === null || r === void 0 ? void 0 : r.profile) === null || _d === void 0 ? void 0 : _d.gender,
                            'CATEGORY': (_e = r === null || r === void 0 ? void 0 : r.category) === null || _e === void 0 ? void 0 : _e.title,
                            'FIRST CHOICE PROGRAM': (_g = (_f = r === null || r === void 0 ? void 0 : r.choice1) === null || _f === void 0 ? void 0 : _f.program) === null || _g === void 0 ? void 0 : _g.longName,
                            'SECOND CHOICE PROGRAM': (_j = (_h = r === null || r === void 0 ? void 0 : r.choice2) === null || _h === void 0 ? void 0 : _h.program) === null || _j === void 0 ? void 0 : _j.longName,
                            'ADMISSION GROUP': (_k = r === null || r === void 0 ? void 0 : r.stage) === null || _k === void 0 ? void 0 : _k.title,
                            'ADMITTED': (r === null || r === void 0 ? void 0 : r.admitted) ? 'YES' : 'NO',
                        });
                    });
                }
                else if (type == 'matriculants') {
                    const rows = yield ams.fresher.findMany({
                        where: Object.assign(Object.assign({}, admissionCondition), (program && { programId: program })),
                        include: { student: true, program: true, category: true },
                        orderBy: { createdAt: 'desc' },
                    });
                    resp.data = rows.map((r) => {
                        var _a, _b, _c, _d, _e, _f, _g;
                        return ({
                            'SERIAL': r === null || r === void 0 ? void 0 : r.serial,
                            'LAST NAME': (_a = r === null || r === void 0 ? void 0 : r.student) === null || _a === void 0 ? void 0 : _a.lname,
                            'FIRST NAME': (_b = r === null || r === void 0 ? void 0 : r.student) === null || _b === void 0 ? void 0 : _b.fname,
                            'MIDDLE NAME(S)': (_c = r === null || r === void 0 ? void 0 : r.student) === null || _c === void 0 ? void 0 : _c.mname,
                            'GENDER': (_d = r === null || r === void 0 ? void 0 : r.student) === null || _d === void 0 ? void 0 : _d.gender,
                            'INSTITUTIONAL EMAIL': (_e = r === null || r === void 0 ? void 0 : r.student) === null || _e === void 0 ? void 0 : _e.instituteEmail,
                            'PROGRAM': (_f = r === null || r === void 0 ? void 0 : r.program) === null || _f === void 0 ? void 0 : _f.longName,
                            'CATEGORY': (_g = r === null || r === void 0 ? void 0 : r.category) === null || _g === void 0 ? void 0 : _g.title,
                            'SESSION MODE': (r === null || r === void 0 ? void 0 : r.sessionMode) == 'E' ? 'EVENING' : (r === null || r === void 0 ? void 0 : r.sessionMode) == 'W' ? 'WEEKEND' : 'MORNING',
                            'YEAR': Math.ceil(((r === null || r === void 0 ? void 0 : r.semesterNum) || 1) / 2),
                        });
                    });
                }
                res.status(200).json(resp);
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
                const resp = yield ams.admission.findMany({ where: { status: true }, orderBy: { createdAt: 'asc' } });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchSessions(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                                { session: { title: { contains: keyword } } },
                            ],
                        }
                    };
                const resp = yield ams.$transaction([
                    ams.admission.count(Object.assign({}, (searchCondition))),
                    ams.admission.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            _count: { select: { voucher: true, sortedApplicant: true, fresher: true } }
                        }, orderBy: { 'createdAt': 'desc' } }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: resp[1],
                    });
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
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
                const resp = yield ams.admission.findUnique({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                });
                if (resp) {
                    res.status(200).json(resp);
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
    ActivateSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const ups = yield ams.admission.updateMany({
                    where: { id: { not: (0, paramStr_1.paramStr)(req.params.id) } },
                    data: { default: false },
                });
                const resp = yield ams.admission.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: { default: true },
                });
                if (ups && resp) {
                    res.status(200).json(resp);
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
    postSession(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { pgletterId, ugletterId, dpletterId, cpletterId, sessionId } = req.body;
                delete req.body.pgletterId;
                delete req.body.ugletterId;
                delete req.body.dpletterId;
                delete req.body.cpletterId;
                delete req.body.sessionId;
                const resp = yield ams.admission.create({
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), pgletterId && ({ pgletter: { connect: { id: pgletterId } } })), ugletterId && ({ ugletter: { connect: { id: ugletterId } } })), dpletterId && ({ dpletter: { connect: { id: dpletterId } } })), cpletterId && ({ cpletter: { connect: { id: cpletterId } } })), sessionId && ({ session: { connect: { id: sessionId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `no records found` });
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
                const { pgletterId, ugletterId, dpletterId, cpletterId, sessionId } = req.body;
                delete req.body.pgletterId;
                delete req.body.ugletterId;
                delete req.body.dpletterId;
                delete req.body.cpletterId;
                delete req.body.sessionId;
                const resp = yield ams.admission.update({
                    where: {
                        id: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), pgletterId && ({ pgletter: { connect: { id: pgletterId } } })), ugletterId && ({ ugletter: { connect: { id: ugletterId } } })), dpletterId && ({ dpletter: { connect: { id: dpletterId } } })), cpletterId && ({ cpletter: { connect: { id: cpletterId } } })), sessionId && ({ session: { connect: { id: sessionId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
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
                const resp = yield ams.admission.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Vouchers */
    fetchVoucherList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.voucher.findMany({ where: { status: true }, orderBy: { createdAt: 'asc' } });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchVouchers(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = { where: { admission: { default: true } } };
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            admission: { default: true },
                            OR: [
                                { category: { title: { contains: keyword } } },
                                { pin: { contains: keyword } },
                                { applicantName: { contains: keyword } },
                                { applicantPhone: { contains: keyword } },
                                { serial: { contains: keyword } },
                                { sellType: keyword == 'general' ? 0 : keyword == 'matured' ? 1 : keyword == 'international' ? 2 : null },
                            ],
                        }
                    };
                const resp = yield ams.$transaction([
                    ams.voucher.count(Object.assign({}, (searchCondition))),
                    ams.voucher.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), orderBy: [
                            { 'soldAt': 'desc' },
                            { 'sellType': 'asc' },
                        ], include: {
                            vendor: true,
                            admission: true,
                            category: true
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
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchVoucher(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.voucher.findUnique({
                    where: {
                        serial: (0, paramStr_1.paramStr)(req.params.id)
                    },
                    include: {
                        vendor: true,
                        admission: true,
                        category: true
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    sellVoucher(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { applicantPhone, applicantName } = req.body;
                const resp = yield ams.voucher.update({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                    data: { soldAt: new Date(), applicantName, applicantPhone, sold: true, soldBy: 'req.user' },
                });
                if (resp) {
                    const msg = `Hi, Your Serial: ${resp.serial}, Pin: ${resp.pin}, Goto the Unified Portal to apply. Thank you.`;
                    const sent = yield sms(resp.applicantPhone, msg, SENDERID);
                    res.status(200).json(resp);
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
    recoverVoucher(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.voucher.findUnique({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp) {
                    const msg = `Hi, Your Serial: ${resp.serial}, Pin: ${resp.pin}, Goto the Unified Portal to apply. Thank you.`;
                    const sent = yield sms(resp.applicantPhone, msg, SENDERID);
                    res.status(200).json(resp);
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
    postVoucher(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const admission = yield ams.admission.findFirst({ where: { default: true } });
                const voucher = yield ams.voucher.findFirst({ where: { admission: { default: true } }, orderBy: { 'createdAt': 'desc' } });
                const { vendorId, categoryId, sellType, quantity } = req.body;
                const lastIndex = voucher ? Number(voucher.serial) : admission === null || admission === void 0 ? void 0 : admission.voucherIndex;
                const admissionId = admission === null || admission === void 0 ? void 0 : admission.id;
                const data = [];
                let count = 0;
                if (quantity > 0) {
                    for (var i = 1; i <= quantity; i++) {
                        let dt = Object.assign(Object.assign(Object.assign({ serial: (_a = (lastIndex + i)) === null || _a === void 0 ? void 0 : _a.toString(), pin: nanoid(), sellType }, vendorId && ({ vendor: { connect: { id: vendorId } } })), categoryId && ({ category: { connect: { id: categoryId } } })), admissionId && ({ admission: { connect: { id: admissionId } } }));
                        data.push(dt);
                        const resp = yield ams.voucher.create({ data: dt });
                        if (resp)
                            count += 1;
                    }
                }
                // const resp = await ams.voucher.createMany({ data })
                if (count) {
                    res.status(200).json(count);
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
                // if(resp){
                //    res.status(200).json(resp)
                // } else {
                //    res.status(204).json({ message: `no records found` })
                // }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateVoucher(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                delete req.body.action;
                delete req.body.id;
                const resp = yield ams.voucher.update({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign({}, req.body),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteVoucher(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.voucher.updateMany({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                    data: {
                        soldAt: null,
                        applicantName: null,
                        applicantPhone: null
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Letters */
    fetchLetterList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.admissionLetter.findMany({ where: { status: true }, orderBy: { createdAt: 'asc' } });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchLetters(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            let searchCondition = {};
            try {
                if (keyword)
                    searchCondition = {
                        where: {
                            OR: [
                                { title: { contains: keyword } },
                                { category: { title: { contains: keyword } } },
                            ],
                        }
                    };
                const resp = yield ams.$transaction([
                    ams.admissionLetter.count(Object.assign({}, (searchCondition))),
                    ams.admissionLetter.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            category: true
                        }, orderBy: { 'createdAt': 'desc' } }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: resp[1],
                    });
                }
                else {
                    res.status(204).json({ message: `no records found` });
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
                const resp = yield ams.admissionLetter.findUnique({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    include: {
                        category: true,
                        // fresher: { include}
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    postLetter(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { categoryId } = req.body;
                delete req.body.categoryId;
                const resp = yield ams.admissionLetter.create({
                    data: Object.assign(Object.assign({}, req.body), categoryId && ({ category: { connect: { id: categoryId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `no records found` });
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
                const { categoryId } = req.body;
                delete req.body.categoryId;
                const resp = yield ams.admissionLetter.update({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign({}, req.body), categoryId && ({ category: { connect: { id: categoryId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
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
                const resp = yield ams.admissionLetter.delete({
                    where: { id: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Applicants */
    fetchApplicantList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.applicant.findMany({ where: { status: true }, orderBy: { createdAt: 'asc' } });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchApplicants(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            try {
                const sorted = yield ams.sortedApplicant.findMany({ where: { admission: { default: true } } });
                const ids = sorted.map((r) => (r.serial));
                // UG/PG scope is derived from the caller's role, never a client-
                // supplied query param — a ?group=postgrad on the URL used to be
                // trusted outright, letting a UG-scoped user view PG applicants.
                const groupCondition = { stage: (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'applicant')) };
                let searchCondition = {
                    where: Object.assign({ serial: { notIn: ids }, admission: { default: true } }, groupCondition)
                };
                if (keyword)
                    searchCondition = {
                        where: Object.assign(Object.assign({ serial: { notIn: ids }, admission: { default: true } }, groupCondition), { OR: [
                                { serial: { contains: keyword } },
                                { stage: { title: { contains: keyword } } },
                                { applyType: { title: { contains: keyword } } },
                            ] })
                    };
                const resp = yield ams.$transaction([
                    ams.applicant.count(Object.assign({}, (searchCondition))),
                    ams.applicant.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), 
                        //orderBy: { submittedAt:'desc'},
                        orderBy: { 'createdAt': 'desc' }, include: {
                            stage: { include: { category: true } },
                            applyType: true,
                            profile: true,
                            choice: { include: { program: true } },
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
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchApplicant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // This read-only lookup backs the application-form preview shown
                // from the applicant, shortlist, and matriculant pages alike — scope
                // it by whichever of those modules the caller holds a role in, not
                // just applicant:: (a shortlist/matriculant admin without an
                // applicant:: role would otherwise always get "no record found").
                const scope = (0, amsScope_1.categoryScopeAcross)(req.roles, ['applicant', 'shortlist', 'matriculant']);
                const serial = (0, paramStr_1.paramStr)(req.params.id);
                let resp = yield ams.applicant.findFirst({
                    where: { serial, stage: (0, amsScope_1.categoryWhere)(scope) },
                    include: { stage: true, applyType: true, choice: { include: { program: true } }, profile: { include: { title: true, region: true, country: true, religion: true, disability: true, marital: true } } }
                });
                // The applicant row is deleted once shortlisted — the same person's
                // data lives on sortedApplicant from that point on (see
                // resolveApplicantCategory's comment above). choice1 is mapped to
                // `choice` so callers (e.g. PgAMSShortlist.tsx) don't need to know
                // which table actually answered.
                if (!resp) {
                    const sorted = yield ams.sortedApplicant.findFirst({
                        where: Object.assign({ serial }, (0, amsScope_1.categoryWhere)(scope)),
                        include: { stage: true, applyType: true, choice1: { include: { program: true } }, profile: { include: { title: true, region: true, country: true, religion: true, disability: true, marital: true } } }
                    });
                    if (sorted)
                        resp = Object.assign(Object.assign({}, sorted), { choice: sorted.choice1 });
                }
                if (resp) {
                    res.status(200).json(resp);
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
    fetchApplicantPreview(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Same cross-module scoping as fetchApplicant above, since this
                // backs the same shared preview — resolveApplicantCategory checks
                // both the applicant and sortedApplicant tables so a shortlisted or
                // admitted person's category can still be found and scope-checked
                // even after their applicant row is gone.
                const previewScope = (0, amsScope_1.categoryScopeAcross)(req.roles, ['applicant', 'shortlist', 'matriculant']);
                const serial = (0, paramStr_1.paramStr)(req.params.id);
                const category = yield resolveApplicantCategory(serial);
                if (!category)
                    return res.status(204).json({ message: `no record found` });
                const inScope = previewScope === 'PG' ? category === 'PG' : previewScope === 'UG' ? category !== 'PG' : false;
                if (!inScope)
                    return res.status(204).json({ message: `no record found` });
                const output = yield buildApplicantPreview(serial);
                if (output)
                    res.status(200).json(output);
                else
                    res.status(204).json({ message: `no record found` });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // Self-service counterpart to fetchApplicant/fetchApplicantPreview above —
    // applicants log in with an empty roles array (authController.ts's
    // isApplicant branch), so the :id-based routes (staff-only, requireRole
    // APPLICANT_VIEW_ROLES) always 403 them out of their own record. These
    // derive identity from req.userId (set by verifyToken from the signed
    // token's own tag) instead of a client-supplied :id, so there's nothing to
    // category-scope — it's always the caller's own record.
    fetchMyApplicant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const serial = req.userId;
                let resp = yield ams.applicant.findFirst({
                    where: { serial },
                    include: { stage: true, applyType: true, choice: { include: { program: true } }, profile: { include: { title: true, region: true, country: true, religion: true, disability: true, marital: true } } }
                });
                // Same fallback as the admin fetchApplicant above — once shortlisted
                // (or admitted), the applicant row is gone but sortedApplicant still
                // has it, so an applicant checking their own portal after that point
                // isn't left with a blank record.
                if (!resp) {
                    const sorted = yield ams.sortedApplicant.findFirst({
                        where: { serial },
                        include: { stage: true, applyType: true, choice1: { include: { program: true } }, profile: { include: { title: true, region: true, country: true, religion: true, disability: true, marital: true } } }
                    });
                    if (sorted)
                        resp = Object.assign(Object.assign({}, sorted), { choice: sorted.choice1 });
                }
                if (resp) {
                    res.status(200).json(resp);
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
    fetchMyApplicantPreview(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const output = yield buildApplicantPreview(req.userId);
                if (output)
                    res.status(200).json(output);
                else
                    res.status(204).json({ message: `no record found` });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    postApplicant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { applyTypeId, stageId, choiceId } = req.body;
                delete req.body.stageId;
                delete req.body.applyTypeId;
                delete req.body.choiceId;
                if (stageId) {
                    const scope = (0, amsScope_1.categoryScope)(req.roles, 'applicant');
                    const stage = yield ams.stage.findUnique({ where: { id: stageId }, select: { categoryId: true } });
                    const inScope = scope === 'PG' ? (stage === null || stage === void 0 ? void 0 : stage.categoryId) === 'PG' : (stage === null || stage === void 0 ? void 0 : stage.categoryId) !== 'PG';
                    if (!inScope)
                        return res.status(403).json({ message: `You do not have access to create an applicant in this category.` });
                }
                const resp = yield ams.applicant.create({
                    data: Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), stageId && ({ stage: { connect: { id: stageId } } })), applyTypeId && ({ applyType: { connect: { id: applyTypeId } } })), choiceId && ({ choice: { connect: { id: choiceId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    updateApplicant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { applyTypeId, stageId, choiceId } = req.body;
                delete req.body.stageId;
                delete req.body.applyTypeId;
                delete req.body.choiceId;
                const existing = yield ams.applicant.findFirst({ where: { serial: (0, paramStr_1.paramStr)(req.params.id), stage: (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'applicant')) } });
                if (!existing)
                    return res.status(403).json({ message: `You do not have access to this applicant.` });
                const resp = yield ams.applicant.update({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), stageId && ({ stage: { connect: { id: stageId } } })), applyTypeId && ({ applyType: { connect: { id: applyTypeId } } })), choiceId && ({ choice: { connect: { id: choiceId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteApplicant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const existing = yield ams.applicant.findFirst({ where: { serial: (0, paramStr_1.paramStr)(req.params.id), stage: (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'applicant')) } });
                if (!existing)
                    return res.status(403).json({ message: `You do not have access to this applicant.` });
                const resp = yield ams.applicant.delete({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Shortlist */
    fetchShortlists(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            try {
                // Projected select — this previously pulled every column of every
                // admitted fresher just to build an exclusion-id list.
                const admitted = yield ams.fresher.findMany({ where: { admission: { default: true } }, select: { serial: true } });
                const ids = admitted.map((r) => (r.serial));
                // UG/PG scope is derived from the caller's role, never a client-
                // supplied query param (see fetchApplicants for the same fix).
                const groupCondition = (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'shortlist'));
                let searchCondition = {
                    where: Object.assign({ serial: { notIn: ids }, admission: { default: true } }, groupCondition)
                };
                if (keyword)
                    searchCondition = {
                        where: Object.assign(Object.assign({ serial: { notIn: ids }, admission: { default: true } }, groupCondition), { OR: [
                                { serial: { contains: keyword } },
                                { choice1: { program: { longName: { contains: keyword } } } },
                                { choice2: { program: { longName: { contains: keyword } } } },
                            ] })
                    };
                const resp = yield ams.$transaction([
                    ams.sortedApplicant.count(Object.assign({}, (searchCondition))),
                    ams.sortedApplicant.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), orderBy: { createdAt: 'desc' }, include: {
                            admission: true, choice1: { include: { program: true } }, choice2: { include: { program: true } }, profile: true, stage: true, applyType: true, category: true
                        } }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    // sortedApplicant has no declared relation back to applicant
                    // (they're correlated only by sharing `serial` as PK) — look up
                    // each row's submitted flag separately so the shortlist list can
                    // gate the "Admit" action on whether the applicant actually
                    // submitted their form.
                    const rows = resp[1];
                    const submissions = yield ams.applicant.findMany({
                        where: { serial: { in: rows.map((r) => r.serial) } },
                        select: { serial: true, submitted: true },
                    });
                    const submittedBySerial = new Map(submissions.map((a) => [a.serial, a.submitted]));
                    res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: rows.map((row) => { var _a; return (Object.assign(Object.assign({}, row), { submitted: (_a = submittedBySerial.get(row.serial)) !== null && _a !== void 0 ? _a : false })); }),
                    });
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchShortlist(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.sortedApplicant.findFirst({
                    where: Object.assign({ serial: (0, paramStr_1.paramStr)(req.params.id) }, (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'shortlist'))),
                    include: {
                        admission: true, choice1: { include: { program: true } }, choice2: { include: { program: true } }, profile: true, stage: true, applyType: true, category: true
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    // Self-service counterpart — the applicant portal (PgStepConfigure.tsx)
    // needs to know its own admitted/shortlisted status to decide which
    // action buttons to show, but applicants hold no shortlist:: role, so
    // the :id route above always 403s them. Same reasoning as
    // fetchMyApplicant/fetchMyApplicantPreview: identity from req.userId,
    // no category scope needed since it's always the caller's own record.
    fetchMyShortlist(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.sortedApplicant.findFirst({
                    where: { serial: req.userId },
                    include: {
                        admission: true, choice1: { include: { program: true } }, choice2: { include: { program: true } }, profile: true, stage: true, applyType: true, category: true
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    postShortlist(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const { serial } = req.body;
                const sorted = yield ams.sortedApplicant.findFirst({ where: { serial } });
                if (sorted)
                    throw ("Applicant already shortlisted!");
                const voucher = yield ams.voucher.findFirst({ where: { serial } });
                const admission = yield ams.admission.findFirst({ where: { default: true } });
                const applicant = yield ams.applicant.findFirst({ where: { serial }, include: { stage: true } });
                if (!applicant)
                    return res.status(204).json({ message: `no record found` });
                // The applicant page's UI already hides the "Shortlist" button until
                // the applicant has submitted, but that's a client-side convenience,
                // not a guarantee — enforce it here too, since the shortlist list
                // page's "Admit" action now assumes every shortlisted row was
                // actually submitted.
                if (!applicant.submitted)
                    return res.status(409).json({ message: `This applicant has not submitted their application form yet.` });
                // Shortlisting is triggered from the applicant page, so authorize
                // against the caller's applicant:: scope (whichever category it
                // covers), matching the applicant they're actually acting on.
                const appScope = (0, amsScope_1.categoryScope)(req.roles, 'applicant');
                const inScope = appScope === 'PG' ? ((_a = applicant.stage) === null || _a === void 0 ? void 0 : _a.categoryId) === 'PG' : ((_b = applicant.stage) === null || _b === void 0 ? void 0 : _b.categoryId) !== 'PG';
                if (!inScope)
                    return res.status(403).json({ message: `You do not have access to shortlist this applicant.` });
                const choice = yield ams.stepChoice.findFirst({ where: { serial, id: { not: applicant === null || applicant === void 0 ? void 0 : applicant.choiceId } } });
                //const education:any = await ams.stepEducation.findFirst({ where:{ serial  }})
                const { stageId, applyTypeId, classValue, gradeValue, stage: { categoryId }, choiceId: choice1Id } = applicant !== null && applicant !== void 0 ? applicant : null;
                const { id: admissionId } = admission !== null && admission !== void 0 ? admission : null;
                const { sellType } = voucher !== null && voucher !== void 0 ? voucher : null;
                const dt = { serial, sellType, classValue, gradeValue, admitted: false };
                const resp = yield ams.sortedApplicant.create({
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, dt), admissionId && ({ admission: { connect: { id: admissionId } } })), stageId && ({ stage: { connect: { id: stageId } } })), applyTypeId && ({ applyType: { connect: { id: applyTypeId } } })), choice1Id && ({ choice1: { connect: { id: choice1Id } } })), choice && ({ choice2: { connect: { id: choice === null || choice === void 0 ? void 0 : choice.id } } })), categoryId && ({ category: { connect: { id: categoryId } } })), serial && ({ profile: { connect: { serial } } })),
                });
                const ups = yield ams.applicant.update({
                    where: { serial },
                    data: { sorted: true }
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error });
            }
        });
    }
    updateShortlist(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { admissionId, stageId, applyTypeId, categoryId, choice1Id, choice2Id } = req.body;
                delete req.body.admissionId;
                delete req.body.stageId;
                delete req.body.applyTypeId;
                delete req.body.choice1Id;
                delete req.body.choice2Id;
                delete req.body.categoryId;
                const existing = yield ams.sortedApplicant.findFirst({ where: Object.assign({ serial: (0, paramStr_1.paramStr)(req.params.id) }, (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'shortlist'))) });
                if (!existing)
                    return res.status(403).json({ message: `You do not have access to this shortlist record.` });
                const resp = yield ams.sortedApplicant.update({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), admissionId && ({ admission: { connect: { id: admissionId } } })), stageId && ({ stage: { connect: { id: stageId } } })), applyTypeId && ({ applyType: { connect: { id: applyTypeId } } })), choice1Id && ({ choice1: { connect: { id: choice1Id } } })), choice2Id && ({ choice2: { connect: { id: choice2Id } } })), categoryId && ({ category: { connect: { id: categoryId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteShortlist(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const existing = yield ams.sortedApplicant.findFirst({ where: Object.assign({ serial: (0, paramStr_1.paramStr)(req.params.id) }, (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'shortlist'))) });
                if (!existing)
                    return res.status(403).json({ message: `You do not have access to this shortlist record.` });
                const resp = yield ams.sortedApplicant.delete({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) }
                });
                if (resp) {
                    const ups = yield ams.applicant.update({
                        where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                        data: { sorted: false }
                    });
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Matriculants */
    fetchMatriculantList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.fresher.findMany({ where: Object.assign({ admission: { default: true } }, (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'matriculant'))), orderBy: { createdAt: 'asc' } });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchMatriculants(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const { page = 1, pageSize = 9, keyword = '' } = req.query;
            const offset = (page - 1) * pageSize;
            // UG/PG scope is derived from the caller's role, never a client-
            // supplied query param (see fetchApplicants for the same fix).
            const groupCondition = (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'matriculant'));
            let searchCondition = {
                where: Object.assign({ admission: { default: true } }, groupCondition)
            };
            try {
                if (keyword)
                    searchCondition = {
                        where: Object.assign(Object.assign({ admission: { default: true } }, groupCondition), { OR: [
                                { serial: { contains: keyword } },
                                //{ sessionMode: { contains: keyword } },
                                { program: { shortName: { contains: keyword } } },
                                { category: { title: { contains: keyword } } },
                                { student: { fname: { contains: keyword } } },
                                { student: { mname: { contains: keyword } } },
                                { student: { lname: { contains: keyword } } },
                            ] })
                    };
                const resp = yield ams.$transaction([
                    ams.fresher.count(Object.assign({}, (searchCondition))),
                    ams.fresher.findMany(Object.assign(Object.assign({}, (searchCondition)), { skip: offset, take: Number(pageSize), include: {
                            admission: true, program: true, major: true, category: true, student: true
                        }, orderBy: { 'createdAt': 'desc' } }))
                ]);
                if (resp && ((_a = resp[1]) === null || _a === void 0 ? void 0 : _a.length)) {
                    res.status(200).json({
                        totalPages: (_b = Math.ceil(resp[0] / pageSize)) !== null && _b !== void 0 ? _b : 0,
                        totalData: (_c = resp[1]) === null || _c === void 0 ? void 0 : _c.length,
                        data: resp[1],
                    });
                }
                else {
                    res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    fetchMatriculant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.fresher.findFirst({
                    where: Object.assign({ serial: (0, paramStr_1.paramStr)(req.params.id) }, (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'matriculant'))),
                    include: {
                        admission: {
                            include: {
                                sortedApplicant: {
                                    include: { applyType: true }
                                }
                            }
                        },
                        student: true,
                        program: true,
                        bill: {
                            include: {
                                bankacc: true
                            }
                        },
                        session: true,
                        letter: true,
                        category: true
                    }
                });
                if (resp) {
                    console.log(resp);
                    res.status(200).json(resp);
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
    // Self-service counterpart — PgStepPrintLetter.tsx (the applicant
    // portal's "Print Admission Letter" page) needs the caller's own
    // matriculant/letter record, but applicants hold no matriculant:: role,
    // so the :id route above always 403s them. Same reasoning as the other
    // fetchMy* methods: identity from req.userId, no category scope needed.
    fetchMyMatriculant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.fresher.findFirst({
                    where: { serial: req.userId },
                    include: {
                        admission: {
                            include: {
                                sortedApplicant: {
                                    include: { applyType: true }
                                }
                            }
                        },
                        student: true,
                        program: true,
                        bill: {
                            include: {
                                bankacc: true
                            }
                        },
                        session: true,
                        letter: true,
                        category: true
                    }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    postMatriculant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { serial, programId, semesterNum, sessionMode } = req.body;
                // getBillCodePrisma silently returns undefined for an unrecognized
                // semesterNum, which would drop the OR filter below and match
                // whichever bill happens to come back first for this program —
                // wrong bill picked with no error, rather than an obvious failure.
                if (!programId || ![1, 3, 5].includes(Number(semesterNum)) || !sessionMode) {
                    return res.status(422).json({ message: `Programme, entry year and session must all be selected before admitting.` });
                }
                const sorted = yield ams.sortedApplicant.findFirst({ where: { serial }, include: { profile: true, admission: { include: { session: true } } } });
                if (!sorted)
                    return res.status(404).json({ message: `no record found` });
                // Re-running this endpoint on an already-admitted applicant would
                // silently upsert over their student record and regenerate a new
                // password below — block it instead of quietly resetting a live
                // student's credentials.
                if (sorted.admitted) {
                    return res.status(409).json({ message: `This applicant has already been admitted. Re-processing would reset their student account credentials.` });
                }
                // Admitting is triggered from either the matriculant module itself
                // or a shortlist admin's "Admit" action — accept whichever scope
                // the caller holds, matched against the shortlisted applicant's
                // own category.
                const inScope = (scope) => scope === 'PG' ? sorted.categoryId === 'PG' : scope === 'UG' ? sorted.categoryId !== 'PG' : false;
                if (!inScope((0, amsScope_1.categoryScope)(req.roles, 'matriculant')) && !inScope((0, amsScope_1.categoryScope)(req.roles, 'shortlist'))) {
                    return res.status(403).json({ message: `You do not have access to admit this applicant.` });
                }
                // Every field below is read via direct destructuring/replaceAll further
                // down — an applicant admitted before finishing every step (or whose
                // linked admission/session was since deleted) would otherwise crash
                // with a raw "Cannot read properties of null" instead of telling the
                // admin what's actually missing on this applicant's record.
                if (!sorted.admission) {
                    return res.status(422).json({ message: `This applicant's admission record is missing — cannot determine session or letter details. Contact IT support.` });
                }
                if (!sorted.admission.session) {
                    return res.status(422).json({ message: `The academic session linked to this applicant's admission is missing or was deleted.` });
                }
                if (!sorted.profile) {
                    return res.status(422).json({ message: `This applicant has not completed the Personal Information step — required before admission.` });
                }
                let { sellType, admission: { id: admissionId, session: { id: sessionId }, admittedAt }, categoryId, profile: { titleId, countryId, regionId, religionId, disabilityId, maritalId, fname, lname, mname, gender, dob, hometown, phone, email, residentAddress } } = sorted !== null && sorted !== void 0 ? sorted : null;
                const letterId = sorted === null || sorted === void 0 ? void 0 : sorted.admission[`${categoryId === null || categoryId === void 0 ? void 0 : categoryId.toLowerCase()}letterId`];
                if (!phone) {
                    return res.status(422).json({ message: `This applicant's phone number is missing — required to generate their account and send notifications.` });
                }
                if (!fname || !lname) {
                    return res.status(422).json({ message: `This applicant's name is incomplete — required to generate their institutional email.` });
                }
                // Bill Info
                const semcode = (0, helper_1.getBillCodePrisma)(Number(semesterNum));
                const feeType = countryId == '96b0a1d5-7899-4b9a-bcbe-7a72eee6572c' ? 'GH' : 'INT';
                const bill = yield ams.bill.findFirst({ where: { programId, sessionId, type: feeType, OR: semcode } });
                if (!bill) {
                    const yearLabel = { 1: 'Year 1', 3: 'Year 2', 5: 'Year 3' }[Number(semesterNum)] || `semester ${semesterNum}`;
                    return res.status(422).json({ message: `No fee bill has been configured for this programme (${yearLabel}, ${feeType === 'GH' ? 'Ghanaian' : 'International'} fees) in the ${sorted.admission.session.title || 'selected'} session. Set up billing for this programme before admitting.` });
                }
                // Emergency & Guardian Info
                let guardian = yield ams.stepGuardian.findFirst({ where: { serial } });
                if (!guardian) {
                    return res.status(422).json({ message: `This applicant has not completed the Guardian Information step — required before admission.` });
                }
                if (!guardian.phone) {
                    return res.status(422).json({ message: `This applicant's guardian phone number is missing.` });
                }
                // Check email
                let count = 1;
                let isNew = true;
                let uname = `${fname === null || fname === void 0 ? void 0 : fname.replaceAll(' ', '')}.${lname}`.toLowerCase();
                while (isNew) {
                    const ck = yield ams.student.findFirst({ where: { instituteEmail: { startsWith: `${uname}${count > 1 ? count : ''}` } } });
                    if (ck)
                        count = count + 1;
                    else
                        isNew = false;
                }
                const instituteEmail = `${uname}@${process.env.UMS_MAIL}`;
                // Data for Population
                const username = instituteEmail; // AUCB
                // const username = serial;  // MLK & Others
                // Sanitize Data
                phone = phone.replaceAll(' ', '');
                phone = phone.replaceAll('-', '');
                phone = phone.replaceAll('(', '');
                phone = phone.replaceAll(')', '');
                phone = phone.replaceAll('+2330', '0');
                phone = phone.replaceAll('+233', '0');
                phone = phone.replaceAll('2330', '0');
                phone = phone.replaceAll('233', '0');
                guardian.phone = guardian.phone.replaceAll(' ', '');
                guardian.phone = guardian.phone.replaceAll('-', '');
                guardian.phone = guardian.phone.replaceAll('(', '');
                guardian.phone = guardian.phone.replaceAll(')', '');
                guardian.phone = guardian.phone.replaceAll('+2330', '0');
                guardian.phone = guardian.phone.replaceAll('+233', '0');
                guardian.phone = guardian.phone.replaceAll('2330', '0');
                guardian.phone = guardian.phone.replaceAll('233', '0');
                // Populate Data
                const password = pwdgen();
                const studentData = { id: serial, fname, mname, lname, gender, dob, semesterNum, entrySemesterNum: semesterNum, entryDate: admittedAt, hometown, phone, email, address: residentAddress, instituteEmail, guardianName: `${guardian === null || guardian === void 0 ? void 0 : guardian.fname} ${(guardian === null || guardian === void 0 ? void 0 : guardian.mname) && (guardian === null || guardian === void 0 ? void 0 : guardian.mname) + ' '}${guardian === null || guardian === void 0 ? void 0 : guardian.lname}`, guardianPhone: guardian === null || guardian === void 0 ? void 0 : guardian.phone };
                const fresherData = { sellType, semesterNum, sessionMode, username, password };
                const ssoData = { tag: serial, username: instituteEmail, password: (0, password_1.hashPassword)(password), }; // AUCC
                //const ssoData = { tag:serial, username, password:sha1(password) }  // MLK & Others
                // Populate Student Information
                const resp = yield ams.student.upsert({
                    where: { id: serial },
                    update: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, studentData), programId && ({ program: { connect: { id: programId } } })), titleId && ({ title: { connect: { id: titleId } } })), countryId && ({ country: { connect: { id: countryId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), maritalId && ({ marital: { connect: { id: maritalId } } })), disabilityId && ({ disability: { connect: { id: disabilityId } } })),
                    create: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, studentData), programId && ({ program: { connect: { id: programId } } })), titleId && ({ title: { connect: { id: titleId } } })), countryId && ({ country: { connect: { id: countryId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), maritalId && ({ marital: { connect: { id: maritalId } } })), disabilityId && ({ disability: { connect: { id: disabilityId } } }))
                });
                if (resp) {
                    // Populate SSO Account
                    yield ams.user.upsert({
                        where: { tag: serial },
                        create: Object.assign(Object.assign({}, ssoData), { group: { connect: { id: 1 } } }),
                        update: Object.assign(Object.assign({}, ssoData), { group: { connect: { id: 1 } } }),
                    });
                    // Populate Fresher Information
                    yield ams.fresher.upsert({
                        where: { serial },
                        update: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, fresherData), admissionId && ({ admission: { connect: { id: admissionId } } })), programId && ({ program: { connect: { id: programId } } })), bill && ({ bill: { connect: { id: bill === null || bill === void 0 ? void 0 : bill.id } } })), sessionId && ({ session: { connect: { id: sessionId } } })), categoryId && ({ category: { connect: { id: categoryId } } })), serial && ({ student: { connect: { id: serial } } })), letterId && ({ letter: { connect: { id: letterId } } })),
                        create: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, fresherData), admissionId && ({ admission: { connect: { id: admissionId } } })), programId && ({ program: { connect: { id: programId } } })), bill && ({ bill: { connect: { id: bill === null || bill === void 0 ? void 0 : bill.id } } })), sessionId && ({ session: { connect: { id: sessionId } } })), categoryId && ({ category: { connect: { id: categoryId } } })), serial && ({ student: { connect: { id: serial } } })), letterId && ({ letter: { connect: { id: letterId } } }))
                    });
                    // Update Applicant Status 
                    yield ams.sortedApplicant.update({
                        where: { serial },
                        data: { admitted: true },
                    });
                    // Send Applicant Notification — isolated so a gateway hiccup can't
                    // turn an admission that already fully succeeded (student/user/
                    // fresher created, admitted flag flipped) into a reported error.
                    try {
                        const msg = `Congratulations ${studentData === null || studentData === void 0 ? void 0 : studentData.fname}! You have been admitted into AUCB, Kindly visit https://portal.aucb.edu.gh to print your admission letter. Thank you!`;
                        yield sms(phone, msg);
                    }
                    catch (smsError) {
                        console.log('postMatriculant SMS send failed:', smsError === null || smsError === void 0 ? void 0 : smsError.message);
                    }
                    // Return Response
                    return res.status(200).json(resp);
                }
                else {
                    return res.status(204).json({ message: `no records found` });
                }
            }
            catch (error) {
                console.log(error === null || error === void 0 ? void 0 : error.message);
                return res.status(500).json({ message: error === null || error === void 0 ? void 0 : error.message });
            }
        });
    }
    updateMatriculant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { admissionId, sessionId, billId, categoryId, programId, majorId, } = req.body;
                delete req.body.admissionId;
                delete req.body.sessionId;
                delete req.body.billId;
                delete req.body.programId;
                delete req.body.majorId;
                delete req.body.categoryId;
                const existing = yield ams.fresher.findFirst({ where: Object.assign({ serial: (0, paramStr_1.paramStr)(req.params.id) }, (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'matriculant'))) });
                if (!existing)
                    return res.status(403).json({ message: `You do not have access to this matriculant.` });
                // Was updating ams.sortedApplicant (the shortlist model) instead of
                // ams.fresher (matriculant) — a copy-paste bug from updateShortlist.
                const resp = yield ams.fresher.update({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                    data: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), admissionId && ({ admission: { connect: { id: admissionId } } })), sessionId && ({ session: { connect: { id: sessionId } } })), billId && ({ bill: { connect: { id: billId } } })), categoryId && ({ category: { connect: { id: categoryId } } })), programId && ({ program: { connect: { id: programId } } })), majorId && ({ major: { connect: { id: majorId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    deleteMatriculant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const serial = (0, paramStr_1.paramStr)(req.params.id);
                const existing = yield ams.fresher.findFirst({ where: Object.assign({ serial }, (0, amsScope_1.categoryWhere)((0, amsScope_1.categoryScope)(req.roles, 'matriculant'))) });
                if (!existing)
                    return res.status(403).json({ message: `You do not have access to this matriculant.` });
                // Remove Matriculant Data
                const resp = yield ams.fresher.delete({
                    where: { serial }
                });
                // Remove Student Data
                const student = yield ams.student.delete({
                    where: { id: serial }
                });
                // Remove SSO Account
                const sso = yield ams.user.deleteMany({
                    where: { tag: serial }
                });
                // Update Applicant Status 
                const ups = yield ams.sortedApplicant.update({
                    where: { serial },
                    data: { admitted: false },
                });
                if (resp) {
                    res.status(200).json(resp);
                }
                else {
                    res.status(204).json({ message: `No records found` });
                }
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Helpers */
    fetchSubjectList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.subject.findMany({
                    where: { status: true },
                    orderBy: { createdAt: 'asc' }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchInstituteList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.instituteCategory.findMany({
                    where: { status: true },
                    orderBy: { createdAt: 'asc' }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchCertList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.certCategory.findMany({
                    where: { status: true },
                    orderBy: { createdAt: 'asc' }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchWeightList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.gradeWeight.findMany({
                    where: { status: true },
                    orderBy: { createdAt: 'asc' }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchAwardList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.awardClass.findMany({
                    where: { status: true },
                    orderBy: { id: 'asc' }
                });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchStageList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stage.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchApplytypeList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.applyType.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchAmsPriceList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.amsPrice.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
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
    fetchAmsDocList(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.documentCategory.findMany({
                    where: { status: true },
                });
                if (resp) {
                    res.status(200).json(resp);
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
    /* Step Applicant - Configuration */
    fetchStepApplicant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.applicant.findUnique({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp) {
                    res.status(200).json(resp);
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
    saveStepApplicant(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { serial, stageId, applyTypeId, categoryId } = req.body;
                delete req.body.stageId;
                delete req.body.serial;
                delete req.body.applyTypeId;
                delete req.body.categoryId;
                // Admission Session
                const voucher = yield ams.voucher.findFirst({ where: { serial } });
                // Application Form Schema for Chosen Category
                const form = yield ams.amsForm.findFirst({ where: { categoryId } });
                if (form)
                    req.body.meta = form === null || form === void 0 ? void 0 : form.meta;
                // A new photo arrives as a raw base64 data URI — write it straight
                // to disk and store just the reference (see util/amsFileStorage.ts)
                // instead of the blob. Left untouched when no new photo is
                // submitted for this save, so an existing (already-migrated or
                // not-yet-migrated) photo/path is never clobbered.
                if (typeof req.body.photo === 'string' && req.body.photo.startsWith('data:')) {
                    const { buffer } = (0, amsFileStorage_1.decodeBase64Field)(req.body.photo);
                    const relPath = (0, amsFileStorage_1.applicantPhotoPath)(serial);
                    if ((0, amsFileStorage_1.writeAmsFile)(relPath, buffer)) {
                        req.body.path = relPath;
                        req.body.photo = null;
                    }
                }
                const resp = yield ams.applicant.upsert({
                    where: { serial },
                    create: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), { serial }), stageId && ({ stage: { connect: { id: stageId } } })), applyTypeId && ({ applyType: { connect: { id: applyTypeId } } })), voucher && ({ admission: { connect: { id: voucher === null || voucher === void 0 ? void 0 : voucher.admissionId } } })),
                    update: Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), stageId && ({ stage: { connect: { id: stageId } } })), applyTypeId && ({ applyType: { connect: { id: applyTypeId } } })), voucher && ({ admission: { connect: { id: voucher === null || voucher === void 0 ? void 0 : voucher.admissionId } } }))
                });
                if (resp) {
                    res.status(200).json(resp);
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
    /* Step Profile */
    fetchStepProfile(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stepProfile.findUnique({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp) {
                    res.status(200).json(resp);
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
    saveStepProfile(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { serial, titleId, regionId, religionId, countryId, nationalityId, maritalId, disabilityId } = req.body;
                delete req.body.titleId;
                delete req.body.regionId;
                delete req.body.religionId;
                delete req.body.countryId;
                delete req.body.nationalityId;
                delete req.body.maritalId;
                delete req.body.disabilityId;
                delete req.body.serial;
                delete req.body.id;
                const resp = yield ams.stepProfile.upsert({
                    where: { serial },
                    create: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({ serial }, req.body), titleId && ({ title: { connect: { id: titleId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), countryId && ({ country: { connect: { id: countryId } } })), nationalityId && ({ nationality: { connect: { id: nationalityId } } })), maritalId && ({ marital: { connect: { id: maritalId } } })), disabilityId && ({ disability: { connect: { id: disabilityId } } })),
                    update: Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), titleId && ({ title: { connect: { id: titleId } } })), regionId && ({ region: { connect: { id: regionId } } })), religionId && ({ religion: { connect: { id: religionId } } })), countryId && ({ country: { connect: { id: countryId } } })), nationalityId && ({ nationality: { connect: { id: nationalityId } } })), maritalId && ({ marital: { connect: { id: maritalId } } })), disabilityId && ({ disability: { connect: { id: disabilityId } } }))
                });
                if (resp) {
                    // Update Applicant with ProfileId
                    yield ams.applicant.update({ where: { serial }, data: { profile: { connect: { serial } } } });
                    res.status(200).json(resp);
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
    saveProfile(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            try {
                const { id, titleId } = req.body;
                delete req.body.titleId;
                delete req.body.id;
                req.body.dob = (0, moment_1.default)(req.body.dob);
                const resp = yield ams.stepProfile.update({
                    where: { serial: id },
                    data: Object.assign(Object.assign({}, req.body), titleId && ({ title: { connect: { id: titleId } } }))
                });
                if (resp) {
                    // Get Student & Check for name change
                    let st = yield ams.student.findFirst({ where: { id } });
                    if (st) {
                        let email = st.instituteEmail;
                        //   console.log(st.fname?.toLowerCase(),req.body.fname.toLowerCase(),st.lname?.toLowerCase(),req.body.lname.toLowerCase(),st.instituteEmail);
                        if ((((_a = st.fname) === null || _a === void 0 ? void 0 : _a.toLowerCase()) != req.body.fname.toLowerCase() || ((_b = st.lname) === null || _b === void 0 ? void 0 : _b.toLowerCase()) != req.body.lname.toLowerCase()) && st.instituteEmail) {
                            let username = `${req.body.fname.toLowerCase()}.${req.body.lname.toLowerCase()}`;
                            let domain = `${st.instituteEmail.split('@')[1]}`;
                            let count = 1;
                            let runLoop = true;
                            while (runLoop) {
                                email = `${username}${count > 1 ? count : ''}@${domain}`;
                                const isExist = yield ams.user.findFirst({ where: { username: email } });
                                count++;
                                if (!isExist)
                                    runLoop = false;
                            }
                        }
                        // Update Student
                        yield ams.student.update({ where: { id }, data: Object.assign(Object.assign({}, req.body), { instituteEmail: email }) });
                        // Update SSO User with Email
                        if (st.instituteEmail)
                            yield ams.user.updateMany({ where: { tag: id }, data: { username: email } });
                        console.log(email);
                    }
                    // Return Response
                    res.status(200).json(resp);
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
    /* Step Guardian */
    fetchStepGuardian(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stepGuardian.findUnique({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp) {
                    res.status(200).json(resp);
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
    saveStepGuardian(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const { serial, titleId, relationId } = req.body;
                delete req.body.titleId;
                delete req.body.serial;
                delete req.body.relationId;
                ;
                const resp = yield ams.stepGuardian.upsert({
                    where: { serial },
                    create: Object.assign(Object.assign(Object.assign(Object.assign({}, req.body), { serial }), titleId && ({ title: { connect: { id: titleId } } })), relationId && ({ relation: { connect: { id: relationId } } })),
                    update: Object.assign(Object.assign(Object.assign({}, req.body), titleId && ({ title: { connect: { id: titleId } } })), relationId && ({ relation: { connect: { id: relationId } } }))
                });
                if (resp) {
                    res.status(200).json(resp);
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
    /* Step Education */
    fetchStepEducation(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stepEducation.findMany({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp);
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
    saveStepEducation(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = req.body;
                yield ams.stepEducation.deleteMany({ where: { serial: req.body[0].serial } });
                const resp = yield Promise.all(data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                    const { id, instituteCategoryId, certCategoryId } = row;
                    row === null || row === void 0 ? true : delete row.instituteCategoryId;
                    row === null || row === void 0 ? true : delete row.id;
                    row === null || row === void 0 ? true : delete row.certCategoryId;
                    return yield ams.stepEducation.upsert({
                        where: { id: (id !== null && id !== void 0 ? id : '') },
                        create: Object.assign(Object.assign(Object.assign({}, row), instituteCategoryId && ({ instituteCategory: { connect: { id: instituteCategoryId } } })), certCategoryId && ({ certCategory: { connect: { id: certCategoryId } } })),
                        update: Object.assign(Object.assign(Object.assign({}, row), instituteCategoryId && ({ instituteCategory: { connect: { id: instituteCategoryId } } })), certCategoryId && ({ certCategory: { connect: { id: certCategoryId } } }))
                    });
                })));
                if (resp) {
                    res.status(200).json(resp);
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
    /* Step Result */
    fetchStepResult(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stepResult.findMany({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                    include: { grades: true }
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp);
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
    saveStepResult(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = req.body;
                console.log(data);
                yield ams.stepResult.deleteMany({ where: { serial: req.body[0].serial } });
                yield ams.stepGrade.deleteMany({ where: { serial: req.body[0].serial } });
                // Results 
                const resp = yield Promise.all(data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                    const { certCategoryId, grades } = row;
                    row === null || row === void 0 ? true : delete row.id;
                    row === null || row === void 0 ? true : delete row.certCategoryId;
                    row === null || row === void 0 ? true : delete row.grades;
                    // Grades
                    const newGrades = grades === null || grades === void 0 ? void 0 : grades.map((item) => {
                        const { resultId, gradeWeightId, subjectId } = item;
                        item === null || item === void 0 ? true : delete item.resultId;
                        item === null || item === void 0 ? true : delete item.gradeWeightId;
                        item === null || item === void 0 ? true : delete item.subjectId;
                        item === null || item === void 0 ? true : delete item.id;
                        return (Object.assign(Object.assign(Object.assign(Object.assign({}, item), resultId && ({ result: { connect: { id: resultId } } })), gradeWeightId && ({ gradeWeight: { connect: { id: gradeWeightId } } })), subjectId && ({ subject: { connect: { id: subjectId } } })));
                    });
                    return yield ams.stepResult.upsert({
                        where: { id: '' },
                        create: Object.assign(Object.assign(Object.assign({}, row), certCategoryId && ({ certCategory: { connect: { id: certCategoryId } } })), { grades: { create: newGrades } }),
                        update: {}
                    });
                    // return await ams.stepResult.createMany({
                    //    data: { 
                    //       ...row, 
                    //       certCategoryId,
                    //       // ...certCategoryId && ({ certCategory: { connect: { id: certCategoryId }}}),
                    //       grades: { create: newGrades }
                    //    }
                    // })
                })));
                if (resp) {
                    res.status(200).json(resp);
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
    /* Step Employment */
    fetchStepEmployment(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stepEmployment.findMany({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp);
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
    saveStepEmployment(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = req.body;
                yield ams.stepEmployment.deleteMany({ where: { serial: req.body[0].serial } });
                const resp = yield Promise.all(data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                    const { id } = row;
                    return yield ams.stepEmployment.upsert({
                        where: { id: (id || '') },
                        create: row,
                        update: row
                    });
                })));
                if (resp) {
                    res.status(200).json(resp);
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
    /* Step Document */
    fetchStepDocument(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stepDocument.findMany({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                    orderBy: { 'createdAt': 'asc' }
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp);
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
    saveStepDocument(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = req.body;
                const files = req.files;
                const tag = data === null || data === void 0 ? void 0 : data.serial;
                let idx = [];
                let aidx = [];
                console.log(files, req.body);
                const resp = yield Promise.all(Array.from({ length: Number(data === null || data === void 0 ? void 0 : data.count) }).map((_, i) => __awaiter(this, void 0, void 0, function* () {
                    const id = data[`id_${i}`];
                    aidx.push(id);
                    if (id)
                        idx.push(id);
                    const documentCategoryId = data[`documentCategoryId_${i}`];
                    let row = { serial: data.serial };
                    // Insert into Record — base64/path are left untouched here; they
                    // only change below, and only once a new file has actually been
                    // written to disk (previously this unconditionally overwrote
                    // base64 with a file-reference URL even when no file was
                    // uploaded, which silently destroyed the original document data
                    // whenever a step was resaved without a new upload).
                    const rec = yield ams.stepDocument.upsert({
                        where: { id: (id !== null && id !== void 0 ? id : '') },
                        create: Object.assign(Object.assign({}, row), documentCategoryId && ({ documentCategory: { connect: { id: documentCategoryId } } })),
                        update: Object.assign(Object.assign({}, row), documentCategoryId && ({ documentCategory: { connect: { id: documentCategoryId } } }))
                    });
                    if (rec === null || rec === void 0 ? void 0 : rec.id) {
                        idx.push(rec === null || rec === void 0 ? void 0 : rec.id);
                        aidx.push(rec === null || rec === void 0 ? void 0 : rec.id);
                    }
                    // No new file for this slot — leave the existing base64/path as-is.
                    if (!files || !files[`doc_${i}`])
                        return rec;
                    const relPath = (0, amsFileStorage_1.stepDocumentPath)(tag, rec === null || rec === void 0 ? void 0 : rec.id);
                    const dest = path.join(__dirname, `/../../public/${relPath}`);
                    return files[`doc_${i}`].mv(dest, function (err) {
                        return __awaiter(this, void 0, void 0, function* () {
                            if (err)
                                return res.status(500).send(err);
                            return yield ams.stepDocument.update({ where: { id: rec === null || rec === void 0 ? void 0 : rec.id }, data: { path: relPath, base64: null } });
                        });
                    });
                })));
                if (resp) {
                    // Clean Unwanted Records
                    yield ams.stepDocument.deleteMany({ where: { serial: data === null || data === void 0 ? void 0 : data.serial, id: { notIn: idx } } });
                    // Clean Unwanted Files
                    aidx.filter((r) => !idx.includes(r)).map((d) => {
                        const relPath = (0, amsFileStorage_1.stepDocumentPath)(tag, d);
                        if ((0, amsFileStorage_1.amsFileExists)(relPath))
                            (0, amsFileStorage_1.removeAmsFile)(relPath);
                    });
                    // Return Response
                    res.status(200).json(resp);
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
    // Counts only — lets the "migrate stored files" admin button show what a
    // real run would do before anyone commits to it. A row counts as
    // "pending" once it has blob data and no path yet; stepDocument rows
    // whose base64 was already overwritten with a dead file-reference URL
    // (a pre-existing bug in saveStepDocument, fixed above) have nothing left
    // to migrate and are reported separately as unrecoverable.
    previewBlobMigration(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const applicantPending = yield ams.applicant.count({ where: { photo: { not: null }, path: null } });
                const applicantMigrated = yield ams.applicant.count({ where: { path: { not: null } } });
                const docCandidates = yield ams.stepDocument.findMany({
                    where: { base64: { not: null }, path: null },
                    select: { base64: true },
                });
                const docUnrecoverable = docCandidates.filter((d) => (0, amsFileStorage_1.isUnrecoverableUrlReference)(d.base64)).length;
                const docPending = docCandidates.length - docUnrecoverable;
                const docMigrated = yield ams.stepDocument.count({ where: { path: { not: null } } });
                res.status(200).json({
                    applicant: { pending: applicantPending, migrated: applicantMigrated },
                    stepDocument: { pending: docPending, unrecoverable: docUnrecoverable, migrated: docMigrated },
                });
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    // The manual trigger: moves every existing applicant.photo / stepDocument
    // .base64 blob still in the DB out to a file on disk and records the
    // reference in `path`. Idempotent (only touches rows with path IS NULL,
    // so re-running after a partial failure just picks up where it left off)
    // and per-row safe (the blob column is only cleared after the file write
    // is verified on disk — a failed write leaves that row's blob untouched
    // for the next run rather than losing it).
    runBlobMigration(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const summary = {
                    applicant: { migrated: 0, failed: 0, errors: [] },
                    stepDocument: { migrated: 0, unrecoverable: 0, failed: 0, errors: [] },
                };
                const applicants = yield ams.applicant.findMany({
                    where: { photo: { not: null }, path: null },
                    select: { serial: true, photo: true },
                });
                for (const a of applicants) {
                    try {
                        const { buffer } = (0, amsFileStorage_1.decodeBase64Field)(a.photo);
                        const relPath = (0, amsFileStorage_1.applicantPhotoPath)(a.serial);
                        if ((0, amsFileStorage_1.writeAmsFile)(relPath, buffer)) {
                            yield ams.applicant.update({ where: { serial: a.serial }, data: { path: relPath, photo: null } });
                            summary.applicant.migrated++;
                        }
                        else {
                            summary.applicant.failed++;
                            summary.applicant.errors.push({ serial: a.serial, error: "file write verification failed" });
                        }
                    }
                    catch (err) {
                        summary.applicant.failed++;
                        summary.applicant.errors.push({ serial: a.serial, error: err.message });
                    }
                }
                const docs = yield ams.stepDocument.findMany({
                    where: { base64: { not: null }, path: null },
                    select: { id: true, serial: true, base64: true, mime: true },
                });
                for (const d of docs) {
                    if ((0, amsFileStorage_1.isUnrecoverableUrlReference)(d.base64)) {
                        summary.stepDocument.unrecoverable++;
                        continue;
                    }
                    try {
                        const { buffer } = (0, amsFileStorage_1.decodeBase64Field)(d.base64, d.mime);
                        const relPath = (0, amsFileStorage_1.stepDocumentPath)(d.serial, d.id);
                        if ((0, amsFileStorage_1.writeAmsFile)(relPath, buffer)) {
                            yield ams.stepDocument.update({ where: { id: d.id }, data: { path: relPath, base64: null } });
                            summary.stepDocument.migrated++;
                        }
                        else {
                            summary.stepDocument.failed++;
                            summary.stepDocument.errors.push({ id: d.id, error: "file write verification failed" });
                        }
                    }
                    catch (err) {
                        summary.stepDocument.failed++;
                        summary.stepDocument.errors.push({ id: d.id, error: err.message });
                    }
                }
                res.status(200).json(summary);
            }
            catch (error) {
                console.log(error);
                return res.status(500).json({ message: error.message });
            }
        });
    }
    /* Step Choice */
    fetchStepChoice(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stepChoice.findMany({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp);
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
    saveStepChoice(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = req.body;
                yield ams.stepChoice.deleteMany({ where: { serial: req.body[0].serial } });
                const resp = yield Promise.all(data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                    const { id, programId, majorId } = row;
                    row === null || row === void 0 ? true : delete row.programId;
                    row === null || row === void 0 ? true : delete row.majorId;
                    row === null || row === void 0 ? true : delete row.id;
                    return yield ams.stepChoice.upsert({
                        where: { id: (id || '') },
                        create: Object.assign(Object.assign(Object.assign({}, row), programId && ({ program: { connect: { id: programId } } })), majorId && ({ major: { connect: { id: majorId } } })),
                        update: Object.assign(Object.assign(Object.assign({}, row), programId && ({ program: { connect: { id: programId } } })), majorId && ({ major: { connect: { id: majorId } } }))
                    });
                })));
                if (resp) {
                    // Update Applicant First Choice
                    //const ch = await ams.stepChoice.findFirst({ where: { serial }})
                    yield ams.applicant.update({ where: { serial: req.body[0].serial }, data: { choiceId: resp[0].id } });
                    res.status(200).json(resp);
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
    /* Step Referee */
    fetchStepReferee(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const resp = yield ams.stepReferee.findMany({
                    where: { serial: (0, paramStr_1.paramStr)(req.params.id) },
                });
                if (resp === null || resp === void 0 ? void 0 : resp.length) {
                    res.status(200).json(resp);
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
    saveStepReferee(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const data = req.body;
                yield ams.stepReferee.deleteMany({ where: { serial: req.body[0].serial } });
                const resp = yield Promise.all(data === null || data === void 0 ? void 0 : data.map((row) => __awaiter(this, void 0, void 0, function* () {
                    const { id, titleId } = row;
                    row === null || row === void 0 ? true : delete row.titleId;
                    return yield ams.stepReferee.upsert({
                        where: { id: (id || '') },
                        create: Object.assign(Object.assign({}, row), titleId && ({ title: { connect: { id: titleId } } })),
                        update: Object.assign(Object.assign({}, row), titleId && ({ title: { connect: { id: titleId } } })),
                    });
                })));
                if (resp) {
                    res.status(200).json(resp);
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
    /* Step Review */
    saveStepReview(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                const { serial, choiceId } = req.body;
                (_a = req.body) === null || _a === void 0 ? true : delete _a.choiceId;
                console.log(req.body);
                const resp = yield ams.applicant.update({
                    where: { serial },
                    data: Object.assign(Object.assign({}, req.body), choiceId && ({ choice: { connect: { id: choiceId } } })),
                });
                if (resp) {
                    res.status(200).json(resp);
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
    /* Dashboard & Statistics */
    fetchDashboard(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Main Statistics
                const session = yield ams.admission.findFirst({ where: { default: true } }); // Session
                const applicant = yield ams.applicant.count({ where: { admission: { default: true } } }); // Applicant
                const vsale = yield ams.activityFinanceVoucher.findMany({ where: { admission: { default: true } }, select: { transaction: true } }); // Sale
                const sold = yield ams.voucher.count({ where: { admission: { default: true }, soldAt: { not: null } } }); // Sale
                const unsold = yield ams.voucher.count({ where: { admission: { default: true }, soldAt: null } }); // Sale
                const voucher = yield ams.voucher.count({ where: { admission: { default: true } } }); // vouchers
                const sort = yield ams.sortedApplicant.count({ where: { admission: { default: true } } }); // sorted
                const submit = yield ams.applicant.count({ where: { admission: { default: true }, submitted: true } }); // submitted
                const fresher = yield ams.fresher.count({ where: { admission: { default: true } } }); // fresher
                // Program Statistics
                const progs = yield ams.program.findMany();
                const program = yield Promise.all(progs.map((r) => __awaiter(this, void 0, void 0, function* () {
                    // Applicant
                    const m_applicant = yield ams.$queryRaw `select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session === null || session === void 0 ? void 0 : session.id} and c.programId = ${r === null || r === void 0 ? void 0 : r.id}`;
                    const f_applicant = yield ams.$queryRaw `select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session === null || session === void 0 ? void 0 : session.id} and c.programId = ${r === null || r === void 0 ? void 0 : r.id}`;
                    // Sorted
                    const m_sort = yield ams.$queryRaw `select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_sorted a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session === null || session === void 0 ? void 0 : session.id} and c.programId = ${r === null || r === void 0 ? void 0 : r.id}`;
                    const f_sort = yield ams.$queryRaw `select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_sorted a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session === null || session === void 0 ? void 0 : session.id} and c.programId = ${r === null || r === void 0 ? void 0 : r.id}`;
                    // Submitted
                    const m_submit = yield ams.$queryRaw `select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session === null || session === void 0 ? void 0 : session.id} and c.programId = ${r === null || r === void 0 ? void 0 : r.id} and a.submitted = 1`;
                    const f_submit = yield ams.$queryRaw `select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session === null || session === void 0 ? void 0 : session.id} and c.programId = ${r === null || r === void 0 ? void 0 : r.id} and a.submitted = 1`;
                    // Admitted
                    const m_fresher = yield ams.$queryRaw `select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_fresher a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session === null || session === void 0 ? void 0 : session.id} and c.programId = ${r === null || r === void 0 ? void 0 : r.id}`;
                    const f_fresher = yield ams.$queryRaw `select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_fresher a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session === null || session === void 0 ? void 0 : session.id} and c.programId = ${r === null || r === void 0 ? void 0 : r.id}`;
                    return ({
                        label: r.shortName,
                        applicant: { m: ((m_applicant === null || m_applicant === void 0 ? void 0 : m_applicant.length) || 0), f: ((f_applicant === null || f_applicant === void 0 ? void 0 : f_applicant.length) || 0) },
                        sort: { m: ((m_sort === null || m_sort === void 0 ? void 0 : m_sort.length) || 0), f: ((f_sort === null || f_sort === void 0 ? void 0 : f_sort.length) || 0) },
                        submit: { m: ((m_submit === null || m_submit === void 0 ? void 0 : m_submit.length) || 0), f: ((f_submit === null || f_submit === void 0 ? void 0 : f_submit.length) || 0) },
                        fresher: { m: ((m_fresher === null || m_fresher === void 0 ? void 0 : m_fresher.length) || 0), f: ((f_fresher === null || f_fresher === void 0 ? void 0 : f_fresher.length) || 0) },
                    });
                })));
                let data = {
                    session: session === null || session === void 0 ? void 0 : session.title,
                    general: {
                        sale: (vsale === null || vsale === void 0 ? void 0 : vsale.reduce((acc, cur) => { var _a; return acc + ((_a = cur === null || cur === void 0 ? void 0 : cur.transaction) === null || _a === void 0 ? void 0 : _a.amount); }, 0)) || 0,
                        applicant,
                        sort,
                        submit,
                        fresher,
                        voucher,
                        sold,
                        unsold
                    },
                    program
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
}
exports.default = AmsController;
