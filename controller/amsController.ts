import { Request, Response } from "express";
import AuthModel from '../model/authModel';
import EvsModel from '../model/evsModel';
import { prisma } from "../prisma/client";
// import { PrismaClient } from "../prisma/client";
import moment from "moment";
import { getBillCodePrisma } from "../util/helper";
import { paramStr } from "../util/paramStr";
import { categoryScope, categoryScopeAcross, categoryWhere } from "../util/amsScope";
import { stepDocumentPath, applicantPhotoPath, writeAmsFile, removeAmsFile, amsFileExists, decodeBase64Field, isUnrecoverableUrlReference } from "../util/amsFileStorage";

const path = require('path');
import { hashPassword } from "../util/password";
const { customAlphabet } = require("nanoid");
const nanoid = customAlphabet("1234567890abcdefghijklmnopqrstuvwzyx", 8);
const pwdgen = customAlphabet("1234567890abcdefghijklmnopqrstuvwzyx", 6);
const digit = customAlphabet("1234567890", 4);


const sms = require('../config/sms');
const evs = new EvsModel();
const Auth = new AuthModel();
const ams = prisma;
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

async function buildApplicantPreview(serial: string) {
   const output = new Map();
   for (const tag of APPLICANT_PREVIEW_STEPS) {
      if (tag == 'profile') {
         const res = await ams.stepProfile.findUnique({ where: { serial }, include: { title: true, disability: true, religion: true, region: true, country: true, nationality: true, marital: true } })
         if (res) output.set('profile', res)
      }
      if (tag == 'guardian') {
         const res = await ams.stepGuardian.findUnique({ where: { serial }, include: { title: true, relation: true } })
         if (res) output.set('guardian', res)
      }
      if (tag == 'education') {
         const res = await ams.stepEducation.findMany({ where: { serial }, include: { instituteCategory: true, certCategory: true } })
         if (res?.length) output.set('education', res)
      }
      if (tag == 'result') {
         const res = await ams.stepResult.findMany({ where: { serial }, include: { certCategory: true, grades: { select: { gradeWeight: true, subject: { select: { title: true } } } } } })
         if (res?.length) output.set('result', res)
      }
      if (tag == 'choice') {
         const res = await ams.stepChoice.findMany({ where: { serial }, include: { program: true, major: true } })
         if (res?.length) output.set('choice', res)
      }
      if (tag == 'document') {
         const res = await ams.stepDocument.findMany({ where: { serial }, include: { documentCategory: true }, orderBy: { 'createdAt': 'asc' } })
         if (res?.length) output.set('document', res)
      }
      if (tag == 'employment') {
         const res = await ams.stepEmployment.findMany({ where: { serial }, orderBy: { 'createdAt': 'asc' } })
         if (res?.length) output.set('employment', res)
      }
      if (tag == 'referee') {
         const res = await ams.stepReferee.findMany({ where: { serial }, include: { title: true }, orderBy: { 'createdAt': 'asc' } })
         if (res?.length) output.set('referee', res)
      }
   }
   return output.size ? Object.fromEntries(output) : null;
}

// The applicant row itself is deleted once someone is shortlisted (their
// data moves onto sortedApplicant instead, which persists unchanged through
// admission — see postMatriculant, which only ever updates it, never
// deletes it). fetchApplicant/fetchApplicantPreview are shared by the
// applicant, shortlist, and matriculant-admin pages alike, so they need to
// find whichever of those two rows currently represents this serial to
// resolve a category for the UG/PG scope check, rather than assuming the
// applicant row is always still there.
async function resolveApplicantCategory(serial: string): Promise<string | null> {
   const applicant: any = await ams.applicant.findFirst({ where: { serial }, select: { stage: { select: { categoryId: true } } } });
   if (applicant) return applicant.stage?.categoryId ?? null;
   const sorted: any = await ams.sortedApplicant.findFirst({ where: { serial }, select: { categoryId: true } });
   if (sorted) return sorted.categoryId ?? null;
   return null;
}

export default class AmsController {

   /* Reports */
   // Route-gated to admreport::admin only (see amsRoute.ts) — that role has
   // full/unrestricted visibility across UG and PG alike, unlike every other
   // AMS role, which is why this never applies categoryScope/categoryWhere.
   async loadReport(req: Request, res: Response) {
      try {
         const { type, session, program } = req.body;
         const admissionCondition = session ? { admissionId: session } : { admission: { default: true } };
         let resp: any = { type };

         if (type == 'applicants') {
            const rows = await ams.applicant.findMany({
               where: {
                  ...admissionCondition,
                  ...(program && { choice: { programId: program } }),
               },
               include: { stage: true, applyType: true, choice: { include: { program: true } }, profile: true },
               orderBy: { createdAt: 'desc' },
            });
            resp.data = rows.map((r: any) => ({
               'SERIAL': r?.serial,
               'LAST NAME': r?.profile?.lname,
               'FIRST NAME': r?.profile?.fname,
               'MIDDLE NAME(S)': r?.profile?.mname,
               'GENDER': r?.profile?.gender,
               'PHONE': r?.profile?.phone,
               'EMAIL': r?.profile?.email,
               'PROGRAM CHOICE': r?.choice?.program?.longName,
               'ADMISSION GROUP': r?.stage?.title,
               'APPLY TYPE': r?.applyType?.title,
               'SUBMITTED': r?.submitted ? 'YES' : 'NO',
               'SUBMITTED ON': r?.submittedAt,
            }));
         }

         else if (type == 'shortlisted') {
            const rows = await ams.sortedApplicant.findMany({
               where: {
                  ...admissionCondition,
                  ...(program && { OR: [{ choice1: { programId: program } }, { choice2: { programId: program } }] }),
               },
               include: { stage: true, applyType: true, category: true, choice1: { include: { program: true } }, choice2: { include: { program: true } }, profile: true },
               orderBy: { createdAt: 'desc' },
            });
            resp.data = rows.map((r: any) => ({
               'SERIAL': r?.serial,
               'LAST NAME': r?.profile?.lname,
               'FIRST NAME': r?.profile?.fname,
               'MIDDLE NAME(S)': r?.profile?.mname,
               'GENDER': r?.profile?.gender,
               'CATEGORY': r?.category?.title,
               'FIRST CHOICE PROGRAM': r?.choice1?.program?.longName,
               'SECOND CHOICE PROGRAM': r?.choice2?.program?.longName,
               'ADMISSION GROUP': r?.stage?.title,
               'ADMITTED': r?.admitted ? 'YES' : 'NO',
            }));
         }

         else if (type == 'matriculants') {
            const rows = await ams.fresher.findMany({
               where: {
                  ...admissionCondition,
                  ...(program && { programId: program }),
               },
               include: { student: true, program: true, category: true },
               orderBy: { createdAt: 'desc' },
            });
            resp.data = rows.map((r: any) => ({
               'SERIAL': r?.serial,
               'LAST NAME': r?.student?.lname,
               'FIRST NAME': r?.student?.fname,
               'MIDDLE NAME(S)': r?.student?.mname,
               'GENDER': r?.student?.gender,
               'INSTITUTIONAL EMAIL': r?.student?.instituteEmail,
               'PROGRAM': r?.program?.longName,
               'CATEGORY': r?.category?.title,
               'SESSION MODE': r?.sessionMode == 'E' ? 'EVENING' : r?.sessionMode == 'W' ? 'WEEKEND' : 'MORNING',
               'YEAR': Math.ceil((r?.semesterNum || 1) / 2),
            }));
         }

         res.status(200).json(resp);
      } catch (error: any) {
         console.log(error);
         return res.status(500).json({ message: error.message });
      }
   }

   /* Session */
   async fetchSessionList(req: Request, res: Response) {
      try {
         const resp = await ams.admission.findMany({ where: { status: true }, orderBy: { createdAt: 'asc' } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchSessions(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
                  { session: { title: { contains: keyword } } },
               ],
            }
         }
         const resp = await ams.$transaction([
            ams.admission.count({
               ...(searchCondition),
            }),
            ams.admission.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  _count: { select: { voucher: true, sortedApplicant: true, fresher: true } }
               },
               orderBy: { 'createdAt': 'desc' }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchSession(req: Request, res: Response) {
      try {
         const resp = await ams.admission.findUnique({
            where: {
               id: paramStr(req.params.id)
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async ActivateSession(req: Request, res: Response) {
      try {
         const ups = await ams.admission.updateMany({
            where: { id: { not: paramStr(req.params.id) } },
            data: { default: false },
         })
         const resp = await ams.admission.update({
            where: { id: paramStr(req.params.id) },
            data: { default: true },
         })

         if (ups && resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postSession(req: Request, res: Response) {
      try {
         const { pgletterId, ugletterId, dpletterId, cpletterId, sessionId } = req.body
         delete req.body.pgletterId; delete req.body.ugletterId;
         delete req.body.dpletterId; delete req.body.cpletterId;
         delete req.body.sessionId;

         const resp = await ams.admission.create({
            data: {
               ...req.body,
               ...pgletterId && ({ pgletter: { connect: { id: pgletterId } } }),
               ...ugletterId && ({ ugletter: { connect: { id: ugletterId } } }),
               ...dpletterId && ({ dpletter: { connect: { id: dpletterId } } }),
               ...cpletterId && ({ cpletter: { connect: { id: cpletterId } } }),
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateSession(req: Request, res: Response) {
      try {
         const { pgletterId, ugletterId, dpletterId, cpletterId, sessionId } = req.body
         delete req.body.pgletterId; delete req.body.ugletterId;
         delete req.body.dpletterId; delete req.body.cpletterId;
         delete req.body.sessionId;

         const resp = await ams.admission.update({
            where: {
               id: paramStr(req.params.id)
            },
            data: {
               ...req.body,
               ...pgletterId && ({ pgletter: { connect: { id: pgletterId } } }),
               ...ugletterId && ({ ugletter: { connect: { id: ugletterId } } }),
               ...dpletterId && ({ dpletter: { connect: { id: dpletterId } } }),
               ...cpletterId && ({ cpletter: { connect: { id: cpletterId } } }),
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteSession(req: Request, res: Response) {
      try {
         const resp = await ams.admission.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Vouchers */
   async fetchVoucherList(req: Request, res: Response) {
      try {
         const resp = await ams.voucher.findMany({ where: { status: true }, orderBy: { createdAt: 'asc' } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchVouchers(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition: any = { where: { admission: { default: true } } }
      try {
         if (keyword) searchCondition = {
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
         }
         const resp = await ams.$transaction([
            ams.voucher.count({
               ...(searchCondition),
            }),
            ams.voucher.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               orderBy: [
                  { 'soldAt': 'desc' },
                  { 'sellType': 'asc' },
               ],
               include: {
                  vendor: true,
                  admission: true,
                  category: true
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
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchVoucher(req: Request, res: Response) {
      try {
         const resp = await ams.voucher.findUnique({
            where: {
               serial: paramStr(req.params.id)
            },
            include: {
               vendor: true,
               admission: true,
               category: true
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async sellVoucher(req: Request, res: Response) {
      try {
         const { applicantPhone, applicantName } = req.body;
         const resp = await ams.voucher.update({
            where: { serial: paramStr(req.params.id) },
            data: { soldAt: new Date(), applicantName, applicantPhone, sold: true, soldBy: 'req.user' },
         })
         if (resp) {
            const msg = `Hi, Your Serial: ${resp.serial}, Pin: ${resp.pin}, Goto the Unified Portal to apply. Thank you.`
            const sent = await sms(resp.applicantPhone, msg, SENDERID)
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async recoverVoucher(req: Request, res: Response) {
      try {
         const resp = await ams.voucher.findUnique({
            where: { serial: paramStr(req.params.id) },
         })
         if (resp) {
            const msg = `Hi, Your Serial: ${resp.serial}, Pin: ${resp.pin}, Goto the Unified Portal to apply. Thank you.`
            const sent = await sms(resp.applicantPhone, msg, SENDERID)
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postVoucher(req: Request, res: Response) {
      try {
         const admission: any = await ams.admission.findFirst({ where: { default: true } })
         const voucher: any = await ams.voucher.findFirst({ where: { admission: { default: true } }, orderBy: { 'createdAt': 'desc' } })
         const { vendorId, categoryId, sellType, quantity } = req.body
         const lastIndex = voucher ? Number(voucher.serial) : admission?.voucherIndex;
         const admissionId = admission?.id;

         const data = [];
         let count = 0;
         if (quantity > 0) {
            for (var i = 1; i <= quantity; i++) {
               let dt = {
                  serial: (lastIndex + i)?.toString(),
                  pin: nanoid(),
                  sellType,
                  ...vendorId && ({ vendor: { connect: { id: vendorId } } }),
                  ...categoryId && ({ category: { connect: { id: categoryId } } }),
                  ...admissionId && ({ admission: { connect: { id: admissionId } } }),

               }
               data.push(dt)
               const resp = await ams.voucher.create({ data: dt })
               if (resp) count += 1;
            }
         }
         // const resp = await ams.voucher.createMany({ data })
         if (count) {
            res.status(200).json(count)
         } else {
            res.status(204).json({ message: `no records found` })
         }
         // if(resp){
         //    res.status(200).json(resp)
         // } else {
         //    res.status(204).json({ message: `no records found` })
         // }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateVoucher(req: Request, res: Response) {
      try {
         delete req.body.action; delete req.body.id;
         const resp = await ams.voucher.update({
            where: { serial: paramStr(req.params.id) },
            data: { ...req.body },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteVoucher(req: Request, res: Response) {
      try {
         const resp = await ams.voucher.updateMany({
            where: { serial: paramStr(req.params.id) },
            data: {
               soldAt: null,
               applicantName: null,
               applicantPhone: null
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Letters */
   async fetchLetterList(req: Request, res: Response) {
      try {
         const resp = await ams.admissionLetter.findMany({ where: { status: true }, orderBy: { createdAt: 'asc' } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchLetters(req: Request, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      let searchCondition = {}
      try {
         if (keyword) searchCondition = {
            where: {
               OR: [
                  { title: { contains: keyword } },
                  { category: { title: { contains: keyword } } },
               ],
            }
         }
         const resp = await ams.$transaction([
            ams.admissionLetter.count({
               ...(searchCondition),
            }),
            ams.admissionLetter.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  category: true
               },
               orderBy: { 'createdAt': 'desc' }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchLetter(req: Request, res: Response) {
      try {
         const resp = await ams.admissionLetter.findUnique({
            where: { id: paramStr(req.params.id) },
            include: {
               category: true,
               // fresher: { include}
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postLetter(req: Request, res: Response) {
      try {
         const { categoryId } = req.body
         delete req.body.categoryId;

         const resp = await ams.admissionLetter.create({
            data: {
               ...req.body,
               ...categoryId && ({ category: { connect: { id: categoryId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateLetter(req: Request, res: Response) {
      try {
         const { categoryId } = req.body
         delete req.body.categoryId;

         const resp = await ams.admissionLetter.update({
            where: { id: paramStr(req.params.id) },
            data: {
               ...req.body,
               ...categoryId && ({ category: { connect: { id: categoryId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteLetter(req: Request, res: Response) {
      try {
         const resp = await ams.admissionLetter.delete({
            where: { id: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Applicants */
   async fetchApplicantList(req: Request, res: Response) {
      try {
         const resp = await ams.applicant.findMany({ where: { status: true }, orderBy: { createdAt: 'asc' } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchApplicants(req: any, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      try {
         const sorted = await ams.sortedApplicant.findMany({ where: { admission: { default: true } } });
         const ids = sorted.map((r: any) => (r.serial));
         // UG/PG scope is derived from the caller's role, never a client-
         // supplied query param — a ?group=postgrad on the URL used to be
         // trusted outright, letting a UG-scoped user view PG applicants.
         const groupCondition = { stage: categoryWhere(categoryScope(req.roles, 'applicant')) };

         let searchCondition: any = {
            where: {
               serial: { notIn: ids },
               admission: { default: true },
               ...groupCondition,
            }
         }

         if (keyword) searchCondition = {
            where: {
               serial: { notIn: ids },
               admission: { default: true },
               ...groupCondition,
               OR: [
                  { serial: { contains: keyword } },
                  { stage: { title: { contains: keyword } } },
                  { applyType: { title: { contains: keyword } } },
               ],
            }
         }

         const resp = await ams.$transaction([
            ams.applicant.count({
               ...(searchCondition),
            }),
            ams.applicant.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               //orderBy: { submittedAt:'desc'},
               orderBy: { 'createdAt': 'desc' },
               include: {
                  stage: { include: { category: true } },
                  applyType: true,
                  profile: true,
                  choice: { include: { program: true } },
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
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchApplicant(req: any, res: Response) {
      try {
         // This read-only lookup backs the application-form preview shown
         // from the applicant, shortlist, and matriculant pages alike — scope
         // it by whichever of those modules the caller holds a role in, not
         // just applicant:: (a shortlist/matriculant admin without an
         // applicant:: role would otherwise always get "no record found").
         const scope = categoryScopeAcross(req.roles, ['applicant', 'shortlist', 'matriculant']);
         const serial = paramStr(req.params.id);
         let resp: any = await ams.applicant.findFirst({
            where: { serial, stage: categoryWhere(scope) },
            include: { stage: true, applyType: true, choice: { include: { program: true } }, profile: { include: { title: true, region: true, country: true, religion: true, disability: true, marital: true } } }
         })
         // The applicant row is deleted once shortlisted — the same person's
         // data lives on sortedApplicant from that point on (see
         // resolveApplicantCategory's comment above). choice1 is mapped to
         // `choice` so callers (e.g. PgAMSShortlist.tsx) don't need to know
         // which table actually answered.
         if (!resp) {
            const sorted: any = await ams.sortedApplicant.findFirst({
               where: { serial, ...categoryWhere(scope) },
               include: { stage: true, applyType: true, choice1: { include: { program: true } }, profile: { include: { title: true, region: true, country: true, religion: true, disability: true, marital: true } } }
            })
            if (sorted) resp = { ...sorted, choice: sorted.choice1 };
         }
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchApplicantPreview(req: any, res: Response) {
      try {
         // Same cross-module scoping as fetchApplicant above, since this
         // backs the same shared preview — resolveApplicantCategory checks
         // both the applicant and sortedApplicant tables so a shortlisted or
         // admitted person's category can still be found and scope-checked
         // even after their applicant row is gone.
         const previewScope = categoryScopeAcross(req.roles, ['applicant', 'shortlist', 'matriculant']);
         const serial = paramStr(req.params.id);
         const category = await resolveApplicantCategory(serial);
         if (!category) return res.status(204).json({ message: `no record found` });
         const inScope = previewScope === 'PG' ? category === 'PG' : previewScope === 'UG' ? category !== 'PG' : false;
         if (!inScope) return res.status(204).json({ message: `no record found` });

         const output = await buildApplicantPreview(serial);
         if (output) res.status(200).json(output);
         else res.status(204).json({ message: `no record found` });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Self-service counterpart to fetchApplicant/fetchApplicantPreview above —
   // applicants log in with an empty roles array (authController.ts's
   // isApplicant branch), so the :id-based routes (staff-only, requireRole
   // APPLICANT_VIEW_ROLES) always 403 them out of their own record. These
   // derive identity from req.userId (set by verifyToken from the signed
   // token's own tag) instead of a client-supplied :id, so there's nothing to
   // category-scope — it's always the caller's own record.
   async fetchMyApplicant(req: any, res: Response) {
      try {
         const serial = req.userId;
         let resp: any = await ams.applicant.findFirst({
            where: { serial },
            include: { stage: true, applyType: true, choice: { include: { program: true } }, profile: { include: { title: true, region: true, country: true, religion: true, disability: true, marital: true } } }
         })
         // Same fallback as the admin fetchApplicant above — once shortlisted
         // (or admitted), the applicant row is gone but sortedApplicant still
         // has it, so an applicant checking their own portal after that point
         // isn't left with a blank record.
         if (!resp) {
            const sorted: any = await ams.sortedApplicant.findFirst({
               where: { serial },
               include: { stage: true, applyType: true, choice1: { include: { program: true } }, profile: { include: { title: true, region: true, country: true, religion: true, disability: true, marital: true } } }
            })
            if (sorted) resp = { ...sorted, choice: sorted.choice1 };
         }
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchMyApplicantPreview(req: any, res: Response) {
      try {
         const output = await buildApplicantPreview(req.userId);
         if (output) res.status(200).json(output);
         else res.status(204).json({ message: `no record found` });
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postApplicant(req: any, res: Response) {
      try {
         const { applyTypeId, stageId, choiceId } = req.body
         delete req.body.stageId; delete req.body.applyTypeId;
         delete req.body.choiceId;

         if (stageId) {
            const scope = categoryScope(req.roles, 'applicant');
            const stage = await ams.stage.findUnique({ where: { id: stageId }, select: { categoryId: true } });
            const inScope = scope === 'PG' ? stage?.categoryId === 'PG' : stage?.categoryId !== 'PG';
            if (!inScope) return res.status(403).json({ message: `You do not have access to create an applicant in this category.` });
         }

         const resp = await ams.applicant.create({
            data: {
               ...req.body,
               ...stageId && ({ stage: { connect: { id: stageId } } }),
               ...applyTypeId && ({ applyType: { connect: { id: applyTypeId } } }),
               ...choiceId && ({ choice: { connect: { id: choiceId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async updateApplicant(req: any, res: Response) {
      try {
         const { applyTypeId, stageId, choiceId } = req.body
         delete req.body.stageId; delete req.body.applyTypeId;
         delete req.body.choiceId;

         const existing = await ams.applicant.findFirst({ where: { serial: paramStr(req.params.id), stage: categoryWhere(categoryScope(req.roles, 'applicant')) } });
         if (!existing) return res.status(403).json({ message: `You do not have access to this applicant.` });

         const resp = await ams.applicant.update({
            where: { serial: paramStr(req.params.id) },
            data: {
               ...req.body,
               ...stageId && ({ stage: { connect: { id: stageId } } }),
               ...applyTypeId && ({ applyType: { connect: { id: applyTypeId } } }),
               ...choiceId && ({ choice: { connect: { id: choiceId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteApplicant(req: any, res: Response) {
      try {
         const existing = await ams.applicant.findFirst({ where: { serial: paramStr(req.params.id), stage: categoryWhere(categoryScope(req.roles, 'applicant')) } });
         if (!existing) return res.status(403).json({ message: `You do not have access to this applicant.` });

         const resp = await ams.applicant.delete({
            where: { serial: paramStr(req.params.id) }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Shortlist */

   async fetchShortlists(req: any, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;

      try {
         // Projected select — this previously pulled every column of every
         // admitted fresher just to build an exclusion-id list.
         const admitted = await ams.fresher.findMany({ where: { admission: { default: true } }, select: { serial: true } });
         const ids = admitted.map((r: any) => (r.serial));
         // UG/PG scope is derived from the caller's role, never a client-
         // supplied query param (see fetchApplicants for the same fix).
         const groupCondition = categoryWhere(categoryScope(req.roles, 'shortlist'));

         let searchCondition: any = {
            where: {
               serial: { notIn: ids },
               admission: { default: true },
               ...groupCondition
            }
         }

         if (keyword) searchCondition = {
            where: {
               serial: { notIn: ids },
               admission: { default: true },
               ...groupCondition,
               OR: [
                  { serial: { contains: keyword } },
                  { choice1: { program: { longName: { contains: keyword } } } },
                  { choice2: { program: { longName: { contains: keyword } } } },
               ],
            }
         }
         const resp = await ams.$transaction([
            ams.sortedApplicant.count({
               ...(searchCondition),
            }),
            ams.sortedApplicant.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               orderBy: { createdAt: 'desc' },
               include: {
                  admission: true, choice1: { include: { program: true } }, choice2: { include: { program: true } }, profile: true, stage: true, applyType: true, category: true
               }
            })
         ]);

         if (resp && resp[1]?.length) {
            // sortedApplicant has no declared relation back to applicant
            // (they're correlated only by sharing `serial` as PK) — look up
            // each row's submitted flag separately so the shortlist list can
            // gate the "Admit" action on whether the applicant actually
            // submitted their form.
            const rows: any[] = resp[1];
            const submissions = await ams.applicant.findMany({
               where: { serial: { in: rows.map((r: any) => r.serial) } },
               select: { serial: true, submitted: true },
            });
            const submittedBySerial = new Map(submissions.map((a: any) => [a.serial, a.submitted]));

            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: rows.map((row: any) => ({ ...row, submitted: submittedBySerial.get(row.serial) ?? false })),
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchShortlist(req: any, res: Response) {
      try {
         const resp = await ams.sortedApplicant.findFirst({
            where: { serial: paramStr(req.params.id), ...categoryWhere(categoryScope(req.roles, 'shortlist')) },
            include: {
               admission: true, choice1: { include: { program: true } }, choice2: { include: { program: true } }, profile: true, stage: true, applyType: true, category: true
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Self-service counterpart — the applicant portal (PgStepConfigure.tsx)
   // needs to know its own admitted/shortlisted status to decide which
   // action buttons to show, but applicants hold no shortlist:: role, so
   // the :id route above always 403s them. Same reasoning as
   // fetchMyApplicant/fetchMyApplicantPreview: identity from req.userId,
   // no category scope needed since it's always the caller's own record.
   async fetchMyShortlist(req: any, res: Response) {
      try {
         const resp = await ams.sortedApplicant.findFirst({
            where: { serial: req.userId },
            include: {
               admission: true, choice1: { include: { program: true } }, choice2: { include: { program: true } }, profile: true, stage: true, applyType: true, category: true
            }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postShortlist(req: any, res: Response) {
      try {
         const { serial } = req.body
         const sorted: any = await ams.sortedApplicant.findFirst({ where: { serial } })

         if (sorted) throw ("Applicant already shortlisted!")

         const voucher: any = await ams.voucher.findFirst({ where: { serial } })
         const admission: any = await ams.admission.findFirst({ where: { default: true } })
         const applicant: any = await ams.applicant.findFirst({ where: { serial }, include: { stage: true } })
         if (!applicant) return res.status(204).json({ message: `no record found` });

         // The applicant page's UI already hides the "Shortlist" button until
         // the applicant has submitted, but that's a client-side convenience,
         // not a guarantee — enforce it here too, since the shortlist list
         // page's "Admit" action now assumes every shortlisted row was
         // actually submitted.
         if (!applicant.submitted) return res.status(409).json({ message: `This applicant has not submitted their application form yet.` });

         // Shortlisting is triggered from the applicant page, so authorize
         // against the caller's applicant:: scope (whichever category it
         // covers), matching the applicant they're actually acting on.
         const appScope = categoryScope(req.roles, 'applicant');
         const inScope = appScope === 'PG' ? applicant.stage?.categoryId === 'PG' : applicant.stage?.categoryId !== 'PG';
         if (!inScope) return res.status(403).json({ message: `You do not have access to shortlist this applicant.` });

         const choice: any = await ams.stepChoice.findFirst({ where: { serial, id: { not: applicant?.choiceId } } })
         //const education:any = await ams.stepEducation.findFirst({ where:{ serial  }})

         const { stageId, applyTypeId, classValue, gradeValue, stage: { categoryId }, choiceId: choice1Id } = applicant ?? null;
         const { id: admissionId } = admission ?? null;
         const { sellType } = voucher ?? null;
         const dt = { serial, sellType, classValue, gradeValue, admitted: false }

         const resp = await ams.sortedApplicant.create({
            data: {
               ...dt,
               ...admissionId && ({ admission: { connect: { id: admissionId } } }),
               ...stageId && ({ stage: { connect: { id: stageId } } }),
               ...applyTypeId && ({ applyType: { connect: { id: applyTypeId } } }),
               ...choice1Id && ({ choice1: { connect: { id: choice1Id } } }),
               ...choice && ({ choice2: { connect: { id: choice?.id } } }),
               ...categoryId && ({ category: { connect: { id: categoryId } } }),
               ...serial && ({ profile: { connect: { serial } } }),
            },
         })
         const ups = await ams.applicant.update({
            where: { serial },
            data: { sorted: true }
         })


         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error })
      }
   }

   async updateShortlist(req: any, res: Response) {
      try {
         const { admissionId, stageId, applyTypeId, categoryId, choice1Id, choice2Id } = req.body
         delete req.body.admissionId; delete req.body.stageId;
         delete req.body.applyTypeId; delete req.body.choice1Id;
         delete req.body.choice2Id; delete req.body.categoryId;

         const existing = await ams.sortedApplicant.findFirst({ where: { serial: paramStr(req.params.id), ...categoryWhere(categoryScope(req.roles, 'shortlist')) } });
         if (!existing) return res.status(403).json({ message: `You do not have access to this shortlist record.` });

         const resp = await ams.sortedApplicant.update({
            where: { serial: paramStr(req.params.id) },
            data: {
               ...req.body,
               ...admissionId && ({ admission: { connect: { id: admissionId } } }),
               ...stageId && ({ stage: { connect: { id: stageId } } }),
               ...applyTypeId && ({ applyType: { connect: { id: applyTypeId } } }),
               ...choice1Id && ({ choice1: { connect: { id: choice1Id } } }),
               ...choice2Id && ({ choice2: { connect: { id: choice2Id } } }),
               ...categoryId && ({ category: { connect: { id: categoryId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteShortlist(req: any, res: Response) {
      try {
         const existing = await ams.sortedApplicant.findFirst({ where: { serial: paramStr(req.params.id), ...categoryWhere(categoryScope(req.roles, 'shortlist')) } });
         if (!existing) return res.status(403).json({ message: `You do not have access to this shortlist record.` });

         const resp = await ams.sortedApplicant.delete({
            where: { serial: paramStr(req.params.id) }
         })
         if (resp) {
            const ups = await ams.applicant.update({
               where: { serial: paramStr(req.params.id) },
               data: { sorted: false }
            })
            res.status(200).json(resp)

         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Matriculants */

   async fetchMatriculantList(req: any, res: Response) {
      try {
         const resp = await ams.fresher.findMany({ where: { admission: { default: true }, ...categoryWhere(categoryScope(req.roles, 'matriculant')) }, orderBy: { createdAt: 'asc' } })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchMatriculants(req: any, res: Response) {
      const { page = 1, pageSize = 9, keyword = '' }: any = req.query;
      const offset = (page - 1) * pageSize;
      // UG/PG scope is derived from the caller's role, never a client-
      // supplied query param (see fetchApplicants for the same fix).
      const groupCondition = categoryWhere(categoryScope(req.roles, 'matriculant'));


      let searchCondition: any = {
         where: {
            admission: { default: true },
            ...groupCondition
         }
      }
      try {
         if (keyword) searchCondition = {
            where: {
               admission: { default: true },
               ...groupCondition,
               OR: [
                  { serial: { contains: keyword } },
                  //{ sessionMode: { contains: keyword } },
                  { program: { shortName: { contains: keyword } } },
                  { category: { title: { contains: keyword } } },
                  { student: { fname: { contains: keyword } } },
                  { student: { mname: { contains: keyword } } },
                  { student: { lname: { contains: keyword } } },
               ],
            }
         }
         const resp = await ams.$transaction([
            ams.fresher.count({
               ...(searchCondition),
            }),
            ams.fresher.findMany({
               ...(searchCondition),
               skip: offset,
               take: Number(pageSize),
               include: {
                  admission: true, program: true, major: true, category: true, student: true
               },
               orderBy: { 'createdAt': 'desc' }
            })
         ]);

         if (resp && resp[1]?.length) {
            res.status(200).json({
               totalPages: Math.ceil(resp[0] / pageSize) ?? 0,
               totalData: resp[1]?.length,
               data: resp[1],
            })
         } else {
            res.status(204).json({ message: `no records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchMatriculant(req: any, res: Response) {
      try {
         const resp = await ams.fresher.findFirst({
            where: { serial: paramStr(req.params.id), ...categoryWhere(categoryScope(req.roles, 'matriculant')) },
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
         })
         if (resp) {
            console.log(resp)
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Self-service counterpart — PgStepPrintLetter.tsx (the applicant
   // portal's "Print Admission Letter" page) needs the caller's own
   // matriculant/letter record, but applicants hold no matriculant:: role,
   // so the :id route above always 403s them. Same reasoning as the other
   // fetchMy* methods: identity from req.userId, no category scope needed.
   async fetchMyMatriculant(req: any, res: Response) {
      try {
         const resp = await ams.fresher.findFirst({
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
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async postMatriculant(req: any, res: Response) {
      try {
         const { serial, programId, semesterNum, sessionMode } = req.body

         // getBillCodePrisma silently returns undefined for an unrecognized
         // semesterNum, which would drop the OR filter below and match
         // whichever bill happens to come back first for this program —
         // wrong bill picked with no error, rather than an obvious failure.
         if (!programId || ![1, 3, 5].includes(Number(semesterNum)) || !sessionMode) {
            return res.status(422).json({ message: `Programme, entry year and session must all be selected before admitting.` });
         }

         const sorted: any = await ams.sortedApplicant.findFirst({ where: { serial }, include: { profile: true, admission: { include: { session: true } } } })
         if (!sorted) return res.status(404).json({ message: `no record found` });

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
         const inScope = (scope: 'UG' | 'PG' | null) => scope === 'PG' ? sorted.categoryId === 'PG' : scope === 'UG' ? sorted.categoryId !== 'PG' : false;
         if (!inScope(categoryScope(req.roles, 'matriculant')) && !inScope(categoryScope(req.roles, 'shortlist'))) {
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

         let { sellType, admission: { id: admissionId, session: { id: sessionId }, admittedAt }, categoryId, profile: { titleId, countryId, regionId, religionId, disabilityId, maritalId, fname, lname, mname, gender, dob, hometown, phone, email, residentAddress } } = sorted ?? null;
         const letterId = sorted?.admission[`${categoryId?.toLowerCase()}letterId`];

         if (!phone) {
            return res.status(422).json({ message: `This applicant's phone number is missing — required to generate their account and send notifications.` });
         }
         if (!fname || !lname) {
            return res.status(422).json({ message: `This applicant's name is incomplete — required to generate their institutional email.` });
         }

         // Bill Info
         const semcode = getBillCodePrisma(Number(semesterNum))
         const feeType = countryId == '96b0a1d5-7899-4b9a-bcbe-7a72eee6572c' ? 'GH' : 'INT';
         const bill: any = await ams.bill.findFirst({ where: { programId, sessionId, type: feeType, OR: semcode } })
         if (!bill) {
            const yearLabel = { 1: 'Year 1', 3: 'Year 2', 5: 'Year 3' }[Number(semesterNum)] || `semester ${semesterNum}`;
            return res.status(422).json({ message: `No fee bill has been configured for this programme (${yearLabel}, ${feeType === 'GH' ? 'Ghanaian' : 'International'} fees) in the ${sorted.admission.session.title || 'selected'} session. Set up billing for this programme before admitting.` });
         }

         // Emergency & Guardian Info
         let guardian: any = await ams.stepGuardian.findFirst({ where: { serial } })
         if (!guardian) {
            return res.status(422).json({ message: `This applicant has not completed the Guardian Information step — required before admission.` });
         }
         if (!guardian.phone) {
            return res.status(422).json({ message: `This applicant's guardian phone number is missing.` });
         }

         // Check email
         let count = 1;
         let isNew = true;
         let uname = `${fname?.replaceAll(' ', '')}.${lname}`.toLowerCase();
         while (isNew) {
            const ck = await ams.student.findFirst({ where: { instituteEmail: { startsWith: `${uname}${count > 1 ? count : ''}` } } });
            if (ck) count = count + 1;
            else isNew = false;
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
         const studentData = { id: serial, fname, mname, lname, gender, dob, semesterNum, entrySemesterNum: semesterNum, entryDate: admittedAt, hometown, phone, email, address: residentAddress, instituteEmail, guardianName: `${guardian?.fname} ${guardian?.mname && guardian?.mname + ' '}${guardian?.lname}`, guardianPhone: guardian?.phone }
         const fresherData = { sellType, semesterNum, sessionMode, username, password }
         const ssoData = { tag: serial, username: instituteEmail, password: hashPassword(password), } // AUCC
         //const ssoData = { tag:serial, username, password:sha1(password) }  // MLK & Others
         // Populate Student Information
         const resp = await ams.student.upsert({
            where: { id: serial },
            update: {
               ...studentData,
               ...programId && ({ program: { connect: { id: programId } } }),
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...countryId && ({ country: { connect: { id: countryId } } }),
               ...regionId && ({ region: { connect: { id: regionId } } }),
               ...religionId && ({ religion: { connect: { id: religionId } } }),
               ...maritalId && ({ marital: { connect: { id: maritalId } } }),
               ...disabilityId && ({ disability: { connect: { id: disabilityId } } }),
            },
            create: {
               ...studentData,
               ...programId && ({ program: { connect: { id: programId } } }),
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...countryId && ({ country: { connect: { id: countryId } } }),
               ...regionId && ({ region: { connect: { id: regionId } } }),
               ...religionId && ({ religion: { connect: { id: religionId } } }),
               ...maritalId && ({ marital: { connect: { id: maritalId } } }),
               ...disabilityId && ({ disability: { connect: { id: disabilityId } } }),
            }
         })

         if (resp) {
            // Populate SSO Account
            await ams.user.upsert({
               where: { tag: serial },
               create: {
                  ...ssoData,
                  group: { connect: { id: 1 } },
               },
               update: {
                  ...ssoData,
                  group: { connect: { id: 1 } },
               },
            })

            // Populate Fresher Information
            await ams.fresher.upsert({
               where: { serial },
               update: {
                  ...fresherData,
                  ...admissionId && ({ admission: { connect: { id: admissionId } } }),
                  ...programId && ({ program: { connect: { id: programId } } }),
                  ...bill && ({ bill: { connect: { id: bill?.id } } }),
                  ...sessionId && ({ session: { connect: { id: sessionId } } }),
                  ...categoryId && ({ category: { connect: { id: categoryId } } }),
                  ...serial && ({ student: { connect: { id: serial } } }),
                  ...letterId && ({ letter: { connect: { id: letterId } } }),
               },
               create: {
                  ...fresherData,
                  ...admissionId && ({ admission: { connect: { id: admissionId } } }),
                  ...programId && ({ program: { connect: { id: programId } } }),
                  ...bill && ({ bill: { connect: { id: bill?.id } } }),
                  ...sessionId && ({ session: { connect: { id: sessionId } } }),
                  ...categoryId && ({ category: { connect: { id: categoryId } } }),
                  ...serial && ({ student: { connect: { id: serial } } }),
                  ...letterId && ({ letter: { connect: { id: letterId } } }),
               }
            })

            // Update Applicant Status 
            await ams.sortedApplicant.update({
               where: { serial },
               data: { admitted: true },
            })

            // Send Applicant Notification — isolated so a gateway hiccup can't
            // turn an admission that already fully succeeded (student/user/
            // fresher created, admitted flag flipped) into a reported error.
            try {
               const msg = `Congratulations ${studentData?.fname}! You have been admitted into AUCB, Kindly visit https://portal.aucb.edu.gh to print your admission letter. Thank you!`
               await sms(phone, msg);
            } catch (smsError: any) {
               console.log('postMatriculant SMS send failed:', smsError?.message)
            }

            // Return Response
            return res.status(200).json(resp)

         } else {
            return res.status(204).json({ message: `no records found` })
         }

      } catch (error: any) {
         console.log(error?.message)
         return res.status(500).json({ message: error?.message })
      }
   }

   async updateMatriculant(req: any, res: Response) {
      try {
         const { admissionId, sessionId, billId, categoryId, programId, majorId, } = req.body
         delete req.body.admissionId; delete req.body.sessionId;
         delete req.body.billId; delete req.body.programId;
         delete req.body.majorId; delete req.body.categoryId;

         const existing = await ams.fresher.findFirst({ where: { serial: paramStr(req.params.id), ...categoryWhere(categoryScope(req.roles, 'matriculant')) } });
         if (!existing) return res.status(403).json({ message: `You do not have access to this matriculant.` });

         // Was updating ams.sortedApplicant (the shortlist model) instead of
         // ams.fresher (matriculant) — a copy-paste bug from updateShortlist.
         const resp = await ams.fresher.update({
            where: { serial: paramStr(req.params.id) },
            data: {
               ...req.body,
               ...admissionId && ({ admission: { connect: { id: admissionId } } }),
               ...sessionId && ({ session: { connect: { id: sessionId } } }),
               ...billId && ({ bill: { connect: { id: billId } } }),
               ...categoryId && ({ category: { connect: { id: categoryId } } }),
               ...programId && ({ program: { connect: { id: programId } } }),
               ...majorId && ({ major: { connect: { id: majorId } } }),
            },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async deleteMatriculant(req: any, res: Response) {
      try {
         const serial = paramStr(req.params.id);

         const existing = await ams.fresher.findFirst({ where: { serial, ...categoryWhere(categoryScope(req.roles, 'matriculant')) } });
         if (!existing) return res.status(403).json({ message: `You do not have access to this matriculant.` });

         // Remove Matriculant Data
         const resp = await ams.fresher.delete({
            where: { serial }
         })
         // Remove Student Data
         const student = await ams.student.delete({
            where: { id: serial }
         })
         // Remove SSO Account
         const sso = await ams.user.deleteMany({
            where: { tag: serial }
         })
         // Update Applicant Status 
         const ups = await ams.sortedApplicant.update({
            where: { serial },
            data: { admitted: false },
         })

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `No records found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Helpers */
   async fetchSubjectList(req: Request, res: Response) {
      try {
         const resp = await ams.subject.findMany({
            where: { status: true },
            orderBy: { createdAt: 'asc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchInstituteList(req: Request, res: Response) {
      try {
         const resp = await ams.instituteCategory.findMany({
            where: { status: true },
            orderBy: { createdAt: 'asc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchCertList(req: Request, res: Response) {
      try {
         const resp = await ams.certCategory.findMany({
            where: { status: true },
            orderBy: { createdAt: 'asc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchWeightList(req: Request, res: Response) {
      try {
         const resp = await ams.gradeWeight.findMany({
            where: { status: true },
            orderBy: { createdAt: 'asc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchAwardList(req: Request, res: Response) {
      try {
         const resp = await ams.awardClass.findMany({
            where: { status: true },
            orderBy: { id: 'asc' }
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchStageList(req: Request, res: Response) {
      try {
         const resp = await ams.stage.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchApplytypeList(req: Request, res: Response) {
      try {
         const resp = await ams.applyType.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchAmsPriceList(req: Request, res: Response) {
      try {
         const resp = await ams.amsPrice.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async fetchAmsDocList(req: Request, res: Response) {
      try {
         const resp = await ams.documentCategory.findMany({
            where: { status: true },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Step Applicant - Configuration */
   async fetchStepApplicant(req: Request, res: Response) {
      try {
         const resp = await ams.applicant.findUnique({
            where: { serial: paramStr(req.params.id) },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepApplicant(req: Request, res: Response) {
      try {
         const { serial, stageId, applyTypeId, categoryId } = req.body
         delete req.body.stageId; delete req.body.serial;
         delete req.body.applyTypeId;
         delete req.body.categoryId;
         // Admission Session
         const voucher = await ams.voucher.findFirst({ where: { serial } })
         // Application Form Schema for Chosen Category
         const form = await ams.amsForm.findFirst({ where: { categoryId } })
         if (form) req.body.meta = form?.meta

         // A new photo arrives as a raw base64 data URI — write it straight
         // to disk and store just the reference (see util/amsFileStorage.ts)
         // instead of the blob. Left untouched when no new photo is
         // submitted for this save, so an existing (already-migrated or
         // not-yet-migrated) photo/path is never clobbered.
         if (typeof req.body.photo === 'string' && req.body.photo.startsWith('data:')) {
            const { buffer } = decodeBase64Field(req.body.photo);
            const relPath = applicantPhotoPath(serial);
            if (writeAmsFile(relPath, buffer)) {
               req.body.path = relPath;
               req.body.photo = null;
            }
         }

         const resp = await ams.applicant.upsert({
            where: { serial },
            create: {
               ...req.body,
               serial,
               ...stageId && ({ stage: { connect: { id: stageId } } }),
               ...applyTypeId && ({ applyType: { connect: { id: applyTypeId } } }),
               ...voucher && ({ admission: { connect: { id: voucher?.admissionId } } }),
            },
            update: {
               ...req.body,
               ...stageId && ({ stage: { connect: { id: stageId } } }),
               ...applyTypeId && ({ applyType: { connect: { id: applyTypeId } } }),
               ...voucher && ({ admission: { connect: { id: voucher?.admissionId } } }),
            }
         })

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Step Profile */
   async fetchStepProfile(req: Request, res: Response) {
      try {
         const resp = await ams.stepProfile.findUnique({
            where: { serial: paramStr(req.params.id) },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepProfile(req: Request, res: Response) {
      try {
         const { serial, titleId, regionId, religionId, countryId, nationalityId, maritalId, disabilityId } = req.body
         delete req.body.titleId; delete req.body.regionId;
         delete req.body.religionId; delete req.body.countryId;
         delete req.body.nationalityId; delete req.body.maritalId;
         delete req.body.disabilityId; delete req.body.serial;
         delete req.body.id;

         const resp = await ams.stepProfile.upsert({
            where: { serial },
            create: {
               serial,
               //applicant: { connect: { profileId: serial }},
               ...req.body,
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...regionId && ({ region: { connect: { id: regionId } } }),
               ...religionId && ({ religion: { connect: { id: religionId } } }),
               ...countryId && ({ country: { connect: { id: countryId } } }),
               ...nationalityId && ({ nationality: { connect: { id: nationalityId } } }),
               ...maritalId && ({ marital: { connect: { id: maritalId } } }),
               ...disabilityId && ({ disability: { connect: { id: disabilityId } } }),

            },
            update: {
               ...req.body,
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...regionId && ({ region: { connect: { id: regionId } } }),
               ...religionId && ({ religion: { connect: { id: religionId } } }),
               ...countryId && ({ country: { connect: { id: countryId } } }),
               ...nationalityId && ({ nationality: { connect: { id: nationalityId } } }),
               ...maritalId && ({ marital: { connect: { id: maritalId } } }),
               ...disabilityId && ({ disability: { connect: { id: disabilityId } } }),
            }
         })

         if (resp) {
            // Update Applicant with ProfileId
            await ams.applicant.update({ where: { serial }, data: { profile: { connect: { serial } } } })
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveProfile(req: Request, res: Response) {
      try {
         const { id, titleId } = req.body
         delete req.body.titleId; delete req.body.id;
         req.body.dob = moment(req.body.dob)

         const resp = await ams.stepProfile.update({
            where: { serial: id },
            data: {
               ...req.body,
               ...titleId && ({ title: { connect: { id: titleId } } }),
            }
         })

         if (resp) {
            // Get Student & Check for name change
            let st: any = await ams.student.findFirst({ where: { id } });
            if (st) {
               let email = st.instituteEmail;
               //   console.log(st.fname?.toLowerCase(),req.body.fname.toLowerCase(),st.lname?.toLowerCase(),req.body.lname.toLowerCase(),st.instituteEmail);
               if ((st.fname?.toLowerCase() != req.body.fname.toLowerCase() || st.lname?.toLowerCase() != req.body.lname.toLowerCase()) && st.instituteEmail) {
                  let username = `${req.body.fname.toLowerCase()}.${req.body.lname.toLowerCase()}`;
                  let domain = `${st.instituteEmail.split('@')[1]}`;
                  let count = 1;
                  let runLoop = true;
                  while (runLoop) {
                     email = `${username}${count > 1 ? count : ''}@${domain}`;
                     const isExist = await ams.user.findFirst({ where: { username: email } });
                     count++;
                     if (!isExist) runLoop = false;
                  }
               }
               // Update Student
               await ams.student.update({ where: { id }, data: { ...req.body, instituteEmail: email } });
               // Update SSO User with Email
               if (st.instituteEmail) await ams.user.updateMany({ where: { tag: id }, data: { username: email } })
               console.log(email)
            }
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Step Guardian */
   async fetchStepGuardian(req: Request, res: Response) {
      try {
         const resp = await ams.stepGuardian.findUnique({
            where: { serial: paramStr(req.params.id) },
         })
         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepGuardian(req: Request, res: Response) {
      try {
         const { serial, titleId, relationId } = req.body
         delete req.body.titleId; delete req.body.serial;
         delete req.body.relationId;;

         const resp = await ams.stepGuardian.upsert({
            where: { serial },
            create: {
               ...req.body,
               serial,
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...relationId && ({ relation: { connect: { id: relationId } } }),
            },
            update: {
               ...req.body,
               ...titleId && ({ title: { connect: { id: titleId } } }),
               ...relationId && ({ relation: { connect: { id: relationId } } }),
            }
         })

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Step Education */
   async fetchStepEducation(req: Request, res: Response) {
      try {
         const resp = await ams.stepEducation.findMany({
            where: { serial: paramStr(req.params.id) },
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepEducation(req: Request, res: Response) {
      try {
         const data = req.body;
         await ams.stepEducation.deleteMany({ where: { serial: req.body[0].serial } });
         const resp = await Promise.all(data?.map(async (row: any) => {
            const { id, instituteCategoryId, certCategoryId } = row;
            delete row?.instituteCategoryId; delete row?.id;
            delete row?.certCategoryId;

            return await ams.stepEducation.upsert({
               where: { id: (id ?? '') },
               create: {
                  ...row,
                  ...instituteCategoryId && ({ instituteCategory: { connect: { id: instituteCategoryId } } }),
                  ...certCategoryId && ({ certCategory: { connect: { id: certCategoryId } } }),
               },
               update: {
                  ...row,
                  ...instituteCategoryId && ({ instituteCategory: { connect: { id: instituteCategoryId } } }),
                  ...certCategoryId && ({ certCategory: { connect: { id: certCategoryId } } }),
               }
            })
         }))

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }


   /* Step Result */
   async fetchStepResult(req: Request, res: Response) {
      try {
         const resp = await ams.stepResult.findMany({
            where: { serial: paramStr(req.params.id) },
            include: { grades: true }
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepResult(req: Request, res: Response) {
      try {
         const data = req.body;
         console.log(data)
         await ams.stepResult.deleteMany({ where: { serial: req.body[0].serial } });
         await ams.stepGrade.deleteMany({ where: { serial: req.body[0].serial } });

         // Results 
         const resp = await Promise.all(data?.map(async (row: any) => {
            const { certCategoryId, grades } = row;
            delete row?.id;
            delete row?.certCategoryId;
            delete row?.grades;

            // Grades
            const newGrades = grades?.map((item: any) => {
               const { resultId, gradeWeightId, subjectId } = item;
               delete item?.resultId;
               delete item?.gradeWeightId;
               delete item?.subjectId;
               delete item?.id;
               return ({
                  ...item,
                  ...resultId && ({ result: { connect: { id: resultId } } }),
                  ...gradeWeightId && ({ gradeWeight: { connect: { id: gradeWeightId } } }),
                  ...subjectId && ({ subject: { connect: { id: subjectId } } }),
               })
            })
            return await ams.stepResult.upsert({
               where: { id: '' },
               create: {
                  ...row,
                  ...certCategoryId && ({ certCategory: { connect: { id: certCategoryId } } }),
                  grades: { create: newGrades }
               },
               update: {}
            })

            // return await ams.stepResult.createMany({
            //    data: { 
            //       ...row, 
            //       certCategoryId,
            //       // ...certCategoryId && ({ certCategory: { connect: { id: certCategoryId }}}),
            //       grades: { create: newGrades }
            //    }
            // })
         }))

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Step Employment */
   async fetchStepEmployment(req: Request, res: Response) {
      try {
         const resp = await ams.stepEmployment.findMany({
            where: { serial: paramStr(req.params.id) },
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepEmployment(req: Request, res: Response) {
      try {
         const data = req.body;
         await ams.stepEmployment.deleteMany({ where: { serial: req.body[0].serial } });
         const resp = await Promise.all(data?.map(async (row: any) => {
            const { id } = row;
            return await ams.stepEmployment.upsert({
               where: { id: (id || '') },
               create: row,
               update: row
            })
         }))

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }

      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Step Document */
   async fetchStepDocument(req: Request, res: Response) {
      try {
         const resp = await ams.stepDocument.findMany({
            where: { serial: paramStr(req.params.id) },
            orderBy: { 'createdAt': 'asc' }
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepDocument(req: Request, res: Response) {
      try {

         const data = req.body;
         const files: any = req.files;
         const tag = data?.serial;
         let idx: any = [];
         let aidx: any = [];

         console.log(files, req.body);
         const resp = await Promise.all(Array.from({ length: Number(data?.count) }).map(async (_, i: number) => {
            const id = data[`id_${i}`];
            aidx.push(id);
            if (id) idx.push(id);
            const documentCategoryId = data[`documentCategoryId_${i}`];
            let row = { serial: data.serial };
            // Insert into Record — base64/path are left untouched here; they
            // only change below, and only once a new file has actually been
            // written to disk (previously this unconditionally overwrote
            // base64 with a file-reference URL even when no file was
            // uploaded, which silently destroyed the original document data
            // whenever a step was resaved without a new upload).
            const rec = await ams.stepDocument.upsert({
               where: { id: (id ?? '') },
               create: {
                  ...row,
                  ...documentCategoryId && ({ documentCategory: { connect: { id: documentCategoryId } } }),
               },
               update: {
                  ...row,
                  ...documentCategoryId && ({ documentCategory: { connect: { id: documentCategoryId } } }),
               }
            })
            if (rec?.id) {
               idx.push(rec?.id);
               aidx.push(rec?.id);
            }
            // No new file for this slot — leave the existing base64/path as-is.
            if (!files || !files[`doc_${i}`]) return rec;

            const relPath = stepDocumentPath(tag, rec?.id);
            const dest = path.join(__dirname, `/../../public/${relPath}`);
            return files[`doc_${i}`].mv(dest, async function (err: any) {
               if (err) return res.status(500).send(err);
               return await ams.stepDocument.update({ where: { id: rec?.id }, data: { path: relPath, base64: null } });
            })
         }))

         if (resp) {
            // Clean Unwanted Records
            await ams.stepDocument.deleteMany({ where: { serial: data?.serial, id: { notIn: idx } } });
            // Clean Unwanted Files
            aidx.filter((r: any) => !idx.includes(r)).map((d: any) => {
               const relPath = stepDocumentPath(tag, d);
               if (amsFileExists(relPath)) removeAmsFile(relPath);
            })
            // Return Response
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   // Counts only — lets the "migrate stored files" admin button show what a
   // real run would do before anyone commits to it. A row counts as
   // "pending" once it has blob data and no path yet; stepDocument rows
   // whose base64 was already overwritten with a dead file-reference URL
   // (a pre-existing bug in saveStepDocument, fixed above) have nothing left
   // to migrate and are reported separately as unrecoverable.
   async previewBlobMigration(req: Request, res: Response) {
      try {
         const applicantPending = await ams.applicant.count({ where: { photo: { not: null }, path: null } });
         const applicantMigrated = await ams.applicant.count({ where: { path: { not: null } } });

         const docCandidates = await ams.stepDocument.findMany({
            where: { base64: { not: null }, path: null },
            select: { base64: true },
         });
         const docUnrecoverable = docCandidates.filter((d) => isUnrecoverableUrlReference(d.base64)).length;
         const docPending = docCandidates.length - docUnrecoverable;
         const docMigrated = await ams.stepDocument.count({ where: { path: { not: null } } });

         res.status(200).json({
            applicant: { pending: applicantPending, migrated: applicantMigrated },
            stepDocument: { pending: docPending, unrecoverable: docUnrecoverable, migrated: docMigrated },
         });
      } catch (error: any) {
         console.log(error);
         return res.status(500).json({ message: error.message });
      }
   }

   // The manual trigger: moves every existing applicant.photo / stepDocument
   // .base64 blob still in the DB out to a file on disk and records the
   // reference in `path`. Idempotent (only touches rows with path IS NULL,
   // so re-running after a partial failure just picks up where it left off)
   // and per-row safe (the blob column is only cleared after the file write
   // is verified on disk — a failed write leaves that row's blob untouched
   // for the next run rather than losing it).
   async runBlobMigration(req: Request, res: Response) {
      try {
         const summary = {
            applicant: { migrated: 0, failed: 0, errors: [] as any[] },
            stepDocument: { migrated: 0, unrecoverable: 0, failed: 0, errors: [] as any[] },
         };

         const applicants = await ams.applicant.findMany({
            where: { photo: { not: null }, path: null },
            select: { serial: true, photo: true },
         });
         for (const a of applicants) {
            try {
               const { buffer } = decodeBase64Field(a.photo!);
               const relPath = applicantPhotoPath(a.serial);
               if (writeAmsFile(relPath, buffer)) {
                  await ams.applicant.update({ where: { serial: a.serial }, data: { path: relPath, photo: null } });
                  summary.applicant.migrated++;
               } else {
                  summary.applicant.failed++;
                  summary.applicant.errors.push({ serial: a.serial, error: "file write verification failed" });
               }
            } catch (err: any) {
               summary.applicant.failed++;
               summary.applicant.errors.push({ serial: a.serial, error: err.message });
            }
         }

         const docs = await ams.stepDocument.findMany({
            where: { base64: { not: null }, path: null },
            select: { id: true, serial: true, base64: true, mime: true },
         });
         for (const d of docs) {
            if (isUnrecoverableUrlReference(d.base64)) {
               summary.stepDocument.unrecoverable++;
               continue;
            }
            try {
               const { buffer } = decodeBase64Field(d.base64!, d.mime);
               const relPath = stepDocumentPath(d.serial, d.id);
               if (writeAmsFile(relPath, buffer)) {
                  await ams.stepDocument.update({ where: { id: d.id }, data: { path: relPath, base64: null } });
                  summary.stepDocument.migrated++;
               } else {
                  summary.stepDocument.failed++;
                  summary.stepDocument.errors.push({ id: d.id, error: "file write verification failed" });
               }
            } catch (err: any) {
               summary.stepDocument.failed++;
               summary.stepDocument.errors.push({ id: d.id, error: err.message });
            }
         }

         res.status(200).json(summary);
      } catch (error: any) {
         console.log(error);
         return res.status(500).json({ message: error.message });
      }
   }

   /* Step Choice */
   async fetchStepChoice(req: Request, res: Response) {
      try {
         const resp = await ams.stepChoice.findMany({
            where: { serial: paramStr(req.params.id) },
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepChoice(req: Request, res: Response) {
      try {
         const data = req.body;
         await ams.stepChoice.deleteMany({ where: { serial: req.body[0].serial } });
         const resp = await Promise.all(data?.map(async (row: any) => {
            const { id, programId, majorId } = row;
            delete row?.programId; delete row?.majorId; delete row?.id;

            return await ams.stepChoice.upsert({
               where: { id: (id || '') },
               create: {
                  ...row,
                  ...programId && ({ program: { connect: { id: programId } } }),
                  ...majorId && ({ major: { connect: { id: majorId } } }),
               },
               update: {
                  ...row,
                  ...programId && ({ program: { connect: { id: programId } } }),
                  ...majorId && ({ major: { connect: { id: majorId } } }),
               }
            })
         }))
         if (resp) {
            // Update Applicant First Choice
            //const ch = await ams.stepChoice.findFirst({ where: { serial }})
            await ams.applicant.update({ where: { serial: req.body[0].serial }, data: { choiceId: resp[0].id } })

            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Step Referee */
   async fetchStepReferee(req: Request, res: Response) {
      try {
         const resp = await ams.stepReferee.findMany({
            where: { serial: paramStr(req.params.id) },
         })
         if (resp?.length) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   async saveStepReferee(req: Request, res: Response) {
      try {

         const data = req.body;
         await ams.stepReferee.deleteMany({ where: { serial: req.body[0].serial } });
         const resp = await Promise.all(data?.map(async (row: any) => {
            const { id, titleId } = row;
            delete row?.titleId;
            return await ams.stepReferee.upsert({
               where: { id: (id || '') },
               create: {
                  ...row,
                  ...titleId && ({ title: { connect: { id: titleId } } }),
               },
               update: {
                  ...row,
                  ...titleId && ({ title: { connect: { id: titleId } } }),
               },
            })
         }))

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Step Review */
   async saveStepReview(req: Request, res: Response) {
      try {
         const { serial, choiceId } = req.body;
         delete req.body?.choiceId;
         console.log(req.body)
         const resp = await ams.applicant.update({
            where: { serial },
            data: {
               ...req.body,
               ...choiceId && ({ choice: { connect: { id: choiceId } } }),
            },
         })

         if (resp) {
            res.status(200).json(resp)
         } else {
            res.status(204).json({ message: `no record found` })
         }
      } catch (error: any) {
         console.log(error)
         return res.status(500).json({ message: error.message })
      }
   }

   /* Dashboard & Statistics */
   async fetchDashboard(req: Request, res: Response) {
      try {
         // Main Statistics
         const session: any = await ams.admission.findFirst({ where: { default: true } }); // Session
         const applicant: any = await ams.applicant.count({ where: { admission: { default: true } } }); // Applicant
         const vsale: any = await ams.activityFinanceVoucher.findMany({ where: { admission: { default: true } }, select: { transaction: true } }); // Sale
         const sold: any = await ams.voucher.count({ where: { admission: { default: true }, soldAt: { not: null } } }); // Sale
         const unsold: any = await ams.voucher.count({ where: { admission: { default: true }, soldAt: null } }); // Sale
         const voucher = await ams.voucher.count({ where: { admission: { default: true } } }); // vouchers
         const sort = await ams.sortedApplicant.count({ where: { admission: { default: true } } }); // sorted
         const submit = await ams.applicant.count({ where: { admission: { default: true }, submitted: true } }); // submitted
         const fresher = await ams.fresher.count({ where: { admission: { default: true } } }); // fresher

         // Program Statistics
         const progs = await ams.program.findMany();
         const program = await Promise.all(progs.map(async (r: any) => {
            // Applicant
            const m_applicant: any = await ams.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;
            const f_applicant: any = await ams.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;

            // Sorted
            const m_sort: any = await ams.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_sorted a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;
            const f_sort: any = await ams.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_sorted a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;

            // Submitted
            const m_submit: any = await ams.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session?.id} and c.programId = ${r?.id} and a.submitted = 1`;
            const f_submit: any = await ams.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_applicant a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session?.id} and c.programId = ${r?.id} and a.submitted = 1`;

            // Admitted
            const m_fresher: any = await ams.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_fresher a on p.serial = a.serial where p.gender = 'M' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;
            const f_fresher: any = await ams.$queryRaw`select * from ams_step_choice c left join ams_step_profile p on p.serial = c.serial left join ams_fresher a on p.serial = a.serial where p.gender = 'F' and a.admissionId = ${session?.id} and c.programId = ${r?.id}`;
            return ({
               label: r.shortName,
               applicant: { m: (m_applicant?.length || 0), f: (f_applicant?.length || 0) },
               sort: { m: (m_sort?.length || 0), f: (f_sort?.length || 0) },
               submit: { m: (m_submit?.length || 0), f: (f_submit?.length || 0) },
               fresher: { m: (m_fresher?.length || 0), f: (f_fresher?.length || 0) },
            })
         }));

         let data = {
            session: session?.title,
            general: {
               sale: vsale?.reduce((acc: any, cur: any) => acc + cur?.transaction?.amount, 0) || 0,
               applicant,
               sort,
               submit,
               fresher,
               voucher,
               sold,
               unsold
            },
            program
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


}