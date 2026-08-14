// Minimal QR encoder: byte mode, ECC level M, versions 1-10. That range covers
// otpauth:// URIs (~150 chars) with room to spare.
//
// This exists because the MFA enrollment page has to render a scannable code
// with no external script, and shipping a full QR library for one string is
// more dependency than the job needs. The Reed-Solomon and format-info paths
// are pinned by test vectors in test/qr.test.js.

// --- Version tables (ECC level M only) -------------------------------------
// [totalCodewords, ecCodewordsPerBlock, group1Blocks, group1DataCw, group2Blocks, group2DataCw]
const VERSIONS_M = {
  1: [26, 10, 1, 16, 0, 0],
  2: [44, 16, 1, 28, 0, 0],
  3: [70, 26, 1, 44, 0, 0],
  4: [100, 18, 2, 32, 0, 0],
  5: [134, 24, 2, 43, 0, 0],
  6: [172, 16, 4, 27, 0, 0],
  7: [196, 18, 4, 31, 0, 0],
  8: [242, 22, 2, 38, 2, 39],
  9: [292, 22, 3, 36, 2, 37],
  10: [346, 26, 4, 43, 1, 44],
};

const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const ECC_M_INDICATOR = 0b00; // format-info bits for level M

// --- GF(256) arithmetic, primitive polynomial 0x11D ------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division remainder - the EC codewords for one block. */
export function rsEncode(data, ecLength) {
  const gen = rsGenerator(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    for (let i = 0; i < ecLength; i++) {
      remainder[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return remainder;
}

// --- BCH codes for format and version information --------------------------
export function formatBits(eccIndicator, mask) {
  const data = (eccIndicator << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

const bitAt = (value, i) => (value >>> i) & 1;

// --- Data encoding ---------------------------------------------------------
function chooseVersion(byteLength) {
  for (let v = 1; v <= 10; v++) {
    const [total, ec, g1b, g1d, g2b, g2d] = VERSIONS_M[v];
    const dataCodewords = g1b * g1d + g2b * g2d;
    const countBits = v <= 9 ? 8 : 16;
    const needed = 4 + countBits + byteLength * 8;
    if (needed <= dataCodewords * 8) return v;
    void total;
    void ec;
  }
  throw new Error('QR payload too large for versions 1-10');
}

function buildDataCodewords(bytes, version) {
  const [, , g1b, g1d, g2b, g2d] = VERSIONS_M[version];
  const dataCodewords = g1b * g1d + g2b * g2d;
  const capacityBits = dataCodewords * 8;
  const countBits = version <= 9 ? 8 : 16;

  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push(bitAt(value, i));
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);

  // Terminator: up to four zero bits, truncated if we are near capacity.
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out[i / 8] = byte;
  }
  // Alternating pad bytes, per spec.
  const padStart = bits.length / 8;
  for (let i = padStart; i < dataCodewords; i++) {
    out[i] = (i - padStart) % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/** Split into blocks, compute EC per block, then interleave both halves. */
function interleave(dataCodewords, version) {
  const [total, ecPerBlock, g1b, g1d, g2b, g2d] = VERSIONS_M[version];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1b; i++) {
    blocks.push(dataCodewords.slice(offset, offset + g1d));
    offset += g1d;
  }
  for (let i = 0; i < g2b; i++) {
    blocks.push(dataCodewords.slice(offset, offset + g2d));
    offset += g2d;
  }
  const ecBlocks = blocks.map((b) => rsEncode(b, ecPerBlock));

  const result = new Uint8Array(total);
  let pos = 0;
  const maxData = Math.max(g1d, g2d || 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.length) result[pos++] = block[i];
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result[pos++] = block[i];
  }
  return result;
}

// --- Matrix construction ---------------------------------------------------
function newMatrix(size) {
  return {
    size,
    modules: Array.from({ length: size }, () => new Uint8Array(size)),
    reserved: Array.from({ length: size }, () => new Uint8Array(size)),
  };
}

function setFunction(m, row, col, dark) {
  m.modules[row][col] = dark ? 1 : 0;
  m.reserved[row][col] = 1;
}

function drawFinder(m, row, col) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= m.size || c < 0 || c >= m.size) continue;
      const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      setFunction(m, r, c, dist !== 2 && dist <= 3);
    }
  }
}

function drawFunctionPatterns(m, version) {
  const size = m.size;

  // Timing patterns first; finders and alignment overwrite where they overlap.
  for (let i = 0; i < size; i++) {
    setFunction(m, 6, i, i % 2 === 0);
    setFunction(m, i, 6, i % 2 === 0);
  }

  drawFinder(m, 0, 0);
  drawFinder(m, 0, size - 7);
  drawFinder(m, size - 7, 0);

  const centers = ALIGNMENT[version];
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      // Skip the three corners occupied by finder patterns.
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === centers.length - 1) ||
        (i === centers.length - 1 && j === 0);
      if (corner) continue;
      const row = centers[i];
      const col = centers[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFunction(m, row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format-info strips (values written later, once a mask is chosen).
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunction(m, 8, i, false);
      setFunction(m, i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunction(m, 8, size - 1 - i, false);
    setFunction(m, size - 1 - i, 8, false);
  }
  setFunction(m, size - 8, 8, true); // permanently dark module

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = bitAt(bits, i) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(m, b, a, bit);
      setFunction(m, a, b, bit);
    }
  }
}

function drawCodewords(m, data) {
  const size = m.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (!m.reserved[row][col] && i < data.length * 8) {
          m.modules[row][col] = bitAt(data[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  const fn = MASK_FNS[mask];
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.reserved[r][c] && fn(r, c)) m.modules[r][c] ^= 1;
    }
  }
}

function drawFormatInfo(m, mask) {
  const bits = formatBits(ECC_M_INDICATOR, mask);
  const size = m.size;
  for (let i = 0; i <= 5; i++) setFunction(m, i, 8, bitAt(bits, i));
  setFunction(m, 7, 8, bitAt(bits, 6));
  setFunction(m, 8, 8, bitAt(bits, 7));
  setFunction(m, 8, 7, bitAt(bits, 8));
  for (let i = 9; i < 15; i++) setFunction(m, 8, 14 - i, bitAt(bits, i));

  for (let i = 0; i < 8; i++) setFunction(m, 8, size - 1 - i, bitAt(bits, i));
  for (let i = 8; i < 15; i++) setFunction(m, size - 15 + i, 8, bitAt(bits, i));
  setFunction(m, size - 8, 8, 1);
}

/** The four penalty rules from the spec; lowest total wins. */
function penalty(m) {
  const size = m.size;
  const mod = m.modules;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i++) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j++) {
      runRow = mod[i][j] === mod[i][j - 1] ? runRow + 1 : 1;
      if (runRow === 5) score += 3;
      else if (runRow > 5) score += 1;

      runCol = mod[j][i] === mod[j - 1][i] ? runCol + 1 : 1;
      if (runCol === 5) score += 3;
      else if (runCol > 5) score += 1;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = mod[r][c];
      if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules on a side.
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get, start) => {
    let a = true;
    let b = true;
    for (let k = 0; k < 11; k++) {
      const v = get(start + k);
      if (v !== p1[k]) a = false;
      if (v !== p2[k]) b = false;
    }
    return a || b;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      if (matches((k) => mod[i][k], j)) score += 40;
      if (matches((k) => mod[k][i], j)) score += 40;
    }
  }

  // Rule 4: deviation from a 50/50 dark ratio.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mod[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encode `text` and return { size, modules } where modules is an array of rows
 * of 0/1. Tries all eight masks and keeps the lowest-penalty one.
 */
export function encodeQR(text) {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = interleave(buildDataCodewords(bytes, version), version);
  const size = 17 + 4 * version;

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = newMatrix(size);
    drawFunctionPatterns(m, version);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormatInfo(m, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { score, matrix: m, mask };
  }

  return {
    size,
    version,
    mask: best.mask,
    modules: best.matrix.modules.map((row) => Array.from(row)),
    // Exposed so tests can walk the data region without re-deriving where the
    // function patterns sit.
    reserved: best.matrix.reserved.map((row) => Array.from(row)),
  };
}

/** Block layout for a version, so a reader can de-interleave. Test support. */
export function blockLayout(version) {
  const [total, ecPerBlock, g1b, g1d, g2b, g2d] = VERSIONS_M[version];
  return { total, ecPerBlock, g1b, g1d, g2b, g2d };
}

/**
 * Render to SVG. `currentColor` lets the page theme the code, and the light
 * modules are painted explicitly so a dark page background cannot bleed
 * through and break the contrast a scanner needs.
 */
export function qrToSvg(text, { moduleSize = 6, margin = 4, background = '#ffffff' } = {}) {
  const { size, modules } = encodeQR(text);
  const dim = (size + margin * 2) * moduleSize;

  // One path for every dark module beats one <rect> each: same pixels, a
  // fraction of the bytes.
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        path += `M${(c + margin) * moduleSize} ${(r + margin) * moduleSize}h${moduleSize}v${moduleSize}h-${moduleSize}z`;
      }
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="QR code">` +
    `<rect width="${dim}" height="${dim}" fill="${background}"/>` +
    `<path d="${path}" fill="#000000"/>` +
    `</svg>`
  );
}
