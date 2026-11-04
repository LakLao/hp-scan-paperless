# Changelog

## 1.11.1-4

- New option: check the page count of two-sided scans. If fronts and backs differ, the add-on fires the Home Assistant event `hp_scan_duplex_mismatch` (data: `scan`, `front_pages`, `back_pages`, `addon`), e.g. for a phone notification with a restart button. Needs Home Assistant API access (added).

## 1.11.1-3

- New options: emulated two-sided scan (extra "duplex" entry on the printer) and its page order.

## 1.11.1-2

- Own repository; Paperless address is now a required option (no default).

## 1.11.1-1

- First version: node-hp-scan-to 1.11.1, options from the Home Assistant UI, upload to Paperless-ngx.
