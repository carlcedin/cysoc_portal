// Browser run-through of every tab as each account type. Needs a running server (demo mode) and Playwright.
// Usage: BASE=http://127.0.0.1:8090 DEMO_PASSWORD=... node test/e2e.mjs
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const PW = process.env.DEMO_PASSWORD;
const SHOTS = process.env.SHOTS || 'test-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32 = s => { let bits = 0, v = 0; const out = []; for (const c of s.replace(/\s/g, '')) { v = (v << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const totp = (secret, offset = 0) => { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset)); const h = crypto.createHmac('sha1', b32(secret)).update(c).digest(); const o = h[19] & 15; return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0'); };

const results = []; const errors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

async function signIn(page, email) {
  await page.goto(BASE);
  await page.fill('#email', email); await page.fill('#password', PW); await page.click('#signin');
  await page.waitForSelector('#mfa-secret, #code');
  const secret = await page.$('#mfa-secret') ? (await page.textContent('#mfa-secret')) : null;
  if (secret) check(`${email}: QR code shown for enrolment`, !!(await page.$('.qr svg')));
  await page.fill('#code', totp(secret)); await page.click('#verify');
  await page.waitForSelector('#tabs', { timeout: 10000 });
  return secret;
}

async function tour(page, who, tabs) {
  for (const t of tabs) {
    await page.click(`#tab-${t}`);
    await page.waitForTimeout(400);
    await page.waitForFunction(() => !document.querySelector('.view .loading'), null, { timeout: 10000 }).catch(() => {});
    const err = await page.$('.view .err-box');
    check(`${who}: ${t} tab loads`, !err, err ? await err.textContent() : '');
    await page.screenshot({ path: `${SHOTS}/${who}-${t}.png`, fullPage: true });
  }
}

const browser = await chromium.launch();
const ctx = (vp = { width: 1280, height: 900 }) => browser.newContext({ viewport: vp });

// ---------- Customer ----------
{
  const c = await ctx(); const p = await c.newPage();
  p.on('pageerror', e => errors.push('customer: ' + e.message)); p.on('console', m => m.type() === 'error' && errors.push('customer console: ' + m.text()));
  await signIn(p, 'aisyah@seri.example');
  const tabs = await p.$$eval('#tabs .tab', x => x.map(y => y.id.replace('tab-', '')));
  check('customer sees no staff tabs', !tabs.includes('health') && !tabs.includes('admin'), tabs.join(','));
  check('customer has no tenant selector', !(await p.$('#scopeSel')));
  check('customer badge', (await p.textContent('#roleBadge')) === 'Customer');
  await tour(p, 'customer', tabs);
  // Acknowledge an escalation and post a message
  await p.click('#tab-escalations'); await p.waitForSelector('#escRows, .tbl');
  await p.click('#chip-escalated');
  const row = await p.$('tr[data-ref]');
  if (row) {
    await row.click(); await p.waitForSelector('#b-ack');
    await p.fill('#cmt', 'Investigating now.'); await p.click('#b-post'); await p.waitForTimeout(600);
    await p.click('#b-ack'); await p.waitForTimeout(800);
    check('customer acknowledged from the portal', /Acknowledged/.test(await p.textContent('.view')));
    await p.screenshot({ path: `${SHOTS}/customer-escalation-detail.png`, fullPage: true });
  } else check('customer has an escalation to acknowledge', false);
  // Raise a request
  await p.click('#tab-requests'); await p.fill('#rqText', 'Allow vendor IP 203.0.113.45 on perimeter firewall'); await p.click('#rqBtn'); await p.waitForTimeout(700);
  check('customer raised a request', /submitted/.test(await p.textContent('.view')));
  // Add a contact and confirm the list
  await p.click('#tab-service'); await p.waitForSelector('#ctName');
  await p.fill('#ctName', 'Lee Wei'); await p.fill('#ctEmail', 'lee@seri.example'); await p.fill('#ctPhone', '+60 12-000 9999'); await p.click('#ctAdd'); await p.waitForTimeout(700);
  check('customer added a contact', (await p.textContent('.view')).includes('Lee Wei'));
  // Download a report
  await p.click('#tab-reports'); await p.waitForSelector('.fname');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Download") >> nth=0')]);
  check('customer downloaded a PDF report', (await dl.suggestedFilename()).endsWith('.pdf'));
  // Mobile layout
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await c.storageState() });
  const mp = await m.newPage(); await mp.goto(BASE + '/#dashboard'); await mp.waitForSelector('#tabs'); await mp.waitForTimeout(800);
  const sw = await mp.evaluate(() => document.documentElement.scrollWidth);
  check('no horizontal scroll at phone width', sw <= 390, `scrollWidth ${sw}`);
  await mp.screenshot({ path: `${SHOTS}/customer-mobile-dashboard.png`, fullPage: false });
  await m.close();
  await p.click('#signout'); await p.waitForSelector('#email');
  check('sign out returns to the sign-in page', true);
  await c.close();
}

// ---------- Analyst ----------
{
  const c = await ctx(); const p = await c.newPage();
  p.on('pageerror', e => errors.push('analyst: ' + e.message)); p.on('console', m => m.type() === 'error' && errors.push('analyst console: ' + m.text()));
  await signIn(p, 'analyst@cysoc.example');
  const tabs = await p.$$eval('#tabs .tab', x => x.map(y => y.id.replace('tab-', '')));
  check('analyst sees health and administration', tabs.includes('health') && tabs.includes('admin'));
  check('staff land on the Customers page', !!(await p.$('#catSel')));
  await p.screenshot({ path: `${SHOTS}/analyst-landing.png`, fullPage: true });
  await tour(p, 'analyst', tabs);
  await p.click('#tab-admin'); await p.waitForTimeout(500);
  const txt = await p.textContent('.view');
  check('analyst administration is view only', txt.includes('View only') && !(await p.$('#apiSave')) && !txt.includes('Create an account'));
  check('analyst cannot upload reports', await (async () => { await p.click('#tab-reports'); await p.waitForTimeout(400); return !(await p.$('#upBtn')); })());
  // Escalate a triage item
  await p.click('#tab-escalations'); await p.click('#chip-triage'); await p.waitForTimeout(300);
  const row = await p.$('tr[data-ref]');
  if (row) { await row.click(); await p.waitForSelector('#b-esc'); await p.click('#b-esc'); await p.waitForTimeout(800); check('analyst escalated a triage item', /Escalated/.test(await p.textContent('.view'))); }
  // Category -> customer -> workspace
  await p.click('#tab-customers'); await p.waitForSelector('#catSel');
  await p.selectOption('#catSel', 'DDoS'); await p.waitForTimeout(500);
  const ddos = await p.$$eval('tr[data-cust]', r => r.map(x => x.getAttribute('data-cust')).sort());
  check('DDoS category lists its customers only', JSON.stringify(ddos) === JSON.stringify(['bayu', 'cahaya', 'permata']), ddos.join(','));
  await p.click('tr[data-cust="bayu"]'); await p.waitForSelector('#backToCustomers');
  check('clicking a customer opens its workspace', (await p.textContent('#scopeTitle')) === 'Bayu Logistics');
  const wsTabs = await p.$$eval('#tabs .tab', x => x.map(y => y.id.replace('tab-', '')));
  check('workspace has customer tabs only', !wsTabs.includes('customers') && !wsTabs.includes('admin') && wsTabs.includes('dashboard'), wsTabs.join(','));
  for (const t of wsTabs) {
    await p.click('#tab-' + t); await p.waitForTimeout(400);
    await p.waitForFunction(() => !document.querySelector('.view .loading'), null, { timeout: 10000 }).catch(() => {});
    const err = await p.$('.view .err-box');
    check(`workspace ${t} loads`, !err, err ? await err.textContent() : '');
    await p.screenshot({ path: `${SHOTS}/workspace-${t}.png`, fullPage: true });
  }
  const regs = await p.$$eval('tr[data-ref]', r => r.length);
  await p.click('#tab-escalations'); await p.waitForTimeout(400);
  await p.selectOption('#custSwitch', { label: 'Cahaya University' }); await p.waitForTimeout(500);
  check('switch customer within the category', (await p.textContent('#scopeTitle')) === 'Cahaya University');
  await p.click('#backToCustomers'); await p.waitForSelector('#catSel');
  check('back returns to the DDoS list', (await p.$eval('#catSel', s => s.value)) === 'DDoS');
  await c.close();
}

// ---------- Full Admin ----------
{
  const c = await ctx(); const p = await c.newPage();
  p.on('pageerror', e => errors.push('admin: ' + e.message)); p.on('console', m => m.type() === 'error' && errors.push('admin console: ' + m.text()));
  await signIn(p, 'admin@cysoc.example');
  const tabs = await p.$$eval('#tabs .tab', x => x.map(y => y.id.replace('tab-', '')));
  await tour(p, 'admin', tabs);
  await p.click('#tab-admin'); await p.waitForTimeout(500);
  await p.fill('#nuName', 'Ops Analyst'); await p.fill('#nuEmail', `ops${Date.now()}@cysoc.example`); await p.click('#nuCreate'); await p.waitForTimeout(800);
  const pw = await p.textContent('#temp-pw').catch(() => '');
  check('admin created an account and saw a temporary password once', !!pw && pw.length >= 16);
  await p.click('button:has-text("Edit") >> nth=0'); await p.waitForSelector('#apiUrl');
  await p.fill('#apiUrl', 'https://nts.cysoc.example'); await p.fill('#apiSecret', 'secret-key-1234'); await p.click('#apiSave'); await p.waitForTimeout(800);
  check('admin saved an API connection', /Saved NTS/.test(await p.textContent('.view')));
  await p.screenshot({ path: `${SHOTS}/admin-admin-after.png`, fullPage: true });
  await p.click('#tab-reports'); await p.waitForSelector('#upFile');
  await p.selectOption('#upTenant', { label: 'Seri Kenanga Healthcare' }); await p.fill('#upPeriod', 'Oct 2026');
  fs.writeFileSync('/tmp/e2e-report.pdf', '%PDF-1.4\n%%EOF\n');
  await p.setInputFiles('#upFile', '/tmp/e2e-report.pdf'); await p.click('#upBtn'); await p.waitForTimeout(1000);
  check('admin uploaded a report', /Uploaded to Seri/.test(await p.textContent('.view')));
  // Bulk import pasted from Excel
  await p.click('#tab-admin'); await p.waitForSelector('#tnImport'); await p.click('#tnImport');
  await p.check('#imp-DDoS');
  await p.fill('#impText', 'No.\tCustomer Name\tContract End\n1\tKedai Runcit Ali Sdn Bhd\t31/12/2027\n2\tHotel Seri Pagi\t\n3\tSeri Kenanga Healthcare\t\n');
  await p.click('#impCheck'); await p.waitForSelector('#impGo');
  await (await p.$('.importbox')).screenshot({ path: `${SHOTS}/admin-import-preview.png` });
  check('import preview shows 2 new and 1 update', /2 new/.test(await p.textContent('.importbox')) && /1 add category/.test(await p.textContent('.importbox')));
  await p.click('#impGo'); await p.waitForTimeout(800);
  check('import saved', /Imported: 2 new customers, 1 updated/.test(await p.textContent('.importbox')));
  await p.click('#tab-customers'); await p.selectOption('#catSel', 'DDoS'); await p.waitForTimeout(600);
  check('imported customers appear under DDoS', !!(await p.$('tr[data-cust="kedai-runcit-ali-sdn-bhd"]')) && !!(await p.$('tr[data-cust="seri"]')));
  await p.click('tr[data-cust="hotel-seri-pagi"]'); await p.waitForSelector('#backToCustomers');
  await p.click('#tab-dashboard'); await p.waitForTimeout(500);
  check('no-SIEM customer shows a clear dashboard message', /no SIEM monitoring/.test(await p.textContent('.view')));
  await c.close();
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; ${errors.length} browser errors`);
errors.slice(0, 10).forEach(e => console.log('  ' + e));
process.exit(failed.length || errors.length ? 1 : 0);
