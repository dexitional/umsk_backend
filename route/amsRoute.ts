import { Router } from 'express'
import AmsController from '../controller/amsController'

const { verifyToken } = require("../middleware/verifyToken");
const { requireRole } = require("../middleware/requireRole");

const APPLICANT_VIEW_ROLES = ['applicant::admin-ug', 'applicant::clerk-ug', 'applicant::admin-pg', 'applicant::clerk-pg'];
const APPLICANT_ADMIN_ROLES = ['applicant::admin-ug', 'applicant::admin-pg'];

const SHORTLIST_VIEW_ROLES = ['shortlist::admin-ug', 'shortlist::clerk-ug', 'shortlist::admin-pg', 'shortlist::clerk-pg'];
const SHORTLIST_ADMIN_ROLES = ['shortlist::admin-ug', 'shortlist::admin-pg'];
// Shortlist creation is triggered from the applicant page's "Shortlist"
// button (an applicant admin action), not a separate shortlist-module UI.
const SHORTLIST_CREATE_ROLES = [...SHORTLIST_ADMIN_ROLES, ...APPLICANT_ADMIN_ROLES];

const MATRICULANT_ROLES = ['matriculant::clerk-ug', 'matriculant::clerk-pg'];
// Matriculants are also created via the shortlist "admit" action, triggered
// by a shortlist admin rather than someone holding a matriculant:: role.
const MATRICULANT_CREATE_ROLES = [...MATRICULANT_ROLES, 'shortlist::admin-ug', 'shortlist::admin-pg'];

// Full, unrestricted (no UG/PG scoping) access to admission reports — see
// loadReport in amsController.ts.
const ADMREPORT_ADMIN_ROLES = ['admreport::admin'];

class AmsRoute {

    router = Router();
    controller = new AmsController();

    constructor(){
       this.initializeRoute();
    }

    initializeRoute(){
      this.router.use(verifyToken);

      /* Reports */
      this.router.post('/report', [requireRole(ADMREPORT_ADMIN_ROLES)], this.controller.loadReport);

      /* Session */
       this.router.get('/sessions', this.controller.fetchSessions);
       this.router.get('/sessions/list', this.controller.fetchSessionList);
       this.router.get('/sessions/:id', this.controller.fetchSession);
       this.router.get('/sessions/:id/activate', this.controller.ActivateSession);
       this.router.post('/sessions', this.controller.postSession);
       this.router.patch('/sessions/:id', this.controller.updateSession);
       this.router.delete('/sessions/:id', this.controller.deleteSession);

      /* Voucher */
      this.router.get('/vouchers', this.controller.fetchVouchers);
      this.router.get('/vouchers/list', this.controller.fetchVoucherList);
      this.router.get('/vouchers/:id', this.controller.fetchVoucher);
      this.router.post('/vouchers/:id/sell', this.controller.sellVoucher);
      this.router.post('/vouchers/:id/recover', this.controller.recoverVoucher);
      this.router.post('/vouchers', this.controller.postVoucher);
      this.router.patch('/vouchers/:id', this.controller.updateVoucher);
      this.router.delete('/vouchers/:id', this.controller.deleteVoucher);

      /* Letter */
      this.router.get('/letters', this.controller.fetchLetters);
      this.router.get('/letters/list', this.controller.fetchLetterList);
      this.router.get('/letters/:id', this.controller.fetchLetter);
      this.router.post('/letters', this.controller.postLetter);
      this.router.patch('/letters/:id', this.controller.updateLetter);
      this.router.delete('/letters/:id', this.controller.deleteLetter);
       
      /* Applicant */
      // Self-service lookup — must be registered before '/applicants/:id' or
      // Express would match "me" as the :id param. Applicants log in with an
      // empty roles array (authController.ts's isApplicant branch), so these
      // stay gated only by the router.use(verifyToken) above (no requireRole);
      // identity comes from req.userId (the token's own tag), never a
      // client-supplied id, so there's nothing further to scope.
      this.router.get('/applicants/me', this.controller.fetchMyApplicant);
      this.router.get('/applicants/me/preview', this.controller.fetchMyApplicantPreview);
      this.router.get('/applicants', [requireRole(APPLICANT_VIEW_ROLES)], this.controller.fetchApplicants);
      this.router.get('/applicants/:id', [requireRole(APPLICANT_VIEW_ROLES)], this.controller.fetchApplicant);
      this.router.get('/applicants/:id/preview', [requireRole(APPLICANT_VIEW_ROLES)], this.controller.fetchApplicantPreview);
      this.router.post('/applicants', [requireRole(APPLICANT_ADMIN_ROLES)], this.controller.postApplicant);
      this.router.patch('/applicants/:id', [requireRole(APPLICANT_ADMIN_ROLES)], this.controller.updateApplicant);
      this.router.delete('/applicants/:id', [requireRole(APPLICANT_ADMIN_ROLES)], this.controller.deleteApplicant);

      // One-time (repeatable/idempotent) admin tool: moves any remaining
      // applicant.photo / stepDocument.base64 blobs out to files on disk and
      // records the reference in `path`. See amsController.previewBlobMigration
      // / runBlobMigration.
      this.router.get('/tools/blob-migration', [requireRole(APPLICANT_ADMIN_ROLES)], this.controller.previewBlobMigration);
      this.router.post('/tools/blob-migration', [requireRole(APPLICANT_ADMIN_ROLES)], this.controller.runBlobMigration);

      /* Shortlist */
      // Self-service lookup — must precede '/shortlists/:id' for the same
      // reason as '/applicants/me' above (Express would otherwise match
      // "me" as :id). Applicant portal only, no requireRole beyond the
      // router.use(verifyToken) above.
      this.router.get('/shortlists/me', this.controller.fetchMyShortlist);
      this.router.get('/shortlists', [requireRole(SHORTLIST_VIEW_ROLES)], this.controller.fetchShortlists);
      this.router.get('/shortlists/:id', [requireRole(SHORTLIST_VIEW_ROLES)], this.controller.fetchShortlist);
      this.router.post('/shortlists', [requireRole(SHORTLIST_CREATE_ROLES)], this.controller.postShortlist);
      this.router.patch('/shortlists/:id', [requireRole(SHORTLIST_ADMIN_ROLES)], this.controller.updateShortlist);
      this.router.delete('/shortlists/:id', [requireRole(SHORTLIST_ADMIN_ROLES)], this.controller.deleteShortlist);

      /* Matriculants */
      // Self-service lookup — applicant portal only, no requireRole beyond
      // the router.use(verifyToken) above. Registered before '/:id' for the
      // same "me" vs :id collision reason as '/applicants/me' above.
      this.router.get('/matriculants/me', this.controller.fetchMyMatriculant);
      this.router.get('/matriculants', [requireRole(MATRICULANT_ROLES)], this.controller.fetchMatriculants);
      this.router.get('/matriculants/list', [requireRole(MATRICULANT_ROLES)], this.controller.fetchMatriculantList);
      this.router.get('/matriculants/:id', [requireRole(MATRICULANT_ROLES)], this.controller.fetchMatriculant);
      this.router.post('/matriculants', [requireRole(MATRICULANT_CREATE_ROLES)], this.controller.postMatriculant);
      this.router.patch('/matriculants/:id', [requireRole(MATRICULANT_ROLES)], this.controller.updateMatriculant);
      this.router.delete('/matriculants/:id', [requireRole(MATRICULANT_ROLES)], this.controller.deleteMatriculant);

      /*  Helpers */
      this.router.get('/subjects/list', this.controller.fetchSubjectList);
      this.router.get('/institutes/list', this.controller.fetchInstituteList);
      this.router.get('/certificates/list', this.controller.fetchCertList);
      this.router.get('/gradeweights/list', this.controller.fetchWeightList);
      this.router.get('/awardclasses/list', this.controller.fetchAwardList);
      this.router.get('/stages/list', this.controller.fetchStageList);
      this.router.get('/applytypes/list', this.controller.fetchApplytypeList);
      this.router.get('/prices/list', this.controller.fetchAmsPriceList);
      this.router.get('/documents/list', this.controller.fetchAmsDocList);
      
      // Update Admitted Profile
      this.router.post('/profile', this.controller.saveProfile);
      
      // ADMISSSION PORTAL ROUTES
     
      /* Step - Configuration  */
      this.router.get('/step/applicant/:id', this.controller.fetchStepApplicant);
      this.router.post('/step/applicant', this.controller.saveStepApplicant);
      /*  Step - Profile */
      this.router.get('/step/profile/:id', this.controller.fetchStepProfile);
      this.router.post('/step/profile', this.controller.saveStepProfile);
      /*  Step - Guardian */
      this.router.get('/step/guardian/:id', this.controller.fetchStepGuardian);
      this.router.post('/step/guardian', this.controller.saveStepGuardian);
      /*  Step - Education */
      this.router.get('/step/education/:id', this.controller.fetchStepEducation);
      this.router.post('/step/education', this.controller.saveStepEducation);
      /*  Step - Result */
      this.router.get('/step/result/:id', this.controller.fetchStepResult);
      this.router.post('/step/result', this.controller.saveStepResult);
      /*  Step - Employment */
      this.router.get('/step/employment/:id', this.controller.fetchStepEmployment);
      this.router.post('/step/employment', this.controller.saveStepEmployment);
      /*  Step - Referee */
      this.router.get('/step/referee/:id', this.controller.fetchStepReferee);
      this.router.post('/step/referee', this.controller.saveStepReferee);
      /*  Step - Document */
      this.router.get('/step/document/:id', this.controller.fetchStepDocument);
      this.router.post('/step/document', this.controller.saveStepDocument);
      /*  Step - Choice */
      this.router.get('/step/choice/:id', this.controller.fetchStepChoice);
      this.router.post('/step/choice', this.controller.saveStepChoice);
      /*  Step - Review */
      this.router.post('/step/review', this.controller.saveStepReview);

    
      /* Dashboard Statistics */
      this.router.get('/dash', this.controller.fetchDashboard);
       
       
      
      
      
    }

   
}

export default new AmsRoute().router;