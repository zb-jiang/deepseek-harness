# Agent Note: File-row action slot in the workspace file tree

Status: implemented

English | [中文](2026-09-12-file-row-action-slot.zh.md)

## Problem

The workspace file tree renders each listed row as a closed control: opening the file is the row's only gesture, and the row area offers no extension point. The enterprise knowledge-base workbench needs a per-file "upload to knowledge base" action on those rows, and any future row-level affordance faces the same gap. Meeting it by placing enterprise logic inside the tree package would couple core UI to enterprise business behavior and put an enterprise-maintained edit in a package upstream actively evolves.

## Decision

[ui-sidebar-files](../../../../packages/client/ui-sidebar-files/README.md) owns the generic additive slot `sidebar.files.entry.action`. `entry-slots.ts` declares it session-scoped with owner props `{ path, name }` — the row's absolute workspace path and basename — and the files tab body registration lists the key in its children table, so the render authorization stays with the tree package. `FilesBody` dispatches the slot after each file row's open control, on file rows only; directory rows, `other` entries, and the header dispatch none. An unoccupied row renders nothing extra, and an occupant never changes the row's own open behavior.

Occupants register from their own packages. The enterprise workbench occupies the slot (id `kb-upload`) through `ctx.slots.inject` with a bound `workspaceFiles.readAll` callback; all enterprise behavior — knowledge-base selection, multipart upload, parse-status reporting — lives in the occupant component inside the enterprise package.

The slot is deliberately generic — neutral name, minimal owner props, no enterprise vocabulary — so the core-package diff is a candidate for upstream contribution. Once upstream accepts the slot, the local edit to the tree package is retired and the enterprise occupant keeps registering against the upstreamed declaration unchanged.

## Testing

The body spec pins the dispatch contract: every file row and only file rows dispatch the slot with the row's absolute path and basename, and an unoccupied slot adds no chrome to the row.

## Alternatives considered

**Fork the whole files tab into the enterprise package.** Copying the tree's store, face, and body removes the core touch but duplicates an actively evolving component; every upstream change to the tree would need manual reapplication, a worse drift cost than a small declared seam.

**Hardcode the enterprise upload action into `FilesBody`.** The core package would import enterprise API clients and dialogs, inverting the enterprise boundary in the worse direction: the seam exists precisely so the tree stays free of enterprise concepts.

**Overlay controls onto rows from the enterprise package.** Positioning foreign elements over tree rows without a declared slot depends on the tree's internal layout, breaks silently under upstream restyling, and bypasses the slots' declaration-and-authorization model.

## Consequences

The core diff is one new file plus small insertions in the registration options and the body component. An upstream refactor of `FilesBody` can conflict textually with those hunks; each hunk re-applies mechanically, and the semantic risk is nil because the slot is behavior-neutral when unoccupied. Any package may occupy the slot; only ui-sidebar-files can redeclare or relocate the render site. Merging upstream code that reshapes the tree starts from this note: the hunks belong to the slot, and upstreaming the slot is the path that removes the local core edit entirely.
