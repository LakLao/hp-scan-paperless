// Reads the scanner's log on stdin, passes it through unchanged to stdout, and watches
// emulated two-sided scans. When the fronts and backs of one scan have a different number
// of pages, it fires the event "hp_scan_duplex_mismatch" in Home Assistant (via the
// Supervisor API), so an automation can warn and offer a restart. The incomplete PDF is
// still uploaded by the scanner; once Paperless has added it, it gets the tag set in the
// option "incomplete_tag" (e.g. "Onvolledige scan"), so it is easy to find and delete.
//
// Must never stop reading: if this process died, the scanner would write into a closed
// pipe and be killed. So every step is wrapped, and errors are only logged.
"use strict";

const http = require("http");
const https = require("https");

const EVENT = "hp_scan_duplex_mismatch";
const TOKEN = process.env.SUPERVISOR_TOKEN || "";
// Add-on slug, e.g. 32adf813_hp_scan_paperless (the container hostname uses dashes).
const ADDON = (process.env.HOSTNAME || "").replace(/-/g, "_");

const RE_SIDE = /saving (front|back) sides of scan #(\d+)/;
const RE_EVENT = /Scan event captured/;
const RE_PAGES = /Job state: Completed \((\d+) page\(s\)\)/;
const RE_DONE = /Emulated duplex scan completed|Scan #(\d+) saved as PDF/;
const RE_UPLOAD_START = /Start uploading to paperless: (\S+)/;
const RE_UPLOADED = /Document successfully uploaded to paperless/;
const RE_UPLOAD_FAILED = /(upload|uploading)[^\n]*(fail|error)/i;

// Paperless: base address from the scanner's upload URL, token and tag name from the options.
const PAPERLESS_BASE = (process.env.PAPERLESS_POST_DOCUMENT_URL || "")
    .replace(/\/api\/documents\/post_document\/?$/, "");
const PAPERLESS_TOKEN = process.env.PAPERLESS_TOKEN || "";
const TAG_NAME = (process.env.INCOMPLETE_TAG || "").trim();
const POLL_MS = Number(process.env.DUPLEX_CHECK_POLL_MS || 15000);
const POLL_MAX_MS = 60 * 60 * 1000; // Paperless may need a while for OCR of a long scan.

// Incomplete scan waiting for its upload: { scan: n, file: basename|null }
let pendingTag = null;

// scans[n] = { front: pages|null, back: pages|null, reported: bool }
const scans = new Map();
let current = null; // { scan: n, side: "front"|"back" } while a side is being fetched

function log(msg) {
    try { process.stdout.write(`[duplex-check] ${msg}\n`); } catch (_) { /* ignore */ }
}

function fireEvent(data) {
    if (!TOKEN) {
        log("no SUPERVISOR_TOKEN; cannot notify Home Assistant");
        return;
    }
    const body = JSON.stringify(data);
    const req = http.request({
        host: process.env.DUPLEX_CHECK_HOST || "supervisor",
        port: Number(process.env.DUPLEX_CHECK_PORT || 80),
        path: `/core/api/events/${EVENT}`,
        method: "POST",
        timeout: 10000,
        headers: {
            "Authorization": `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
        },
    }, (res) => {
        res.resume();
        log(`event ${EVENT} sent to Home Assistant (HTTP ${res.statusCode})`);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => log(`could not send event: ${e.message}`));
    req.end(body);
}

function paperless(method, path, data) {
    return new Promise((resolve, reject) => {
        const url = new URL(PAPERLESS_BASE + path);
        const body = data === undefined ? null : JSON.stringify(data);
        const headers = { "Authorization": `Token ${PAPERLESS_TOKEN}`, "Accept": "application/json" };
        if (body !== null) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = Buffer.byteLength(body);
        }
        const req = (url.protocol === "https:" ? https : http).request(url, {
            method, headers, timeout: 20000,
        }, (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (d) => { text += d; });
            res.on("end", () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`${method} ${path}: HTTP ${res.statusCode}`));
                    return;
                }
                try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        req.end(body === null ? undefined : body);
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tagId() {
    const q = encodeURIComponent(TAG_NAME);
    const found = await paperless("GET", `/api/tags/?name__iexact=${q}`);
    if (found.results && found.results.length) return found.results[0].id;
    const made = await paperless("POST", "/api/tags/", {
        name: TAG_NAME, color: "#d32f2f", matching_algorithm: 0, is_inbox_tag: false,
    });
    log(`created tag "${TAG_NAME}" in Paperless`);
    return made.id;
}

async function tagDocument(scan, file) {
    const q = encodeURIComponent(file);
    const start = Date.now();
    let docId = null;
    while (Date.now() - start < POLL_MAX_MS) {
        const r = await paperless("GET", `/api/documents/?original_filename__iexact=${q}&fields=id`)
            .catch((e) => { log(`Paperless lookup failed: ${e.message}`); return null; });
        if (r && r.results && r.results.length) {
            docId = Math.max(...r.results.map((d) => d.id));
            break;
        }
        await sleep(POLL_MS);
    }
    if (docId === null) {
        log(`scan #${scan}: document ${file} not found in Paperless; not tagged`);
        return;
    }
    const tag = await tagId();
    await paperless("POST", "/api/documents/bulk_edit/", {
        documents: [docId], method: "add_tag", parameters: { tag },
    });
    log(`scan #${scan}: Paperless document ${docId} tagged "${TAG_NAME}"`);
}

function startTagging(scan, file) {
    if (!TAG_NAME || !PAPERLESS_BASE || !PAPERLESS_TOKEN) return;
    log(`scan #${scan}: waiting for Paperless to add ${file}, then tagging it`);
    tagDocument(scan, file).catch((e) => log(`scan #${scan}: tagging failed: ${e.message}`));
}

function check(n) {
    const s = scans.get(n);
    if (!s || s.reported || s.front === null || s.back === null) return;
    s.reported = true;
    if (s.front === s.back) {
        log(`scan #${n}: ${s.front} fronts and ${s.back} backs, OK`);
    } else {
        log(`scan #${n}: ${s.front} fronts but ${s.back} backs — pages are missing`);
        fireEvent({ scan: n, front_pages: s.front, back_pages: s.back, addon: ADDON,
                    tag: TAG_NAME || null });
        pendingTag = { scan: n, file: null };
    }
    // Keep only recent scans in memory.
    for (const k of scans.keys()) if (k < n - 5) scans.delete(k);
}

function handle(line) {
    let m;
    if (pendingTag) {
        m = line.match(RE_UPLOAD_START);
        if (m) { pendingTag.file = m[1].split("/").pop(); return; }
        if (RE_UPLOADED.test(line) && pendingTag.file) {
            const p = pendingTag;
            pendingTag = null;
            startTagging(p.scan, p.file);
            return;
        }
        if (RE_UPLOAD_FAILED.test(line)) {
            log(`scan #${pendingTag.scan}: upload failed, nothing to tag`);
            pendingTag = null;
            return;
        }
    }

    m = line.match(RE_SIDE);
    if (m) {
        const n = Number(m[2]);
        const side = m[1];
        if (side === "front") {
            pendingTag = null; // a new scan started before the previous upload was seen
            // New fronts (also when fronts are scanned again): start over for this scan.
            scans.set(n, { front: null, back: null, reported: false });
        } else if (!scans.has(n)) {
            scans.set(n, { front: null, back: null, reported: false });
        }
        scans.get(n)[side] = null;
        current = { scan: n, side };
        return;
    }
    if (RE_EVENT.test(line)) { current = null; return; }

    m = line.match(RE_PAGES);
    if (m && current) {
        const s = scans.get(current.scan);
        if (s) s[current.side] = (s[current.side] || 0) + Number(m[1]);
        return;
    }

    m = line.match(RE_DONE);
    if (m && current && current.side === "back") {
        const n = current.scan;
        current = null;
        check(n);
    }
}

let buf = "";
process.stdin.on("data", (chunk) => {
    try { process.stdout.write(chunk); } catch (_) { /* ignore */ }
    try {
        buf += chunk.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try { handle(line); } catch (e) { log(`error: ${e.message}`); }
        }
        if (buf.length > 65536) buf = "";
    } catch (e) {
        log(`error: ${e.message}`);
    }
});
// On end of input Node exits by itself once a pending event request has finished.
process.stdout.on("error", () => { /* ignore */ });
process.on("uncaughtException", (e) => log(`error: ${e.message}`));
