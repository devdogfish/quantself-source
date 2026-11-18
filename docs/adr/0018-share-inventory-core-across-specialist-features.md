# Share the Inventory Core Across Specialist Features

Clothing, homeopathy, supplements, and food share Inventory Products, Placements, capture, media, and search, so they remain in one Quantself inventory instead of separate applications or data stores. Each appears as a distinct frontend feature area filtered by the Product's single Inventory Category; no separate collection membership is stored. Category remains optional for generic capture but is required and automatically assigned for a specialist profile.

The Web Client exposes dedicated `/inventory/clothing`, `/inventory/remedies`, `/inventory/supplements`, and `/inventory/food` areas while reusing shared cards and product detail. Supplements and Food are thin product-first search views with direct-location placement and no specialist profiles. Clothing adds its decision page and Clothing Profile. Homeopathy adds its intake dashboard, minimal intake form, owned-library view, and Remedy Profile.
