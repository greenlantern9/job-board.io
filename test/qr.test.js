import test from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, formatBits, versionBits, encodeQR, qrToSvg, blockLayout } from '../src/qr.js';

// --- GF(256) helpers, written independently of src/qr.js so the checks below
// --- are not just the implementation agreeing with itself.
const gfExp = [];
const gfLog = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    x &= 0xff;
  }
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : gfExp[(gfLog[a] + gfLog[b]) % 255]);

/** Evaluate a polynomial (highest-degree-first) at x using Horner's method. */
function evalPoly(coeffs, x) {
  let acc = 0;
  for (const c of coeffs) acc = mul(acc, x) ^ c;
  return acc;
}

test('Reed-Solomon output makes the codeword divisible by the generator', () => {
  // The defining property of an RS code: the full codeword polynomial has
  // roots at a^0 .. a^(n-1). This catches any error in the GF tables, the
  // generator polynomial, or the division loop - without depending on a
  // transcribed lookup table.
  for (const ecLength of [7, 10, 13, 16, 18, 22, 24, 26]) {
    const data = Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 0xff);
    const ec = Array.from(rsEncode(data, ecLength));
    const codeword = [...data, ...ec];
    for (let i = 0; i < ecLength; i++) {
      assert.equal(
        evalPoly(codeword, gfExp[i]),
        0,
        `ecLength=${ecLength} should have a root at a^${i}`
      );
    }
  }
});

test('Reed-Solomon output has the requested length and is deterministic', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
  assert.equal(rsEncode(data, 13).length, 13);
  assert.deepEqual(Array.from(rsEncode(data, 13)), Array.from(rsEncode(data, 13)));
  // All-zero data must produce all-zero parity.
  assert.deepEqual(Array.from(rsEncode(new Array(13).fill(0), 13)), new Array(13).fill(0));
});

test('format information bits match the published table', () => {
  const bin = (n) => n.toString(2).padStart(15, '0');
  assert.equal(bin(formatBits(0b00, 0)), '101010000010010'); // level M, mask 0
  assert.equal(bin(formatBits(0b01, 0)), '111011111000100'); // level L, mask 0
  assert.equal(bin(formatBits(0b00, 5)), '100000011001110'); // level M, mask 5
});

test('version information bits match the published table', () => {
  const bin = (n) => n.toString(2).padStart(18, '0');
  assert.equal(bin(versionBits(7)), '000111110010010100');
  assert.equal(bin(versionBits(10)), '001010010011010011');
});

test('matrix has correct size and function patterns', () => {
  const { size, modules, version } = encodeQR('HELLO');
  assert.equal(version, 1);
  assert.equal(size, 21);
  assert.equal(modules.length, 21);

  // Finder pattern: 7x7 with a dark ring and dark 3x3 core.
  for (const [r0, c0] of [
    [0, 0],
    [0, 14],
    [14, 0],
  ]) {
    for (let i = 0; i < 7; i++) {
      assert.equal(modules[r0][c0 + i], 1, 'finder top edge');
      assert.equal(modules[r0 + 6][c0 + i], 1, 'finder bottom edge');
      assert.equal(modules[r0 + i][c0], 1, 'finder left edge');
      assert.equal(modules[r0 + i][c0 + 6], 1, 'finder right edge');
    }
    assert.equal(modules[r0 + 1][c0 + 1], 0, 'finder inner ring is light');
    assert.equal(modules[r0 + 3][c0 + 3], 1, 'finder core is dark');
  }

  // Timing patterns alternate, starting dark at index 8.
  for (let i = 8; i < 13; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `vertical timing at ${i}`);
  }

  // The dark module is always set.
  assert.equal(modules[size - 8][8], 1);
});

test('version scales with payload length and covers otpauth URIs', () => {
  assert.equal(encodeQR('a'.repeat(14)).version, 1);
  assert.equal(encodeQR('a'.repeat(15)).version, 2);

  const uri =
    'otpauth://totp/job-board.io%3Aperson%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' +
    '&issuer=job-board.io&algorithm=SHA1&digits=6&period=30';
  const qr = encodeQR(uri);
  assert.ok(qr.version >= 7 && qr.version <= 10, `expected version 7-10, got ${qr.version}`);
  assert.equal(qr.size, 17 + 4 * qr.version);
});

test('svg output is self-contained and sized correctly', () => {
  const svg = qrToSvg('hello', { moduleSize: 4, margin: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!svg.includes('<script'));
  // version 1 => 21 modules + 8 margin, at 4px each
  assert.ok(svg.includes(`width="${(21 + 8) * 4}"`));
});

test('payloads beyond version 10 are rejected rather than silently truncated', () => {
  assert.throws(() => encodeQR('x'.repeat(400)), /too large/);
});

// --- Full round trip -------------------------------------------------------
// A scanner is the only real test of an encoder, so this is the next best
// thing: an independent reader that unmasks the matrix, walks the data region,
// de-interleaves the blocks, and parses the byte-mode segment back out. It
// covers bit packing, padding, block interleaving, module placement, masking,
// and format-info encoding in one assertion.

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function readFormatInfo(modules, size) {
  const read = (positions) => {
    let bits = 0;
    positions.forEach(([r, c], i) => {
      bits |= modules[r][c] << i;
    });
    return (bits ^ 0x5412) >> 10;
  };

  const copy1 = [];
  for (let i = 0; i <= 5; i++) copy1.push([i, 8]);
  copy1.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i < 15; i++) copy1.push([8, 14 - i]);

  const copy2 = [];
  for (let i = 0; i < 8; i++) copy2.push([8, size - 1 - i]);
  for (let i = 8; i < 15; i++) copy2.push([size - 15 + i, 8]);

  return { first: read(copy1), second: read(copy2) };
}

function decodeQR(qr) {
  const { size, version, modules, reserved } = qr;

  const { first, second } = readFormatInfo(modules, size);
  assert.equal(first, second, 'both format-info copies must agree');
  const mask = first & 0b111;
  const eccIndicator = first >> 3;
  assert.equal(eccIndicator, 0b00, 'encoder always writes ECC level M');

  // Undo the mask on data modules only.
  const fn = MASKS[mask];
  const grid = modules.map((row, r) =>
    row.map((v, c) => (!reserved[r][c] && fn(r, c) ? v ^ 1 : v))
  );

  // Walk the zigzag, most-significant bit first.
  const { total, ecPerBlock, g1b, g1d, g2b, g2d } = blockLayout(version);
  const codewords = [];
  let byte = 0;
  let bitCount = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (reserved[row][col] || codewords.length >= total) continue;
        byte = (byte << 1) | grid[row][col];
        if (++bitCount === 8) {
          codewords.push(byte);
          byte = 0;
          bitCount = 0;
        }
      }
    }
  }
  assert.equal(codewords.length, total, 'must recover every codeword');

  // De-interleave the data half back into blocks.
  const lengths = [...Array(g1b).fill(g1d), ...Array(g2b).fill(g2d)];
  const blocks = lengths.map((n) => new Array(n));
  let pos = 0;
  for (let i = 0; i < Math.max(g1d, g2d || 0); i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < lengths[b]) blocks[b][i] = codewords[pos++];
    }
  }
  const dataCodewords = blocks.flat();
  assert.equal(dataCodewords.length + ecPerBlock * blocks.length, total);

  // Parse the byte-mode segment.
  const bits = [];
  for (const cw of dataCodewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  const take = (n) => bits.splice(0, n).reduce((acc, b) => (acc << 1) | b, 0);

  assert.equal(take(4), 0b0100, 'mode indicator must be byte mode');
  const length = take(version <= 9 ? 8 : 16);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = take(8);
  return new TextDecoder().decode(out);
}

test('encode -> decode round trip recovers the payload', () => {
  const payloads = [
    'A',
    'HELLO WORLD',
    'a'.repeat(14), // exactly fills version 1
    'a'.repeat(15), // forces version 2
    'https://job-board.io/app',
    'otpauth://totp/job-board.io%3Aperson%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' +
      '&issuer=job-board.io&algorithm=SHA1&digits=6&period=30',
    'x'.repeat(213), // largest payload version 10 holds
  ];
  for (const payload of payloads) {
    const qr = encodeQR(payload);
    assert.equal(decodeQR(qr), payload, `round trip failed for ${payload.slice(0, 32)}...`);
  }
});

test('round trip holds across every version and both block groups', () => {
  // Versions 8-10 use two block groups of different sizes, which is where
  // interleaving is easiest to get wrong.
  const sizes = [10, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  sizes.forEach((len, idx) => {
    const payload = Array.from({ length: len }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
    const qr = encodeQR(payload);
    assert.equal(qr.version, idx + 1, `payload of ${len} chars should be version ${idx + 1}`);
    assert.equal(decodeQR(qr), payload);
  });
});

test('unicode payloads survive the round trip as UTF-8', () => {
  const payload = 'café — naïve 日本語';
  assert.equal(decodeQR(encodeQR(payload)), payload);
});
