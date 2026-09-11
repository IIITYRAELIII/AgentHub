# ADR-0027 — Client identity for user quotation sources

## Status

Chosen to fix the user-reported failure to quote a client-owned message without
a provider item ID.

## Context

A durable Hub user command can be visible before its provider item identity is
available. Provider-only annotation locators reject that otherwise exact source.
The durable client identity is already the canonical owner of that user message.

## Decision

Extend locator version 1 with a user-only `clientUserMessageId` variant. Its key
uses the explicit client namespace, provider, Thread, client ID and user role.
Provider turn and item fields are empty, never fabricated. New captures prefer
this variant for client-owned users. Provider-item locators remain readable and
resolve and hash in their original namespace even after client-ID enrichment.

Client locators exclude provider turn/item hydration from canonical content
hashing. Identity, source content, rendered surface and exact bounded UTF-16
selection remain validated. Duplicate identity candidates, mixed namespaces,
malformed IDs, missing sources and stale hashes fail closed. Equal text is not
identity. No history rewrite, background recovery or secondary owner is added.

## Compatibility

Older clients reject the additive locator and retain readable annotation text;
they cannot navigate it until refreshed. Existing provider locators require no
migration. New locators keep the selected namespace across persistence and
navigation rather than reinterpreting it from subsequently enriched metadata.
