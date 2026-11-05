#!/command/with-contenv bash
# Home Assistant add-on options (/data/options.json) -> environment of node-hp-scan-to's /app.sh.
# /app.sh starts with "with-contenv", which takes the environment from s6's container
# environment folder, so the values are written there (exported variables would be lost).
set -e
ENVDIR=/run/s6/container_environment

opt() {
    node -e 'const o = require("/data/options.json"); const v = o[process.argv[1]];
             process.stdout.write(v === undefined || v === null ? "" : String(v))' "$1"
}

export IP="$(opt printer_ip)"
export LABEL="$(opt label)"
export RESOLUTION="$(opt resolution)"
export MODE="$(opt mode)"
export PATTERN='"scan"_yyyy-mm-dd_HH-MM-ss'
url="$(opt paperless_url)"
export PAPERLESS_POST_DOCUMENT_URL="${url%/}/api/documents/post_document/"
export PAPERLESS_TOKEN="$(opt paperless_token)"

CMDLINE=""
[ "$(opt multi_page_pdf)" = "true" ] && CMDLINE="$CMDLINE --paperless-group-multi-page-scan-into-a-pdf"
[ "$(opt debug)" = "true" ] && CMDLINE="$CMDLINE -D"
export CMDLINE

for var in IP LABEL RESOLUTION MODE PATTERN PAPERLESS_POST_DOCUMENT_URL PAPERLESS_TOKEN CMDLINE; do
    printf '%s' "${!var}" > "$ENVDIR/$var"
done

# /app.sh adds --add-emulated-duplex only when ADD_EMULATED_DUPLEX exists, so the file is
# written only when the option is on (its value is the page assembly mode).
rm -f "$ENVDIR/ADD_EMULATED_DUPLEX"
if [ "$(opt emulated_duplex)" = "true" ]; then
    printf '%s' "$(opt duplex_mode)" > "$ENVDIR/ADD_EMULATED_DUPLEX"
    echo "Emulated two-sided scan on (order: $(opt duplex_mode))"
fi

if [ -z "$IP" ] || [ -z "$url" ] || [ -z "$PAPERLESS_TOKEN" ]; then
    echo "Set printer_ip, paperless_url and paperless_token in the add-on configuration, then restart the add-on."
    exit 1
fi
echo "Printer $IP, label \"$LABEL\", upload to $PAPERLESS_POST_DOCUMENT_URL"

# Blank pages: the scanner posts to blank-filter.js on 127.0.0.1, which leaves out blank pages
# of the finished PDF (order unchanged) and passes the upload on to Paperless. The exported
# PAPERLESS_POST_DOCUMENT_URL stays the real address (used by the filter and duplex-watch.js).
if [ "$(opt remove_blank_pages)" = "true" ]; then
    export BLANK_THRESHOLD="$(opt blank_threshold)"
    export BLANK_FILTER_PORT=3010
    printf '%s' "http://127.0.0.1:$BLANK_FILTER_PORT/api/documents/post_document/" > "$ENVDIR/PAPERLESS_POST_DOCUMENT_URL"
    echo "Blank pages are left out before upload (threshold ${BLANK_THRESHOLD:-0.1}% ink)"
    ( set +e; while true; do node /addon/blank-filter.js; echo "[blank-pages] filter stopped; restarting"; sleep 2; done ) &
fi

# Two-sided check: the scanner's output also goes through duplex-watch.js, which fires the
# Home Assistant event "hp_scan_duplex_mismatch" when fronts and backs differ in page count.
# /app.sh stays the main process (process substitution), so stopping the add-on still works.
if [ "$(opt emulated_duplex)" = "true" ] && [ "$(opt duplex_check)" != "false" ]; then
    export INCOMPLETE_TAG="$(opt incomplete_tag)"
    echo "Two-sided page check on (event: hp_scan_duplex_mismatch${INCOMPLETE_TAG:+, Paperless tag: $INCOMPLETE_TAG})"
    exec /app.sh > >(node /duplex-watch.js) 2>&1
fi
exec /app.sh
