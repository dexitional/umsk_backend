"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const logController_1 = __importDefault(require("../controller/logController"));
const { verifyToken } = require("../middleware/verifyToken");
const { requireRole } = require("../middleware/requireRole");
// Log Module -- restricted to the audit::admin role
// (provisioned by prisma/sql/2026-10-03_add_audit_admin_role.sql).
const LOG_ROLES = ['audit::admin'];
class LogRoute {
    constructor() {
        this.router = (0, express_1.Router)();
        this.controller = new logController_1.default();
        this.initializeRoute();
    }
    initializeRoute() {
        this.router.get('/', [verifyToken, requireRole(LOG_ROLES)], this.controller.fetchLogs);
        this.router.get('/summary', [verifyToken, requireRole(LOG_ROLES)], this.controller.fetchSummary);
        this.router.get('/:id', [verifyToken, requireRole(LOG_ROLES)], this.controller.fetchLog);
    }
}
exports.default = new LogRoute().router;
