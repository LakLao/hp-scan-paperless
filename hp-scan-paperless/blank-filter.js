// Local stop between the scanner and Paperless that leaves out blank pages.
//
// The scanner (node-hp-scan-to) builds the PDF and posts it to Paperless. With the option
// "remove_blank_pages" on, it posts to this little server instead (127.0.0.1). The server
// looks at every page of the finished PDF (fronts and backs are already in their final
// order), leaves out the blank ones and passes the upload on to Paperless unchanged
// otherwise. So the order of the remaining pages never changes.
//
// Safety first: whenever something is unexpected (not a PDF, a PDF layout this code doesn't
// know, a decoding error, every page blank), the original upload is passed on untouched.
//
// Pages are removed with an incremental update: the original bytes stay as they are and a
// new page list is appended (the standard way PDF editors save changes).
"use strict";

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const path = require("path");
const decodeJpeg = require(path.join(__dirname, "vendor", "jpeg-js-decoder.js"));

const PORT = Number(process.env.BLANK_FILTER_PORT || 3010);
const TARGET = process.env.PAPERLESS_POST_DOCUMENT_URL || "";
// A page is blank when less than this percentage of its area has ink.
const THRESHOLD = (() => {
    const v = parseFloat(process.env.BLANK_THRESHOLD);
    return Number.isFinite(v) && v >= 0 ? v : 0.1;
})();
const DARK = 128;        // grey value below which a pixel is ink (bleed-through stays above)
const MARGIN_X = 0.08;   // left/right edge ignored: punch holes, paper edge, feeder shadow
const MARGIN_Y = 0.05;   // top/bottom edge ignored
const CELLS_ACROSS = 160; // area is measured in small squares (about 1.3 mm at A4 width)

function log(msg) {
    try { process.stdout.write(`[blank-pages] ${msg}\n`); } catch (_) { /* ignore */ }
}

class Unsupported extends Error {}

// ---------------------------------------------------------------- PDF (classic xref only)

const s = (buf, a, b) => buf.toString("latin1", a, b);

function parsePdf(buf) {
    if (s(buf, 0, 5) !== "%PDF-") throw new Unsupported("not a PDF");
    const tail = s(buf, Math.max(0, buf.length - 1024));
    const m = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
    if (!m) throw new Unsupported("no startxref");
    const xrefAt = Number(m[1]);
    if (s(buf, xrefAt, xrefAt + 4) !== "xref") throw new Unsupported("xref stream");

    const rest = s(buf, xrefAt);
    const ti = rest.indexOf("trailer");
    const si = rest.indexOf("startxref", ti);
    if (ti < 0 || si < 0) throw new Unsupported("no trailer");
    const trailer = rest.slice(ti + 7, si).trim();
    if (!trailer.startsWith("<<") || !trailer.endsWith(">>")) throw new Unsupported("trailer");
    if (/\/(Prev|Encrypt|XRefStm)\b/.test(trailer)) throw new Unsupported("updated or encrypted PDF");

    const offsets = new Map();
    const lines = rest.slice(4, ti).split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length;) {
        const [first, count] = lines[i++].split(/\s+/).map(Number);
        if (!Number.isInteger(first) || !Number.isInteger(count)) throw new Unsupported("xref");
        for (let k = 0; k < count; k++, i++) {
            const p = (lines[i] || "").split(/\s+/);
            if (p[2] === "n") offsets.set(first + k, { off: Number(p[0]), gen: Number(p[1]) });
        }
    }

    function obj(num) {
        const e = offsets.get(num);
        if (!e) throw new Unsupported(`object ${num} missing`);
        const head = s(buf, e.off, Math.min(buf.length, e.off + 8192));
        const h = head.match(/^(\d+)\s+(\d+)\s+obj\s*/);
        if (!h || Number(h[1]) !== num) throw new Unsupported(`object ${num} not at its offset`);
        const body = head.slice(h[0].length);
        const si2 = body.search(/\bstream(\r\n|\n)/);
        const ei = body.indexOf("endobj");
        if (si2 >= 0 && (ei < 0 || si2 < ei)) {
            const dict = body.slice(0, si2).trim();
            const eol = body.slice(si2 + 6, si2 + 8) === "\r\n" ? 2 : 1;
            const start = e.off + h[0].length + si2 + 6 + eol; // header is plain ASCII
            let len = dict.match(/\/Length\s+(\d+)\s+(\d+)\s+R/);
            len = len ? Number(objText(Number(len[1]))) : Number((dict.match(/\/Length\s+(\d+)/) || [])[1]);
            if (!Number.isFinite(len)) throw new Unsupported(`stream ${num} length`);
            return { num, gen: e.gen, dict, data: buf.subarray(start, start + len) };
        }
        if (ei < 0) throw new Unsupported(`object ${num} too large`);
        return { num, gen: e.gen, dict: body.slice(0, ei).trim() };
    }
    function objText(num) { return obj(num).dict; }

    const ref = (dict, key) => {
        const r = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
        return r ? Number(r[1]) : null;
    };

    const rootNum = ref(trailer, "Root");
    if (rootNum === null) throw new Unsupported("no Root");
    const pagesNum = ref(obj(rootNum).dict, "Pages");
    if (pagesNum === null) throw new Unsupported("no Pages");
    const pages = obj(pagesNum);
    const kidsText = (pages.dict.match(/\/Kids\s*\[([^\]]*)\]/) || [])[1];
    if (kidsText === undefined) throw new Unsupported("no Kids");
    const kids = [...kidsText.matchAll(/(\d+)\s+(\d+)\s+R/g)].map((k) => Number(k[1]));
    if (!kids.length) throw new Unsupported("no pages");

    // For each page: the one JPEG it shows, or null when the page has anything else.
    const pageImages = kids.map((kid) => {
        const page = obj(kid);
        if (!/\/Type\s*\/Page\b/.test(page.dict)) throw new Unsupported("nested page tree");
        const content = contentsOf(page.dict);
        if (/\bBT\b/.test(content)) return null; // text drawn on the page
        const names = [...content.matchAll(/\/([^\s/<>[\]()]+)\s+Do\b/g)].map((d) => d[1]);
        if (names.length !== 1) return null;
        const xobjects = xobjectsOf(page.dict);
        const imgNum = xobjects.get(names[0]);
        if (imgNum === undefined) return null;
        const img = obj(imgNum);
        if (!/\/Subtype\s*\/Image/.test(img.dict) || !/\/Filter\s*\/DCTDecode/.test(img.dict)) return null;
        return img.data;
    });

    function contentsOf(pageDict) {
        let nums = [];
        const arr = pageDict.match(/\/Contents\s*\[([^\]]*)\]/);
        if (arr) nums = [...arr[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => Number(r[1]));
        else if (ref(pageDict, "Contents") !== null) nums = [ref(pageDict, "Contents")];
        return nums.map((n) => {
            const st = obj(n);
            if (!st.data) throw new Unsupported("content is not a stream");
            if (/\/Filter\s*\/FlateDecode/.test(st.dict)) return zlib.inflateSync(st.data).toString("latin1");
            if (/\/Filter/.test(st.dict)) throw new Unsupported("content filter");
            return st.data.toString("latin1");
        }).join("\n");
    }

    function xobjectsOf(pageDict) {
        let res = pageDict;
        const rr = ref(pageDict, "Resources");
        if (rr !== null) res = obj(rr).dict;
        let xo = "";
        const xr = res.match(/\/XObject\s+(\d+)\s+\d+\s+R/);
        if (xr) xo = obj(Number(xr[1])).dict;
        else {
            const i = res.indexOf("/XObject");
            if (i >= 0) { const a = res.indexOf("<<", i), b = res.indexOf(">>", a); xo = res.slice(a, b); }
        }
        const map = new Map();
        for (const m2 of xo.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) map.set(m2[1], Number(m2[2]));
        return map;
    }

    return { xrefAt, trailer, pages, kids, pageImages };
}

function withoutPages(buf, pdf, remove) {
    const keep = pdf.kids.filter((_, i) => !remove.has(i));
    const dict = pdf.pages.dict
        .replace(/\/Kids\s*\[[^\]]*\]/, `/Kids [${keep.map((n) => `${n} 0 R`).join(" ")}]`)
        .replace(/\/Count\s+\d+/, `/Count ${keep.length}`);
    let add = buf[buf.length - 1] === 0x0a ? "" : "\n";
    const objAt = buf.length + add.length;
    add += `${pdf.pages.num} ${pdf.pages.gen} obj\n${dict}\nendobj\n`;
    const xrefAt = buf.length + add.length;
    add += `xref\n${pdf.pages.num} 1\n${String(objAt).padStart(10, "0")} ${String(pdf.pages.gen).padStart(5, "0")} n \n`;
    add += `trailer\n${pdf.trailer.replace(/>>$/, `/Prev ${pdf.xrefAt}\n>>`)}\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.concat([buf, Buffer.from(add, "latin1")]);
}

// ---------------------------------------------------------------- blank detection

function inkPercent(jpegBytes) {
    const img = decodeJpeg(jpegBytes, {
        useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200,
    });
    const { width: w, height: h, data } = img;
    const cell = Math.max(4, Math.round(w / CELLS_ACROSS));
    // Ink pixels for a square to count: a pen stroke or letter crossing it does, a dust speck
    // of a few pixels doesn't.
    const need = Math.max(2, Math.round(cell * cell * 0.12));
    const x0 = Math.floor(w * MARGIN_X), y0 = Math.floor(h * MARGIN_Y);
    const cols = Math.floor((w - 2 * x0) / cell), rows = Math.floor((h - 2 * y0) / cell);
    if (cols <= 0 || rows <= 0) return 100;
    const dark3 = DARK * 3;
    let ink = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            let n = 0;
            const ys = y0 + r * cell, xs = x0 + c * cell;
            scan: for (let y = ys; y < ys + cell; y++) {
                let i = (y * w + xs) * 3;
                for (let x = 0; x < cell; x++, i += 3) {
                    if (data[i] + data[i + 1] + data[i + 2] < dark3 && ++n >= need) break scan;
                }
            }
            if (n >= need) ink++;
        }
    }
    return (100 * ink) / (rows * cols);
}

function filterPdf(pdfBuf, name) {
    const started = Date.now();
    const pdf = parsePdf(pdfBuf);
    const inks = pdf.pageImages.map((jpg) => (jpg ? inkPercent(jpg) : null));
    const remove = new Set();
    inks.forEach((v, i) => { if (v !== null && v < THRESHOLD) remove.add(i); });
    const list = inks.map((v, i) => `${i + 1}=${v === null ? "?" : v.toFixed(2)}`).join(" ");
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (remove.size === 0) {
        log(`${name}: ${inks.length} page(s), none blank (${secs}s; ink %: ${list})`);
        return pdfBuf;
    }
    if (remove.size === inks.length) {
        log(`${name}: every page looks blank, sending it unchanged (ink %: ${list})`);
        return pdfBuf;
    }
    const pagesOut = [...remove].map((i) => i + 1).join(", ");
    log(`${name}: ${inks.length} page(s), left out ${remove.size} blank: ${pagesOut} (${secs}s; ink %: ${list})`);
    return withoutPages(pdfBuf, pdf, remove);
}

// ---------------------------------------------------------------- upload pass-through

function filterUpload(contentType, body) {
    const b = (contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i) || []);
    const boundary = b[1] || b[2];
    if (!/^multipart\/form-data/i.test(contentType) || !boundary) return body;
    const delim = Buffer.from(`--${boundary.trim()}`, "latin1");
    let at = body.indexOf(delim);
    while (at >= 0) {
        const next = body.indexOf(delim, at + delim.length);
        if (next < 0) break;
        const headEnd = body.indexOf("\r\n\r\n", at);
        if (headEnd < 0 || headEnd > next) break;
        const headers = s(body, at, headEnd);
        const fn = headers.match(/filename="([^"]*)"/i);
        if (fn) {
            const start = headEnd + 4;
            const end = next - 2; // the CRLF before the next boundary
            const file = body.subarray(start, end);
            if (s(file, 0, 5) !== "%PDF-") return body;
            const out = filterPdf(Buffer.from(file), path.basename(fn[1]));
            if (out === file || out.equals(file)) return body;
            return Buffer.concat([body.subarray(0, start), out, body.subarray(end)]);
        }
        at = next;
    }
    return body;
}

function forward(req, body, res) {
    const url = new URL(TARGET);
    const headers = { ...req.headers };
    delete headers.host; delete headers["content-length"]; delete headers.connection;
    delete headers["transfer-encoding"];
    headers["content-length"] = body.length;
    const out = (url.protocol === "https:" ? https : http).request(url, {
        method: req.method, headers, timeout: 120000,
    }, (up) => {
        const h = {};
        if (up.headers["content-type"]) h["content-type"] = up.headers["content-type"];
        res.writeHead(up.statusCode || 502, h);
        up.pipe(res);
    });
    out.on("timeout", () => out.destroy(new Error("timeout")));
    out.on("error", (e) => {
        log(`could not reach Paperless: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
    });
    out.end(body);
}

if (!TARGET) {
    log("no Paperless address; not started");
    process.exit(1);
}

const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.end("ok\n"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", (e) => log(`upload interrupted: ${e.message}`));
    req.on("end", () => {
        let body = Buffer.concat(chunks);
        try {
            body = filterUpload(String(req.headers["content-type"] || ""), body);
        } catch (e) {
            log(`${e instanceof Unsupported ? "not checked" : "error"} (${e.message}); sending the scan unchanged`);
            body = Buffer.concat(chunks);
        }
        forward(req, body, res);
    });
});
server.requestTimeout = 0;
server.listen(PORT, "127.0.0.1", () => log(`ready on 127.0.0.1:${PORT}, threshold ${THRESHOLD}% ink`));
process.on("uncaughtException", (e) => log(`error: ${e.message}`));
