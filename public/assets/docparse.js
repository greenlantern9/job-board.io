// Reading a CV out of a file, in the browser.
//
// Deliberately client-side. A CV is one of the more sensitive documents a
// person owns, and extracting text from it needs no server - so the file never
// leaves the machine. Only the text the user can see and edit is ever sent, and
// only when they press save.
//
// No libraries: the page runs under script-src 'self' with no CDN, and pulling
// in a megabyte of PDF parser for one field would be a poor trade. DOCX is a
// zip of XML, which DecompressionStream handles natively. PDF is genuinely
// hard, so it is attempted honestly and refused clearly when it fails.

const MAX_BYTES = 8 * 1024 * 1024;

/** Inflate raw deflate data using the platform, not a bundled library. */
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- zip ------------------------------------------------------------------

function findEndOfCentralDirectory(view, bytes) {
  // The record is at the end but may be followed by a comment, so scan back.
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * Pull one named entry out of a zip. Reads the central directory rather than
 * scanning local headers, because a local header may report a size of zero when
 * the archive was written as a stream - which is common for .docx.
 */
async function readZipEntry(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes);
  if (eocd === -1) throw new Error('not a valid zip archive');

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (name === wanted) {
      // The local header repeats the name and extra fields, at its own lengths.
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      return method === 0 ? data : inflateRaw(data);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wanted} not found in the archive`);
}

// --- docx -----------------------------------------------------------------

/** Word XML to readable text. Paragraph and break tags become newlines so the
 *  structure a CV relies on survives. */
function wordXmlToText(xml) {
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:br\s*\/?>/g, '\n')
    .replace(/<w:tab\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readDocx(bytes) {
  const doc = await readZipEntry(bytes, 'word/document.xml');
  return wordXmlToText(new TextDecoder().decode(doc));
}

// --- pdf ------------------------------------------------------------------

/** Text-showing operators carry their strings in parentheses. */
function pdfStringsFrom(content) {
  const out = [];
  // Tj and TJ are the two that matter; TJ holds an array of strings and kerns.
  for (const match of content.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
    const raw = match[0].slice(1, -1);
    out.push(
      raw
        .replace(/\\([nrtbf])/g, (_, c) => ({ n: '\n', r: '\n', t: '\t', b: '', f: '' })[c])
        .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\\(.)/g, '$1')
    );
  }
  return out.join('');
}

/**
 * Best-effort PDF text extraction.
 *
 * This handles the common case - a PDF whose content streams are Flate-encoded
 * and whose fonts use standard encodings - and fails on plenty of others.
 * Scanned CVs are images with no text at all, and subset fonts with custom
 * encodings produce mojibake. So the result is checked before it is offered,
 * and refused rather than returned as garbage: half-read text silently becoming
 * someone's profile is worse than an honest "paste it instead".
 */
async function readPdf(bytes) {
  const latin = new TextDecoder('latin1').decode(bytes);
  const pieces = [];

  // Uncompressed content, which some generators still emit.
  for (const match of latin.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const body = match[1];
    if (/BT[\s\S]*ET/.test(body)) pieces.push(pdfStringsFrom(body));
  }

  // Flate-encoded content streams.
  for (const match of latin.matchAll(/FlateDecode[\s\S]{0,200}?stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) continue;
    try {
      const raw = bytes.subarray(start, end);
      const text = new TextDecoder('latin1').decode(await inflateRaw(raw));
      if (/BT[\s\S]*ET/.test(text)) pieces.push(pdfStringsFrom(text));
    } catch {
      // Not inflatable from this offset; skip rather than abort the whole file.
    }
  }

  const text = pieces.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Quality gate. Real prose is mostly letters and spaces; a failed extraction
  // is mostly symbols, or almost empty.
  const letters = (text.match(/[a-zA-Z]/g) || []).length;
  if (text.length < 120 || letters / text.length < 0.5) {
    throw new Error('the text layer could not be read');
  }
  return text;
}

// --- entry point ----------------------------------------------------------

/**
 * Read a CV file to text. Throws with a message meant for the user rather than
 * for a log.
 */
export async function readResumeFile(file) {
  if (!file) throw new Error('No file selected.');
  if (file.size > MAX_BYTES) throw new Error('That file is larger than 8MB — is it the right one?');

  const name = (file.name || '').toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (name.endsWith('.txt') || name.endsWith('.md') || file.type.startsWith('text/')) {
    return { text: new TextDecoder().decode(bytes).trim(), kind: 'text' };
  }

  if (name.endsWith('.docx')) {
    try {
      return { text: await readDocx(bytes), kind: 'docx' };
    } catch (err) {
      throw new Error(`Could not read that Word file (${err.message}). Save it as .txt and try again.`);
    }
  }

  if (name.endsWith('.doc')) {
    throw new Error('Old .doc files are not readable here. Save it as .docx or .txt and try again.');
  }

  if (name.endsWith('.pdf')) {
    try {
      return { text: await readPdf(bytes), kind: 'pdf' };
    } catch {
      // The two real causes, both worth naming so the fix is obvious.
      throw new Error(
        'Could not pull text out of that PDF. It is likely a scan, or uses embedded fonts. ' +
          'Open it, select all, copy, and paste into the box below.'
      );
    }
  }

  throw new Error('Unsupported file. Use .txt, .md, .docx, or .pdf — or paste the text below.');
}
