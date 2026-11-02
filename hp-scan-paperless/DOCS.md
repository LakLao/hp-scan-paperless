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
| Debug log | off | more details in the *Log* tab |

Save, start, and switch on **Start on boot** and **Watchdog**. The *Log* tab shows
`Using device at IP: …` and `Paperless configuration provided …`.

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
