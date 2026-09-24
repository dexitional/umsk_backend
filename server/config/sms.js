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
// SMS -- mNotify's "BMS" Quick SMS API (api.mnotify.com). Their previous
// GET-based apps.mnotify.net/smsapi endpoint is deprecated and rejects any
// key issued on the new platform with a generic "Invalid API key", which is
// what led here -- confirmed live: the same key that endpoint rejected
// authenticates fine against this one.
//
// Unlike the old endpoint (always HTTP 200, errors embedded in the body),
// this one returns real HTTP error statuses on failure -- but every caller
// in this codebase was written against the old "never rejects" contract
// (many wrap this in their own best-effort try/catch, and at least one
// call site has none at all). Catch here and keep returning an
// error-shaped object instead of throwing, so that contract still holds.
var axios = require('axios');
module.exports = function (phone, msg, from) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const key = process.env.UMS_SMS_KEY;
        const sender = from || process.env.UMS_SENDERID;
        const url = `https://api.mnotify.com/api/sms/quick?key=${key}`;
        const payload = {
            recipient: [phone],
            sender,
            message: msg,
            is_schedule: false,
            schedule_date: '',
        };
        try {
            const res = yield axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });
            return res.data;
        }
        catch (error) {
            return ((_a = error === null || error === void 0 ? void 0 : error.response) === null || _a === void 0 ? void 0 : _a.data) || { status: 'error', message: error === null || error === void 0 ? void 0 : error.message };
        }
    });
};
