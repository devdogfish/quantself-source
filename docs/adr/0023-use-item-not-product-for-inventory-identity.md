# Use Item, not Product, for inventory identity

Quantself calls the shared identity and facts for a belonging an Inventory Item, while an Inventory Placement represents a quantity of that Item kept somewhere. Public UI, API, OpenAPI, and domain code use Item rather than Product because Product implies commerce and conflicts with the owner's established language; database storage names remain implementation details. This is a hard API cutover: old Product routes and types are removed rather than retained as compatibility aliases.
