import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { get, list, put, del } from '@vercel/blob';

const PREFIX = 'interrogazioni-hardware/snapshots/';
const MAX_BYTES = 4_000_000;
const KEEP_SNAPSHOTS = 50;
const GITHUB_ORIGIN = 'https://mirtexxan.github.io';

function headersFor(request) {
  const origin = request.headers.get('origin');
  const sameOrigin = origin === new URL(request.url).origin;
  const headers = {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin === GITHUB_ORIGIN || sameOrigin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), { status, headers: headersFor(request) });
}

function authorized(request) {
  const expected = process.env.TEACHER_CODE_SHA256;
  const supplied = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected) || !supplied || supplied.length > 256) return false;
  const actual = createHash('sha256').update(supplied, 'utf8').digest();
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function validSession(s) {
  return s && typeof s.uid === 'string' && s.uid.length <= 100 &&
    typeof s.student === 'string' && s.student.length <= 100 &&
    typeof s.classe === 'string' && s.classe.length <= 100 &&
    /^[A-G]$/.test(s.group) && typeof s.date === 'string' &&
    Number.isFinite(Date.parse(s.date)) && Array.isArray(s.rows) && s.rows.length <= 20 &&
    s.rows.every(r => r && typeof r.question === 'string' &&
      typeof r.label === 'string' && typeof r.note === 'string' &&
      typeof r.value === 'number' && r.value >= 1 && r.value <= 10) &&
    (!s.questions || Array.isArray(s.questions) && s.questions.length <= 20) &&
    typeof s.notes === 'string' && s.notes.length <= 4000 &&
    (s.final === null || typeof s.final === 'number' && s.final >= 1 && s.final <= 10);
}

function validState(s) {
  return s && s.version === 1 && Array.isArray(s.scale) && s.scale.length === 5 &&
    s.scale.every(x => x && typeof x.label === 'string' &&
      typeof x.value === 'number' && x.value >= 1 && x.value <= 10) &&
    Array.isArray(s.history) && s.history.length <= 2000 &&
    s.history.every(validSession) && (s.current === null || validSession(s.current));
}

async function snapshots() {
  let cursor;
  const all = [];
  do {
    const page = await list({ prefix: PREFIX, limit: 1000, cursor });
    all.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  all.sort((a, b) => a.pathname.localeCompare(b.pathname));
  return all;
}

async function latest() {
  const all = await snapshots();
  return { all, blob: all.at(-1) ?? null };
}

async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: headersFor(request) });
  }
  if (!authorized(request)) return json(request, 401, { error: 'Codice docente non valido.' });
  if (!['GET', 'POST'].includes(request.method)) return json(request, 405, { error: 'Metodo non consentito.' });

  try {
    if (request.method === 'GET') {
      const { blob } = await latest();
      if (!blob) return json(request, 200, { state: null, revision: null });
      const result = await get(blob.pathname, { access: 'private' });
      if (result?.statusCode !== 200 || !result.stream) throw new Error('Snapshot non leggibile');
      const text = await new Response(result.stream).text();
      const state = JSON.parse(text);
      if (!validState(state)) throw new Error('Snapshot non valido');
      return json(request, 200, { state, revision: blob.pathname });
    }

    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) return json(request, 413, { error: 'Archivio troppo grande.' });
    let payload;
    try { payload = JSON.parse(raw); } catch { return json(request, 400, { error: 'Dati non validi.' }); }
    if (!validState(payload?.state) ||
        !(payload.revision === null || typeof payload.revision === 'string')) {
      return json(request, 400, { error: 'Archivio non valido.' });
    }
    const { all, blob } = await latest();
    if ((blob?.pathname ?? null) !== payload.revision) {
      return json(request, 409, { error: 'Archivio aggiornato da un’altra scheda. Esporta il backup e ricarica.', revision: blob?.pathname ?? null });
    }

    const pathname = PREFIX + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.json';
    await put(pathname, JSON.stringify(payload.state), {
      access: 'private', contentType: 'application/json', addRandomSuffix: false,
    });
    // Each snapshot is immutable, so a subsequent read never sees a cached old version.
    const obsolete = all.slice(0, Math.max(0, all.length - KEEP_SNAPSHOTS + 1));
    if (obsolete.length) await del(obsolete.map(x => x.url)).catch(() => {});
    return json(request, 200, { revision: pathname });
  } catch (error) {
    console.error('Cloud archive error:', error);
    return json(request, 503, { error: 'Archivio cloud non disponibile. Riprova senza chiudere la pagina.' });
  }
}

export default { fetch: handler };