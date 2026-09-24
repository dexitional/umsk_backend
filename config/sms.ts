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

module.exports = async function(phone: string, msg: string, from?: string) {
    const key = process.env.UMS_SMS_KEY;
    const sender = from || process.env.UMS_SENDERID;
    const url = `https://api.mnotify.com/api/sms/quick?key=${key}`;
    const payload = {
        recipient: [phone],
        sender,
        message: msg,
        is_schedule: false,
        schedule_date: '',
    }

    try {
        const res = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } })
        return res.data
    } catch (error: any) {
        return error?.response?.data || { status: 'error', message: error?.message }
    }
};