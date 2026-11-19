# ADR-HUB-447 — Local file links are independent of Workspace location

Status: accepted by the user, 2026-11-15.

## Context and decision

An existing file link outside the configured Workspace failed with "Файл
находится вне Workspace". The user explicitly rejected this location restriction
("почему? зачем это ограничение?", "давай не будем"). The HTTP file resolver
checked the canonical target against configured project roots, and file routes
also required a nonempty root list before resolution.

Remove both location checks and their composition input for the existing direct
download, copy, runtime reveal and trusted-device transfer-ticket actions. Keep
the existing Hub authentication and action-specific modes, realpath/file/size
validation, one-time ticket semantics and native action adapters. No replacement
allowlist, per-file permission, confirmation, new endpoint or migration is needed.
Frontend link parsing and relative-path resolution retain their current meaning.
Public external-share creation is a separate publishing action and keeps its
existing owner; this decision does not make local file APIs anonymous.

## Evidence

Behavioral HTTP coverage checks absent roots, outside/inside files, Cyrillic and
spaces, missing/malformed/non-file paths, retained authentication and one-time
trusted-device delivery. A real Edge menu drives the unmodified Hub client and
HTTP server for download, copy and runtime reveal. Native OS adapters are captured
at their existing ports, so these tests do not open Explorer or alter live files.
