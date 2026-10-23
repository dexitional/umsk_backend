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
const smsAxios = require('axios');
class SmsError extends Error {
    constructor(message, code, status = 502) { super(message); this.name = 'SmsError'; this.code = code; this.status = status; }
}
function normalizePhone(value) {
    if (typeof value !== 'string' && typeof value !== 'number')
        throw new SmsError('No valid recipient phone number was provided.', 'INVALID_PHONE', 400);
    // Legacy records may contain alternatives. Use the first recorded number.
    let phone = String(value).trim().split(/[/,;]/)[0].replace(/[\s()._-]/g, '');
    if (!/^\+?\d+$/.test(phone))
        throw new SmsError('The recipient phone number is invalid.', 'INVALID_PHONE', 400);
    phone = phone.replace(/^\+/, '').replace(/^00/, '');
    if (/^2330?[235]\d{8}$/.test(phone))
        phone = '0' + phone.slice(3).replace(/^0/, '');
    if (/^[235]\d{8}$/.test(phone))
        phone = '0' + phone;
    if (/^0[235]\d{8}$/.test(phone))
        return phone;
    if (/^[1-9]\d{9,14}$/.test(phone) && !phone.startsWith('233'))
        return phone;
    throw new SmsError('The recipient phone number is invalid.', 'INVALID_PHONE', 400);
}
function providerError(data, http) {
    const message = typeof (data === null || data === void 0 ? void 0 : data.message) === 'string' ? data.message : '';
    const providerCode = /^[\w-]{1,30}$/.test(String((data === null || data === void 0 ? void 0 : data.code) || '')) ? String(data.code) : 'REJECTED';
    // Never propagate Axios configuration, API keys, passwords or message content.
    const detail = /balance|credit|fund/i.test(message) ? 'The SMS account has insufficient credit.'
        : /sender/i.test(message) ? 'The SMS sender ID was rejected. Check its approval in mNotify.'
            : http === 401 || http === 403 || /api.?key|authenticat|unauthoriz/i.test(message) ? 'SMS authentication failed. Check the configured mNotify API key.'
                : http === 429 ? 'The SMS provider rate limit was reached. Try again later.'
                    : 'The SMS provider did not accept this message. Check the recipient and provider reports.';
    return new SmsError(detail, 'MNOTIFY_' + providerCode);
}
function sendSms(phone, msg, from) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c;
        const recipient = normalizePhone(phone);
        const key = (_a = process.env.UMS_SMS_KEY) === null || _a === void 0 ? void 0 : _a.trim();
        const sender = (from || process.env.UMS_SENDERID || '').trim();
        if (!key)
            throw new SmsError('SMS is not configured: the mNotify API key is missing.', 'SMS_NOT_CONFIGURED', 503);
        if (!sender || sender.length > 11)
            throw new SmsError('SMS requires an approved sender ID of at most 11 characters.', 'INVALID_SENDER', 503);
        if (typeof msg !== 'string' || !msg.trim())
            throw new SmsError('SMS content is required.', 'EMPTY_MESSAGE', 400);
        let data;
        try {
            const response = yield smsAxios.post('https://api.mnotify.com/api/sms/quick', {
                recipient: [recipient], sender, message: msg, is_schedule: false, schedule_date: '',
            }, { params: { key }, headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 0 });
            data = response.data;
        }
        catch (error) {
            if (error === null || error === void 0 ? void 0 : error.response)
                throw providerError(error.response.data, error.response.status);
            // Do not retry automatically: a timeout can occur after provider acceptance.
            throw new SmsError('SMS submission could not be confirmed. Check mNotify delivery reports before retrying.', 'SMS_UNCONFIRMED');
        }
        if ((data === null || data === void 0 ? void 0 : data.status) !== 'success' || String(data === null || data === void 0 ? void 0 : data.code) !== '2000' || !(Number((_b = data === null || data === void 0 ? void 0 : data.summary) === null || _b === void 0 ? void 0 : _b.total_sent) > 0) || Number((_c = data === null || data === void 0 ? void 0 : data.summary) === null || _c === void 0 ? void 0 : _c.total_rejected) > 0)
            throw providerError(data);
        return { status: 'success', code: '2000', accepted: true, campaignId: data.summary._id || null, message: 'SMS accepted by the provider.' };
    });
}
function safe(phone, msg, from) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            return yield sendSms(phone, msg, from);
        }
        catch (error) {
            const failure = { status: 'error', accepted: false, code: error.code || 'SMS_FAILED', message: error.message || 'SMS could not be sent.' };
            console.warn('SMS submission failed:', failure.code, failure.message);
            return failure;
        }
    });
}
function map(items, work) {
    return __awaiter(this, void 0, void 0, function* () {
        const results = [];
        let cursor = 0;
        yield Promise.all(Array.from({ length: Math.min(5, items.length) }, () => __awaiter(this, void 0, void 0, function* () {
            while (cursor < items.length) {
                const index = cursor++;
                results[index] = yield work(items[index]);
            }
        })));
        return results;
    });
}
function sendMany(phones, message) {
    return __awaiter(this, void 0, void 0, function* () {
        const recipients = [], seen = new Set();
        let invalid = 0, duplicates = 0;
        for (const value of phones) {
            try {
                const phone = normalizePhone(value);
                if (seen.has(phone)) {
                    duplicates++;
                    continue;
                }
                seen.add(phone);
                recipients.push(phone);
            }
            catch (_a) {
                invalid++;
            }
        }
        // Bound concurrency instead of creating hundreds of simultaneous requests.
        const results = yield map(recipients, phone => safe(phone, message));
        const sent = results.filter(r => r.accepted).length;
        const errors = [...new Set(results.filter(r => !r.accepted).map(r => r.message))];
        if (invalid)
            errors.push('Some records have missing or invalid phone numbers.');
        return { count: phones.length, attempted: recipients.length, sent, accepted: sent, failed: results.length - sent, invalid, duplicates, errors };
    });
}
module.exports = Object.assign(sendSms, { safe, sendMany, map, normalizePhone, SmsError });
