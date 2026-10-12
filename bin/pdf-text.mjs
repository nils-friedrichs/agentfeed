// bin/pdf-text.mjs — PDF bytes on stdin -> JSON { pages, title, text: [page strings] } on stdout.
// Spawned by tools/webmd.js with --max-old-space-size=128 and a hard timeout, so a hostile or
// huge PDF can only kill this child, never the server.
import { extractText, getDocumentProxy, getMeta } from 'unpdf';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const pdf = await getDocumentProxy(new Uint8Array(Buffer.concat(chunks)));
let title = null;
try { const m = await getMeta(pdf); title = (m && m.info && m.info.Title) || null; } catch { /* no metadata */ }
const { totalPages, text } = await extractText(pdf, { mergePages: false });
process.stdout.write(JSON.stringify({ pages: totalPages, title, text }));
