FROM apache/couchdb:3.5.3
COPY --chown=couchdb:couchdb deployment/couchdb.ini /opt/couchdb/etc/local.d/20-lan-note-sync.ini
USER couchdb
