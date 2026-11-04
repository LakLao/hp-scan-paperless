// Reads the scanner's log on stdin, passes it through unchanged to stdout, and watches
// emulated two-sided scans. When the fronts and backs of one scan have a different number
// of pages, it fires the event "hp_scan_duplex_mismatch" in Home Assistant (via the
// Supervisor API), so an automation can warn and offer a restart.
//
// Must never stop reading: if this process died, the scanner would write into a closed
// pipe and be killed. So every step is wrapped, and errors are only logged.
"use strict";

const http = require("http");

const EVENT = "hp_scan_duplex_mismatch";
const TOKEN = process.env.SUPERVISOR_TOKEN || "";
// Add-on slug, e.g. 32adf813_hp_scan_paperless (the container hostname uses dashes).
const ADDON = (process.env.HOSTNAME || "").replace(/-/g, "_");

const RE_SIDE = /saving (front|back) sides of scan #(\d+)/;
const RE_EVENT = /Scan event captured/;
const RE_PAGES = /Job state: Completed \((\d+) page\(s\)\)/;
const RE_DONE = /Emulated duplex scan completed|Scan #(\d+) saved as PDF/;

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

function check(n) {
    const s = scans.get(n);
    if (!s || s.reported || s.front === null || s.back === null) return;
    s.reported = true;
    if (s.front === s.back) {
        log(`scan #${n}: ${s.front} fronts and ${s.back} backs, OK`);
    } else {
        log(`scan #${n}: ${s.front} fronts but ${s.back} backs — pages are missing`);
        fireEvent({ scan: n, front_pages: s.front, back_pages: s.back, addon: ADDON });
    }
    // Keep only recent scans in memory.
    for (const k of scans.keys()) if (k < n - 5) scans.delete(k);
}

function handle(line) {
    let m = line.match(RE_SIDE);
    if (m) {
        const n = Number(m[2]);
        const side = m[1];
        if (side === "front") {
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
