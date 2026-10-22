# A2UI schema snapshot

Source: https://github.com/a2ui-project/a2ui

Pinned upstream commit: see REVISION. Files are unmodified snapshots from
`specification/v0_9_1/json/{server_to_client,common_types}.json` and
`specification/v0_9_1/catalogs/basic/catalog.json`. LICENSE is the upstream license.

The selected catalog is supplied to the validator under the relative
`catalog.json` reference used by the message schema, while retaining its actual
Basic catalog identifier. Runtime emits only Column, Text, and data binding.
