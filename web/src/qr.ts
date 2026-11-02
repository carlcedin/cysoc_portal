// Minimal QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1–10.
// Used only to show the authenticator enrolment link as a scannable code.

const EC_M: Record<number, [number, [number, number][]]> = { // version: [ec codewords per block, [[blocks, data codewords per block]]]
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
  6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// GF(256) arithmetic with the QR primitive polynomial 0x11D
const EXP = new Array<number>(512), LOG = new Array<number>(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); });
    g = next;
  }
  return g;
}
function rsRemainder(data: number[], n: number): number[] {
  const gen = rsGenerator(n);
  const res = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], coef);
  }
  return res.slice(data.length);
}

function bch(value: number, poly: number, polyDeg: number, dataBits: number): number {
  let v = value << polyDeg;
  for (let i = dataBits + polyDeg - 1; i >= polyDeg; i--) if ((v >> i) & 1) v ^= poly << (i - polyDeg);
  return (value << polyDeg) | v;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const cap = EC_M[v][1].reduce((a, [b, d]) => a + b * d, 0);
    const bits = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= cap * 8) { version = v; break; }
  }
  if (!version) throw new Error('Text too long for QR');
  const [ecPer, groups] = EC_M[version];
  const dataCap = groups.reduce((a, [b, d]) => a + b * d, 0);

  // Bit stream
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4); push(bytes.length, version < 10 ? 8 : 16); bytes.forEach(b => push(b, 8));
  push(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);

  // Blocks, error correction, interleaving
  const blocks: number[][] = []; let off = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++) { blocks.push(data.slice(off, off + size)); off += size; }
  const ecBlocks = blocks.map(b => rsRemainder(b, ecPer));
  const codewords: number[] = [];
  const maxLen = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < maxLen; i++) blocks.forEach(b => { if (i < b.length) codewords.push(b[i]); });
  for (let i = 0; i < ecPer; i++) ecBlocks.forEach(b => codewords.push(b[i]));

  // Function patterns
  const size = 17 + 4 * version;
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r: number, c: number, v: boolean) => { m[r][c] = v; fn[r][c] = true; };
  const finder = (r: number, c: number) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
      const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      set(rr, cc, inRing || inCore);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[version];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }
  set(size - 8, 8, true); // dark module
  // Reserve format information areas
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  if (version >= 7) {
    const vbits = bch(version, 0x1f25, 12, 6);
    for (let i = 0; i < 18; i++) {
      const bit = ((vbits >> i) & 1) === 1;
      const a = Math.floor(i / 3), b = size - 11 + (i % 3);
      set(a, b, bit); set(b, a, bit);
    }
  }

  // Data placement (zig-zag)
  const dataBits: number[] = [];
  codewords.forEach(cw => { for (let i = 7; i >= 0; i--) dataBits.push((cw >> i) & 1); });
  let k = 0, upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let n = 0; n < size; n++) {
      const row = upward ? size - 1 - n : n;
      for (const c of [col, col - 1]) {
        if (fn[row][c]) continue;
        m[row][c] = k < dataBits.length ? dataBits[k] === 1 : false; k++;
      }
    }
    upward = !upward;
  }

  // Masking: try all eight and keep the lowest penalty
  const masks: ((r: number, c: number) => boolean)[] = [
    (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];
  const withFormat = (grid: boolean[][], mask: number) => {
    const f = bch((0b00 << 3) | mask, 0x537, 10, 5) ^ 0x5412; // level M = 00
    const bit = (i: number) => ((f >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) grid[i][8] = bit(i);
    grid[7][8] = bit(6); grid[8][8] = bit(7); grid[8][7] = bit(8);
    for (let i = 9; i < 15; i++) grid[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) grid[size - 15 + i][8] = bit(i);
    grid[size - 8][8] = true;
    return grid;
  };
  const penalty = (g: boolean[][]) => {
    let p = 0;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = pass ? g[j][i] : g[i][j], b = pass ? g[j - 1][i] : g[i][j - 1];
        if (a === b) { run++; if (j === size - 1 && run >= 5) p += run - 2; } else { if (run >= 5) p += run - 2; run = 1; }
      }
    }
    for (let i = 0; i < size - 1; i++) for (let j = 0; j < size - 1; j++) { const v = g[i][j]; if (v === g[i + 1][j] && v === g[i][j + 1] && v === g[i + 1][j + 1]) p += 3; }
    const pat = [true, false, true, true, true, false, true, false, false, false, false], rev = [...pat].reverse();
    for (let i = 0; i < size; i++) for (let j = 0; j + 11 <= size; j++) for (const pt of [pat, rev]) {
      if (pt.every((v, x) => g[i][j + x] === v)) p += 40;
      if (pt.every((v, x) => g[j + x][i] === v)) p += 40;
    }
    const dark = g.flat().filter(Boolean).length;
    p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };
  let best: boolean[][] | null = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = m.map((row, r) => row.map((v, c) => (fn[r][c] ? !!v : (!!v) !== masks[mask](r, c))));
    withFormat(g, mask);
    const p = penalty(g);
    if (p < bestP) { bestP = p; best = g; }
  }
  return best!;
}

export function qrSvg(text: string, scale = 5, margin = 4): string {
  const g = qrMatrix(text); const n = g.length; const s = (n + margin * 2) * scale;
  let d = '';
  g.forEach((row, r) => row.forEach((v, c) => { if (v) d += `M${(c + margin) * scale},${(r + margin) * scale}h${scale}v${scale}h-${scale}z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="${s}" height="${s}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
