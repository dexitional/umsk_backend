"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fmsController_1 = __importDefault(require("../controller/fmsController"));
const { verifyToken } = require("../middleware/verifyToken");
const { requireRole } = require("../middleware/requireRole");
const DASHBOARD_ROLES = ['dashboard::clerk'];
const BILL_VIEW_ROLES = ['bill::admin', 'bill::clerk'];
const BILL_ADMIN_ROLES = ['bill::admin'];
const CHARGE_VIEW_ROLES = ['charge::admin', 'charge::clerk'];
const CHARGE_ADMIN_ROLES = ['charge::admin'];
// "Fine Late" is triggered from the Student Accounts page (account::admin),
// not a role held under the charges:: module tag.
const CHARGE_LATE_ROLES = ['account::admin'];
// Payments ("Fees Payments") and Other Payments ("Transacts") are two
// different frontend modules/roles that both write through this same
// backend surface (fetchPayment/postPayment/updatePayment/deletePayment,
// branching internally on transtypeId) — the route can't tell which module
// a request came from, so it must accept either role's admin/clerk tags.
const PAYMENT_VIEW_ROLES = ['payment::admin', 'payment::clerk', 'transaction::admin', 'transaction::clerk'];
const PAYMENT_WRITE_ROLES = ['payment::admin', 'transaction::admin'];
const ACCOUNT_VIEW_ROLES = ['account::admin', 'account::clerk'];
const DEBTOR_VIEW_ROLES = ['debtor::clerk'];
const SCOST_VIEW_ROLES = ['scost::admin', 'scost::clerk'];
const SCOST_ADMIN_ROLES = ['scost::admin'];
class FmsRoute {
    constructor() {
        this.router = (0, express_1.Router)();
        this.controller = new fmsController_1.default();
        this.initializeRoute();
    }
    initializeRoute() {
        this.router.use(verifyToken);
        this.router.get('/dash', requireRole(DASHBOARD_ROLES), this.controller.loadDashboard);
        this.router.post('/report', requireRole(['finreport::admin']), this.controller.loadReport);
        /* Bills */
        this.router.get('/bills', requireRole(BILL_VIEW_ROLES), this.controller.fetchBills);
        this.router.get('/bills/list', requireRole(BILL_VIEW_ROLES), this.controller.fetchBillList);
        this.router.get('/bills/:id', requireRole(BILL_VIEW_ROLES), this.controller.fetchBill);
        this.router.get('/bills/:id/activity', requireRole(BILL_VIEW_ROLES), this.controller.billActivity);
        this.router.get('/bills/:id/receipients', requireRole(BILL_VIEW_ROLES), this.controller.billReceivers);
        this.router.post('/bills/:id/include', requireRole(BILL_ADMIN_ROLES), this.controller.includeBill);
        this.router.post('/bills/:id/exclude', requireRole(BILL_ADMIN_ROLES), this.controller.excludeBill);
        this.router.get('/bills/:id/activate', requireRole(BILL_ADMIN_ROLES), this.controller.activateBill);
        this.router.get('/bills/:id/revoke', requireRole(BILL_ADMIN_ROLES), this.controller.revokeBill);
        this.router.post('/bills', requireRole(BILL_ADMIN_ROLES), this.controller.postBill);
        this.router.patch('/bills/:id', requireRole(BILL_ADMIN_ROLES), this.controller.updateBill);
        this.router.delete('/bills/:id', requireRole(BILL_ADMIN_ROLES), this.controller.deleteBill);
        /* Charges */
        this.router.get('/charges', requireRole(CHARGE_VIEW_ROLES), this.controller.fetchCharges);
        this.router.get('/charges/:id', requireRole(CHARGE_VIEW_ROLES), this.controller.fetchCharge);
        this.router.post('/charges/late', requireRole(CHARGE_LATE_ROLES), this.controller.lateCharge);
        this.router.post('/charges', requireRole(CHARGE_ADMIN_ROLES), this.controller.postCharge);
        this.router.patch('/charges/:id', requireRole(CHARGE_ADMIN_ROLES), this.controller.updateCharge);
        this.router.delete('/charges/:id', requireRole(CHARGE_ADMIN_ROLES), this.controller.deleteCharge);
        /* Payments */
        this.router.get('/payments', requireRole(PAYMENT_VIEW_ROLES), this.controller.fetchPayments);
        this.router.get('/payments/other', requireRole(PAYMENT_VIEW_ROLES), this.controller.fetchPaymentOthers);
        this.router.get('/payments/:id', requireRole(PAYMENT_VIEW_ROLES), this.controller.fetchPayment);
        this.router.post('/payments/convert', requireRole(PAYMENT_WRITE_ROLES), this.controller.convertPayment);
        this.router.post('/payments', requireRole(PAYMENT_WRITE_ROLES), this.controller.postPayment);
        this.router.patch('/payments/:id', requireRole(PAYMENT_WRITE_ROLES), this.controller.updatePayment);
        this.router.delete('/payments/:id', requireRole(PAYMENT_WRITE_ROLES), this.controller.deletePayment);
        /* Accounts & Debtors */
        this.router.get('/accounts', requireRole(ACCOUNT_VIEW_ROLES), this.controller.fetchAccounts);
        this.router.get('/accounts/debts', requireRole(DEBTOR_VIEW_ROLES), this.controller.fetchDebts);
        this.router.get('/accounts/retire/:tag', requireRole(['account::admin']), this.controller.retireAccount);
        this.router.get('/accounts/:id', requireRole(ACCOUNT_VIEW_ROLES), this.controller.fetchAccount);
        /* Services */
        this.router.get('/services', requireRole(SCOST_VIEW_ROLES), this.controller.fetchServices);
        // /services/list is a shared dropdown helper (status:true only), also
        // consumed by the Reports form to populate report types — not just the
        // Service Costs module itself.
        this.router.get('/services/list', requireRole([...SCOST_VIEW_ROLES, 'finreport::admin']), this.controller.fetchServiceList);
        this.router.get('/services/:id', requireRole(SCOST_VIEW_ROLES), this.controller.fetchService);
        this.router.post('/services', requireRole(SCOST_ADMIN_ROLES), this.controller.postService);
        this.router.patch('/services/:id', requireRole(SCOST_ADMIN_ROLES), this.controller.updateService);
        this.router.delete('/services/:id', requireRole(SCOST_ADMIN_ROLES), this.controller.deleteService);
        /* FMS Helpers */
        this.router.get('/bankaccs/list', requireRole(BILL_VIEW_ROLES), this.controller.fetchBanks);
    }
}
exports.default = new FmsRoute().router;
