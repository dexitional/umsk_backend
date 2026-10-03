import { Router } from 'express'
import LogController from '../controller/logController'

const { verifyToken } = require("../middleware/verifyToken");
const { requireRole } = require("../middleware/requireRole");

// Log Module -- restricted to the audit::admin role
// (provisioned by prisma/sql/2026-10-03_add_audit_admin_role.sql).
const LOG_ROLES = ['audit::admin'];

class LogRoute {

    router = Router();
    controller = new LogController();

    constructor(){
       this.initializeRoute();
    }

    initializeRoute(){
      this.router.get('/', [verifyToken, requireRole(LOG_ROLES)], this.controller.fetchLogs);
      this.router.get('/summary', [verifyToken, requireRole(LOG_ROLES)], this.controller.fetchSummary);
      this.router.get('/:id', [verifyToken, requireRole(LOG_ROLES)], this.controller.fetchLog);
    }
}

export default new LogRoute().router;
