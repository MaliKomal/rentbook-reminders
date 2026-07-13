/**
 * RentBook — Automatic WhatsApp Reminder Sender
 * -----------------------------------------------
 * Runs once, checks every tenant's due date against today, and sends
 * a WhatsApp template message via Meta's official Cloud API to anyone
 * who is 3, 2, or 1 day from due — or overdue (repeats daily until paid).
 *
 * This is meant to be triggered on a schedule (see reminders-workflow.yml)
 * so it runs with NO ONE tapping anything — true automatic sending.
 *
 * SETUP REQUIRED BEFORE THIS WILL WORK:
 * 1. A Meta Business Account + WhatsApp Business Platform (Cloud API) set up.
 * 2. A permanent access token and your Phone Number ID from Meta.
 * 3. A message TEMPLATE approved by Meta (utility category) with one of
 *    these exact structures (edit createPayload() below to match yours):
 *      Template name: "rent_reminder_upcoming"
 *        Body: "Hi {{1}}, your rent of {{2}} for flat {{3}} is due {{4}}."
 *      Template name: "rent_reminder_overdue"
 *        Body: "Hi {{1}}, your rent of {{2}} for flat {{3}} is now {{4}} overdue."
 *    (You cannot send free-text business-initiated messages — only
 *    pre-approved templates. This is a WhatsApp platform rule, not ours.)
 * 4. tenants.json in this same folder with your tenant + payment data
 *    (exported/synced from the RentBook app — see notes at bottom).
 */

const fs = require('fs');
const path = require('path');

// ── Config: set these as environment variables (never hardcode secrets) ──
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;       // permanent access token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;     // from Meta dashboard
const API_VERSION = 'v20.0';

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.error('Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID environment variables.');
  process.exit(1);
}

// ── Load tenant + payment data ──
const dataPath = path.join(__dirname, 'tenants.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const tenants = data.tenants || [];
const payments = data.payments || {};

// ── Work out who needs a reminder today (same logic as the app) ──
const now = new Date();
const curYr = now.getFullYear(), curMo = now.getMonth() + 1;
const curMonthKey = `${curYr}-${String(curMo).padStart(2, '0')}`;
const todayMid = new Date(curYr, curMo - 1, now.getDate());

function computeReminders() {
  const out = [];
  tenants.forEach(t => {
    const key = `${t.id}_${curMonthKey}`;
    if (payments[key] === 'paid') return;
    const due = new Date(curYr, curMo - 1, t.dueDate || 1);
    const daysLeft = Math.round((due - todayMid) / 86400000);
    if ([3, 2, 1].includes(daysLeft)) out.push({ t, stage: 'upcoming', daysLeft, overdueBy: 0 });
    else if (daysLeft < 0) out.push({ t, stage: 'overdue', daysLeft, overdueBy: -daysLeft });
  });
  return out;
}

// ── Build the WhatsApp API payload for a template message ──
function createPayload(r) {
  const amt = `Rs ${(+r.t.rent).toLocaleString('en-IN')}`;
  if (r.stage === 'overdue') {
    return {
      messaging_product: 'whatsapp',
      to: r.t.phone.replace(/\D/g, ''),
      type: 'template',
      template: {
        name: 'rent_reminder_overdue',
        language: { code: 'en' },
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: r.t.name },
            { type: 'text', text: amt },
            { type: 'text', text: r.t.flat },
            { type: 'text', text: `${r.overdueBy} day${r.overdueBy > 1 ? 's' : ''}` }
          ]
        }]
      }
    };
  }
  const when = r.daysLeft === 1 ? 'tomorrow' : `in ${r.daysLeft} days`;
  return {
    messaging_product: 'whatsapp',
    to: r.t.phone.replace(/\D/g, ''),
    type: 'template',
    template: {
      name: 'rent_reminder_upcoming',
      language: { code: 'en' },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', text: r.t.name },
          { type: 'text', text: amt },
          { type: 'text', text: r.t.flat },
          { type: 'text', text: when }
        ]
      }]
    }
  };
}

async function sendMessage(payload) {
  const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

async function main() {
  const list = computeReminders();
  console.log(`Found ${list.length} tenant(s) needing a reminder today (${todayMid.toDateString()}).`);

  for (const r of list) {
    try {
      const payload = createPayload(r);
      const result = await sendMessage(payload);
      console.log(`✓ Sent to ${r.t.name} (${r.t.flat}) — ${r.stage}`, result.messages?.[0]?.id || '');
    } catch (err) {
      console.error(`✗ Failed for ${r.t.name} (${r.t.flat}):`, err.message);
    }
    // Small delay between sends to stay well within rate limits
    await new Promise(res => setTimeout(res, 300));
  }

  console.log('Done.');
}

main();
