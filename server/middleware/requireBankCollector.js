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
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireBankCollector = exports.bankApiKey = void 0;
const client_1 = require("../prisma/client");
// Bank API (route/apiRoute.ts) authentication: the caller must send the API
// key of an enabled collector (fms_collector.apiToken / apiEnabled) as
// ?api_key=<key> -- the format issued to the banks, e.g.
// https://portal.akatsico.edu.gh/api/v1/services?api_key=<key> -- or, also
// accepted, ?api=<key> or an `x-api-key` header. The matching collector is put on
// req.collector, and payments are credited to it (fmsController.payService).
// Issue / rotate a token with: npm run bank-token -- "<collector name>"
//
// BANK_API_ALLOW_UNAUTHENTICATED=true is a temporary rollout switch for
// while a bank's token is being set up: requests without a valid token are
// let through and fall back to the old behaviour (first collector). Every
// request is logged either way (apiLogger), showing whether the token matched.
const bankApiKey = (req) => { var _a, _b; return String(((_a = req.query) === null || _a === void 0 ? void 0 : _a.api_key) || ((_b = req.query) === null || _b === void 0 ? void 0 : _b.api) || req.headers["x-api-key"] || "").trim(); };
exports.bankApiKey = bankApiKey;
const requireBankCollector = (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const token = (0, exports.bankApiKey)(req);
        const collector = token ? yield client_1.prisma.collector.findFirst({ where: { apiToken: token, apiEnabled: true }, select: { id: true, name: true } }) : null;
        if (collector) {
            req.collector = collector;
            return next();
        }
        if (process.env.BANK_API_ALLOW_UNAUTHENTICATED === "true")
            return next();
        return res.status(401).json({ success: false, data: null, msg: "Invalid or missing API key" });
    }
    catch (error) {
        console.log("requireBankCollector failed:", error === null || error === void 0 ? void 0 : error.message);
        return res.status(500).json({ success: false, data: null, msg: "Could not verify API token" });
    }
});
exports.requireBankCollector = requireBankCollector;
