# Reconcile commands before Ready and repair projections in the background

A restarted Hub must settle outstanding message commands using the durable
terminal revision before accepting new inputs. History repair, journal
projection and usage calculation may wait on other work in their owners.

The terminal owner migrates missing legacy terminals that own a message command
and reads only indexed current command intents before Ready. After Ready, the
existing outbox restores abandoned claims and repairs history, journal and
usage. A verified terminal timestamp takes precedence over a lagging journal
date. An exact readback still precedes each ACK.

Telegram recovery uses the existing delivery identity. Both background stages
record separate health outcomes and join runtime teardown.
