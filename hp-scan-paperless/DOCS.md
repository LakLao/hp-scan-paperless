# HP Scan to Paperless

Press **Scan → Computer → Paperless** on an HP All-in-One printer: this add-on fetches the
scan and uploads it to [Paperless-ngx](https://docs.paperless-ngx.com/), where it is read and
sorted like any other document. No HP cloud, no mailbox, no SMB share; the printer doesn't
need internet access.

## How it works

1. On start, the add-on connects to the printer's IP address and registers a scan destination
   (the *Name on the printer*, default **Paperless**). It appears under **Scan → Computer**.
2. It then asks the printer every few seconds whether that destination was chosen.
3. When you start a scan there, it fetches the pages over your home network, combines them
   into one PDF and uploads it with your API token to Paperless.

The connection always goes from Home Assistant to the printer. If the add-on is stopped, the
destination stops working; on the next start it registers again.

## Before you start

- **Fixed printer IP:** reserve the printer's address in your router (DHCP reservation).
  Test: `http://<printer-ip>/DevMgmt/DiscoveryTree.xml` must open in a browser.
- **Paperless API token:** Paperless → your user (top right) → **My Profile** →
  *API Auth Token*. Optionally use a separate user that may only add documents.

## Configuration

| Option | Example | Meaning |
|---|---|---|
| Printer IP address | `192.168.1.50` | fixed IP of the printer |
| Name on the printer | `Paperless` | shown under Scan → Computer |
| Paperless address | `https://paperless.example.com` | without `/api/...` |
| Paperless API token | | from *My Profile* |
| Resolution (dpi) | `300` | good for text recognition |
| Colour mode | `Gray` | `Color` for photos and coloured forms |
| Multi-page scan as one PDF | on | otherwise one document per page |
| Emulated two-sided scan | off | adds "<name> duplex": scan fronts, flip the stack, scan backs |
| Two-sided page order | `document-wise` | order after flipping the whole stack |
| Check two-sided page count | on | event in Home Assistant when fronts and backs differ |
| Tag for incomplete scans | `Onvolledige scan` | Paperless tag for such a scan; empty = no tag |
| Leave out blank pages | off | blank pages are removed before the upload; order stays the same |
| Debug log | off | more details in the *Log* tab |

Save, start, and switch on **Start on boot** and **Watchdog**. The *Log* tab shows
`Using device at IP: …` and `Paperless configuration provided …`.

## Two-sided page check

If a page is skipped by the feeder, the fronts and backs of a two-sided scan differ in number
and the PDF is incomplete (it is still uploaded). With *Check two-sided page count* on, the log
then shows `[duplex-check] scan #N: X fronts but Y backs` and Home Assistant receives the event
`hp_scan_duplex_mismatch`:

```yaml
scan: 110
front_pages: 3
back_pages: 28
addon: <this add-on's slug>
tag: Onvolledige scan
```

The PDF can't be held back (the scanner uploads it), but once Paperless has added it the
add-on gives it the tag from *Tag for incomplete scans* (created if it doesn't exist yet), so
you can filter on it and delete it after scanning again. The log shows
`[duplex-check] scan #N: Paperless document D tagged "…"`.

Use it as an automation trigger (*Event*, type `hp_scan_duplex_mismatch`), for example for a
phone notification with a button that restarts the add-on.

## Blank pages

With *Leave out blank pages* on, the scanner hands the finished PDF to a small filter inside the
add-on first. It looks at every page and leaves out the blank ones, then uploads the rest to
Paperless. Two-sided scans are already assembled at that point, so the other pages keep their
order.

- A page is blank when less than 0.1 % of its area has ink (*Blank page threshold*). The outer
  edges (punch holes, paper edge, feeder shadow) are ignored, and so are dust specks and light
  grey text showing through from the other side. A page with only a staple mark or a page
  number counts as blank; a signature or a single line of text does not.
- The log shows, per scan, which pages were left out and the ink percentage of every page, e.g.
  `[blank-pages] scan_….pdf: 16 page(s), left out 3 blank: 2, 6, 14`. Raise or lower the
  threshold if a page is judged wrongly.
- If every page looks blank, or the file is something the filter doesn't expect, it is uploaded
  unchanged.
- Pages are removed with an incremental PDF update: the original file stays inside, with a new
  page list appended. Every PDF reader, and Paperless, only shows the remaining pages.

## Problems

| Problem | Check |
|---|---|
| Add-on stops right after start | the log says which option is missing |
| *Paperless* doesn't appear on the printer | IP correct (test above)? Restart the add-on. On the printer's web page *Scan to Computer* must be enabled |
| Every page becomes its own document | switch on *Multi-page scan as one PDF* |
| Upload fails | Paperless address and token correct? Does the address open from your home network? |
| Old or duplicate entries on the printer | restart the printer, then the add-on |

Built on [node-hp-scan-to](https://github.com/manuc66/node-hp-scan-to); see its list of
supported devices. It is community-made and best-effort; behaviour can differ by firmware.
