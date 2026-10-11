"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fmsController_1 = __importDefault(require("../controller/fmsController"));
const helper_1 = require("../util/helper");
const requireBankCollector_1 = require("../middleware/requireBankCollector");
class ApiRoute {
    constructor() {
        this.router = (0, express_1.Router)();
        this.controller = new fmsController_1.default();
        this.initializeRoute();
    }
    initializeRoute() {
        /* Bank Payment API Services -- apiLogger runs first so rejected
           (bad/missing token) requests are logged too. */
        this.router.get('/services', (0, helper_1.apiLogger)('LOAD_API_SERVICES'), requireBankCollector_1.requireBankCollector, this.controller.loadPayServices);
        this.router.get('/services/:type', (0, helper_1.apiLogger)('LOAD_VOUCHER_FORMS'), requireBankCollector_1.requireBankCollector, this.controller.loadPayService);
        this.router.get('/services/:type/:refno', (0, helper_1.apiLogger)('VERIFY_STUDENT'), requireBankCollector_1.requireBankCollector, this.controller.loadPayService);
        this.router.post('/payservice', (0, helper_1.apiLogger)('SEND_TRANSACTION'), requireBankCollector_1.requireBankCollector, this.controller.payService);
    }
}
exports.default = new ApiRoute().router;
