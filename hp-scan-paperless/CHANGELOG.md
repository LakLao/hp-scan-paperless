# Changelog

## 1.11.1-6

- New option *Leave out blank pages*: blank pages are removed from the finished PDF before it goes to Paperless, so the order of the other pages (also of two-sided scans) stays as it is. Optional *Blank page threshold* (default 0.1 % ink). Anything unexpected is passed on unchanged. Uses the jpeg-js decoder (vendored, BSD-3-Clause / Apache-2.0).

## 1.11.1-5

- An incomplete two-sided scan (fronts and backs differ) gets a Paperless tag once Paperless has added it; option *Tag for incomplete scans*, default `Onvolledige scan` (created if missing, empty = off). The event `hp_scan_duplex_mismatch` now also carries `tag`.

## 1.11.1-4

- New option: check the page count of two-sided scans. If fronts and backs differ, the add-on fires the Home Assistant event `hp_scan_duplex_mismatch` (data: `scan`, `front_pages`, `back_pages`, `addon`), e.g. for a phone notification with a restart button. Needs Home Assistant API access (added).

## 1.11.1-3

- New options: emulated two-sided scan (extra "duplex" entry on the printer) and its page order.

## 1.11.1-2

- Own repository; Paperless address is now a required option (no default).

## 1.11.1-1

- First version: node-hp-scan-to 1.11.1, options from the Home Assistant UI, upload to Paperless-ngx.
