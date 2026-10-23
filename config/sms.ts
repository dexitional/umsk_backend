// mNotify BMS v2: https://readthedocs.mnotify.com/
// Acceptance by the gateway is distinct from handset delivery.
export {};
const smsAxios = require('axios');
class SmsError extends Error {
    code: string;
    status: number;
    constructor(message: string, code: string, status = 502) { super(message); this.name = 'SmsError'; this.code = code; this.status = status; }
}
function normalizePhone(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') throw new SmsError('No valid recipient phone number was provided.', 'INVALID_PHONE', 400);
    // Legacy records may contain alternatives. Use the first recorded number.
    let phone = String(value).trim().split(/[/,;]/)[0].replace(/[\s()._-]/g, '');
    if (!/^\+?\d+$/.test(phone)) throw new SmsError('The recipient phone number is invalid.', 'INVALID_PHONE', 400);
    phone = phone.replace(/^\+/, '').replace(/^00/, '');
    if (/^2330?[235]\d{8}$/.test(phone)) phone = '0' + phone.slice(3).replace(/^0/, '');
    if (/^[235]\d{8}$/.test(phone)) phone = '0' + phone;
    if (/^0[235]\d{8}$/.test(phone)) return phone;
    if (/^[1-9]\d{9,14}$/.test(phone) && !phone.startsWith('233')) return phone;
    throw new SmsError('The recipient phone number is invalid.', 'INVALID_PHONE', 400);
}
function providerError(data: any, http?: number) {
    const message = typeof data?.message === 'string' ? data.message : '';
    const providerCode = /^[\w-]{1,30}$/.test(String(data?.code || '')) ? String(data.code) : 'REJECTED';
    // Never propagate Axios configuration, API keys, passwords or message content.
    const detail = /balance|credit|fund/i.test(message) ? 'The SMS account has insufficient credit.'
        : /sender/i.test(message) ? 'The SMS sender ID was rejected. Check its approval in mNotify.'
        : http === 401 || http === 403 || /api.?key|authenticat|unauthoriz/i.test(message) ? 'SMS authentication failed. Check the configured mNotify API key.'
        : http === 429 ? 'The SMS provider rate limit was reached. Try again later.'
        : 'The SMS provider did not accept this message. Check the recipient and provider reports.';
    return new SmsError(detail, 'MNOTIFY_' + providerCode);
}
async function sendSms(phone: unknown, msg: unknown, from?: string) {
    const recipient = normalizePhone(phone);
    const key = process.env.UMS_SMS_KEY?.trim();
    const sender = (from || process.env.UMS_SENDERID || '').trim();
    if (!key) throw new SmsError('SMS is not configured: the mNotify API key is missing.', 'SMS_NOT_CONFIGURED', 503);
    if (!sender || sender.length > 11) throw new SmsError('SMS requires an approved sender ID of at most 11 characters.', 'INVALID_SENDER', 503);
    if (typeof msg !== 'string' || !msg.trim()) throw new SmsError('SMS content is required.', 'EMPTY_MESSAGE', 400);
    let data: any;
    try {
        const response = await smsAxios.post('https://api.mnotify.com/api/sms/quick', {
            recipient: [recipient], sender, message: msg, is_schedule: false, schedule_date: '',
        }, { params: { key }, headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 0 });
        data = response.data;
    } catch (error: any) {
        if (error?.response) throw providerError(error.response.data, error.response.status);
        // Do not retry automatically: a timeout can occur after provider acceptance.
        throw new SmsError('SMS submission could not be confirmed. Check mNotify delivery reports before retrying.', 'SMS_UNCONFIRMED');
    }
    if (data?.status !== 'success' || String(data?.code) !== '2000' || !(Number(data?.summary?.total_sent) > 0) || Number(data?.summary?.total_rejected) > 0) throw providerError(data);
    return { status: 'success', code: '2000', accepted: true, campaignId: data.summary._id || null, message: 'SMS accepted by the provider.' };
}
async function safe(phone: unknown, msg: unknown, from?: string) {
    try { return await sendSms(phone, msg, from); }
    catch (error: any) {
        const failure = { status: 'error', accepted: false, code: error.code || 'SMS_FAILED', message: error.message || 'SMS could not be sent.' };
        console.warn('SMS submission failed:', failure.code, failure.message);
        return failure;
    }
}
async function map<T>(items: T[], work: (item: T) => Promise<any>) {
    const results: any[] = []; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(5, items.length) }, async () => {
        while (cursor < items.length) { const index = cursor++; results[index] = await work(items[index]); }
    }));
    return results;
}
async function sendMany(phones: unknown[], message: string) {
    const recipients: string[] = [], seen = new Set<string>();
    let invalid = 0, duplicates = 0;
    for (const value of phones) {
        try { const phone = normalizePhone(value); if (seen.has(phone)) { duplicates++; continue; } seen.add(phone); recipients.push(phone); }
        catch { invalid++; }
    }
    // Bound concurrency instead of creating hundreds of simultaneous requests.
    const results = await map(recipients, phone => safe(phone, message));
    const sent = results.filter(r => r.accepted).length;
    const errors = [...new Set(results.filter(r => !r.accepted).map(r => r.message))];
    if (invalid) errors.push('Some records have missing or invalid phone numbers.');
    return { count: phones.length, attempted: recipients.length, sent, accepted: sent, failed: results.length - sent, invalid, duplicates, errors };
}
module.exports = Object.assign(sendSms, { safe, sendMany, map, normalizePhone, SmsError });
