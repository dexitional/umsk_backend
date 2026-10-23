// Read-only diagnostics: checks credit and sender approval without sending SMS.
// Run from the backend directory: node scripts/check-sms.cjs
require('dotenv').config({ quiet: true });
const axios = require('axios');
(async () => {
  const key = process.env.UMS_SMS_KEY?.trim(), sender = process.env.UMS_SENDERID?.trim();
  if (!key || !sender || sender.length > 11) throw new Error('Set UMS_SMS_KEY and an approved UMS_SENDERID of at most 11 characters.');
  const checks = [['balance', 'balance/sms'], ['sender', 'senderid/status', { sender_name: sender }]];
  for (const [name, endpoint, data] of checks) {
    try {
      const res = await axios.request({ method: data ? 'post' : 'get', url: 'https://api.mnotify.com/api/' + endpoint, params: { key }, data, timeout: 15000, maxRedirects: 0 });
      const body = res.data;
      console.log(JSON.stringify({ check: name, http: res.status, status: body?.status, ...(name === 'balance' ? { balance: body?.balance, bonus: body?.bonus } : { senderStatus: body?.summary?.status }) }));
      if (body?.status !== 'success' || (name === 'sender' && String(body?.summary?.status).toLowerCase() !== 'approved')) process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ check: name, http: error.response?.status, message: 'Provider check failed. Verify the configured API key and network connection.' }));
      process.exitCode = 1;
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
