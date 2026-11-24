# ADR-HUB-536 — Read chat history through ordered turn references

The chat shows up to 30 recent turns when opened. Scrolling and saved-position
page reads use the same ordering. An explicit turn link uses the existing
provider, Thread and turn identity lookup. The journal indexes completions and
search indexes message text. Those queries retain their own ordering.

SQLite stores a reference to each visible turn, its time and visible message
count. Per-Thread summaries supply page bounds and counts. Disjoint time
ranges allow a page to seek into its Thread and use earlier Threads only
when needed. Overlapping dates and undated legacy rows use the existing
chronology over compact references. The selected references join the canonical
turn rows before their messages are hydrated.

The history writer maintains references and totals within the transaction that
changes a turn. An older writer invalidates affected totals. Reads of a
partially migrated Stream use canonical SQL until the background migration
has rebuilt its missing Threads. Migration resumes from committed Thread
summaries after restart. The tables contain no message text or attachments.
