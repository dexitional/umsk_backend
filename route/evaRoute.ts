import { Router } from 'express';
import EvaController from '../controller/evaController';

const { verifyToken } = require("../middleware/verifyToken");
const { requireRole } = require("../middleware/requireRole");

const EVALUATION_ADMIN_ROLES = ['evaluation::admin'];

class EvaRoute {

    router = Router();
    controller = new EvaController();

    constructor() {
       this.initializeRoute();
    }

    initializeRoute() {
      this.router.use(verifyToken);

      // Fetch data for form
      this.router.get('/load', this.controller.loadData);
      this.router.get('/load-sts', this.controller.loadSTSData);
      this.router.get('/load-ims', this.controller.loadIMSData);
      this.router.get('/data/:indexno', this.controller.fetchForms);
      this.router.get('/options', this.controller.fetchOptions);
      this.router.get('/questions', this.controller.fetchQuestions);
      this.router.get('/guides', this.controller.fetchGuides);
      // Evaluation tracking statistics
      this.router.get('/tracking/stats', this.controller.getEvaluationTrackingStats);
      // Fetch data for dropdowns
      this.router.get('/courses', this.controller.fetchCourses);
      this.router.get('/staff', this.controller.fetchStaff);
      this.router.get('/students', this.controller.fetchStudents);
      this.router.get('/sessions', this.controller.fetchSessions);
      // Which evaluation forms are open right now, for the requesting student
      this.router.get('/forms/available', this.controller.fetchAvailableForms);
      // Submit evaluation
      this.router.post('/evaluations', this.controller.submitEvaluation);
      // Fetch evaluations (admin)
      this.router.get('/evaluations', this.controller.fetchEvaluations);
      // Get evaluation statistics — MUST be declared before
      // '/evaluations/:id' for the same reason (this was a pre-existing bug:
      // '/evaluations/stats' was previously shadowed by ':id', so it silently
      // 404'd against `fetchEvaluation({id: "stats"})`).
      this.router.get('/evaluations/stats', this.controller.getEvaluationStats);
      // Fetch single evaluation
      this.router.get('/evaluations/:id', this.controller.fetchEvaluation);
      // Delete evaluation
      this.router.delete('/evaluations/:id', this.controller.deleteEvaluation);

      /* Evaluation Forms (Admin — Evaluation Manager) */
      this.router.get('/evaluation-forms', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.fetchEvaluationForms);
      this.router.get('/evaluation-forms/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.fetchEvaluationForm);
      this.router.post('/evaluation-forms', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.postEvaluationForm);
      this.router.patch('/evaluation-forms/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.updateEvaluationForm);
      this.router.delete('/evaluation-forms/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.deleteEvaluationForm);
      this.router.post('/evaluation-forms/:id/year-groups', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.postEvaluationFormYearGroup);
      this.router.delete('/evaluation-forms/:id/year-groups/:yearGroup', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.deleteEvaluationFormYearGroup);

      this.router.post('/evaluation-questions', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.postEvaluationQuestion);
      this.router.patch('/evaluation-questions/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.updateEvaluationQuestion);
      this.router.delete('/evaluation-questions/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.deleteEvaluationQuestion);

      this.router.post('/evaluation-guides', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.postEvaluationGuide);
      this.router.patch('/evaluation-guides/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.updateEvaluationGuide);
      this.router.delete('/evaluation-guides/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.deleteEvaluationGuide);

      this.router.post('/evaluation-options', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.postEvaluationOption);
      this.router.patch('/evaluation-options/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.updateEvaluationOption);
      this.router.delete('/evaluation-options/:id', [requireRole(EVALUATION_ADMIN_ROLES)], this.controller.deleteEvaluationOption);
    }
}

export default new EvaRoute().router;