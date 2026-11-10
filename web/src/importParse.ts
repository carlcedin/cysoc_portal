// Turns text pasted from Excel (tab-separated) or a CSV file into customer rows.
export interface ImportRow { name: string; code?: string; categories?: string; service?: string; siem?: string; renewalDate?: string }

function splitCsv(text: string, delim: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x !== ''));
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** Accepts 2026-12-31, 31/12/2026, 31-12-2026, 31-Dec-2026 or 31 Dec 2026 (day first, as in Malaysia). */
const valid = (y: string, m: string | number, d: string) => {
  const iso = `${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`;
  const dt = new Date(iso + 'T00:00:00Z');
  return !isNaN(+dt) && dt.toISOString().slice(0, 10) === iso ? iso : undefined;
};
export function toIsoDate(s: string): string | undefined {
  const t = s.trim(); if (!t) return undefined;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return valid(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return valid(m[3], m[2], m[1]);
  m = t.match(/^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return valid(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  return undefined;
}

const COLS: [keyof ImportRow, RegExp][] = [
  ['code', /^(tenant |customer |nts )?code$/i],
  ['categories', /categor|service line|product/i],
  ['siem', /siem/i],
  ['renewalDate', /renew|expir|end date|contract end/i],
  ['service', /^service( name)?$/i],
  ['name', /customer|name|company|account|organi[sz]ation/i],
];

export function parseImport(text: string): { rows: ImportRow[]; columns: string[]; warning?: string } {
  const delim = text.includes('\t') ? '\t' : text.split('\n')[0].includes(';') && !text.split('\n')[0].includes(',') ? ';' : ',';
  const grid = splitCsv(text.replace(/^﻿/, ''), delim);
  if (!grid.length) return { rows: [], columns: [] };
  const header = grid[0];
  const map: Partial<Record<keyof ImportRow, number>> = {};
  header.forEach((h, i) => { const hit = COLS.find(([k, re]) => map[k] === undefined && re.test(h)); if (hit) map[hit[0]] = i; });
  const hasHeader = map.name !== undefined;
  if (!hasHeader) map.name = 0; // no header row: first column is the customer name
  const body = hasHeader ? grid.slice(1) : grid;
  const pick = (r: string[], k: keyof ImportRow) => (map[k] !== undefined ? r[map[k]!] ?? '' : '');
  const rows = body.map(r => ({
    name: pick(r, 'name'), code: pick(r, 'code') || undefined, categories: pick(r, 'categories') || undefined,
    service: pick(r, 'service') || undefined, siem: pick(r, 'siem') || undefined,
    renewalDate: map.renewalDate !== undefined ? toIsoDate(pick(r, 'renewalDate')) : undefined,
  }));
  const columns = hasHeader ? (Object.keys(map) as (keyof ImportRow)[]).map(k => `${k} ← "${header[map[k]!]}"`) : ['name ← first column (no header row found)'];
  return { rows, columns, warning: hasHeader ? undefined : 'No header row found, so every line is read as a customer name from the first column.' };
}

export const TEMPLATE_CSV = 'Customer name,Code,Categories,SIEM,Renewal date\r\nContoh Sdn Bhd,,DDoS,None,31/12/2027\r\nSampel Berhad,sampel,DDoS;VA,None,\r\n';
