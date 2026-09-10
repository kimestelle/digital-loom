# Original interface

The `/` route preserves the interface and renderer from commit
`ae7cf659752dc83088cd1d7c5130e1ace6396885` (before the room redesign).

Only import paths were adjusted in this UI snapshot. The route has its own
root layout and the historical styles in `app/(original)/styles`. The new
room runs at `/room` under a different root layout, so navigation between
them starts a new document and tears down the previous renderer and styles.

Material packages, IndexedDB library storage, cache APIs, and extraction are
shared intentionally. The separate entry points are not a data sandbox.
Keep changes to the new interface in `lib/ui` and `app/(room)`; do not update
this snapshot as a side effect of room work.
