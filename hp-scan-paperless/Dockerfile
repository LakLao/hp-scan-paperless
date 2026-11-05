# Built on the Home Assistant host when the add-on is installed.
FROM docker.io/manuc66/node-hp-scan-to:1.11.1

COPY run.sh /addon-run.sh
COPY duplex-watch.js /duplex-watch.js
COPY blank-filter.js /addon/blank-filter.js
COPY vendor/ /addon/vendor/
RUN chmod 755 /addon-run.sh

# /init (s6) of the base image stays the entrypoint; it starts this script, which
# turns the add-on options into the environment the image's /app.sh expects.
CMD ["/addon-run.sh"]
