# Personal Inventory Placement

All Inventory Containers belong on one shelf in the Owner's room. Use `L01`–`L08`
for the eight 45 L containers and `S01`–`S03` for the three 6 L containers.
The `BIN-` reference IDs are permanent printed identifiers; the `L` and `S`
prefixes are the current names. Do not assign new containers to the basement.
Do not create a miscellaneous container.

## Production Containers

| Reference | Name | Capacity | Put here |
|---|---|---:|---|
| BIN-0006 | L01 — HEALTH BACKSTOCK | 45 L | Unopened supplements, toiletry/cosmetic refills, bulk health supplies |
| BIN-0007 | L02 — BOOKS & ARCHIVE | 45 L | Books, manuals worth keeping, completed schoolwork, old folders and papers |
| BIN-0008 | L03 — SPORTS & OUTDOORS | 45 L | Basketball, training and camping gear, outdoor equipment other than fishing tackle |
| BIN-0009 | L04 — BEDDING | 45 L | Spare sheets, blankets, bedding and linens |
| BIN-0013 | L05 — SEASONAL CLOTHES | 45 L | Off-season clothing |
| BIN-0014 | L06 — SCHOOL & DESK | 45 L | School and desk supplies, binders, stationery, related accessories |
| BIN-0015 | L07 — FISHING GEAR | 45 L | Fishing tackle, bait and accessories |
| BIN-0016 | L08 — AVAILABLE | 45 L | Unassigned; choose a specific purpose before filling |
| BIN-0001 | S01 — ELECTRONICS | 6 L | Cables, adapters, chargers, small devices, electronic accessories |
| BIN-0003 | S02 — DAILY HEALTH | 6 L | Active supplements and daily health supplies |
| BIN-0004 | S03 — COSMETICS | 6 L | Active cosmetics and grooming accessories |

All eleven containers are recorded in the Owner's room. The 45 L containers use
the closest available 39 L visual preset in Quantself. The former 80 L bedding
and clothing container has been split across L04 and L05. The former small
School & Desk and Fishing gear records were replaced by L06 and L07.

## Placement Rules

1. Active supplements → S02; unopened health backstock → L01.
2. Books and archived papers → L02; current school and desk gear → L06.
3. Sports and outdoor equipment → L03; fishing gear → L07.
4. Spare bedding and linens → L04; off-season clothing → L05.
5. Electronics → S01; active cosmetics and grooming accessories → S03.
6. Leave L08 unassigned until it has a specific purpose.
7. If an item fits no container, use its natural home below. Do not force it
   into the nearest category.

## Natural Homes Outside Containers

- Food, beans, rice, snack bars → pantry/kitchen; cans on a sturdy shelf.
- Active clothing → cupboard.
- Active sunglasses → hard case beside keys/wallet or in daily backpack.
- Active binders → upright beside desk.
- Daily bank cards → wallet.
- Daily keys → key hook/tray.
- Backpacks → nested inside suitcases; suitcases in the Owner's room.
- Empty bottles, yogurt tubs, and ordinary cardboard → recycle.
- Reusable bags → one limited bag-of-bags.
- Useful shipping boxes → maximum two, flattened beside the suitcases.

## Duplicates

Keep the active copy near its point of use. Put a non-sensitive backup in the
appropriate container on the room shelf. Sensitive backups remain locked.

The intended software model is one Inventory Item with quantities distributed
across Inventory Placements, not duplicated item metadata. See
`docs/superpowers/specs/2026-07-27-inventory-products-and-placements-design.md`.

## Exceptions

- Follow product-label storage requirements before this guide.
- Refrigerated items go in the refrigerator.
- Food uses food-safe storage.
- Hazardous chemicals remain sealed, upright, and stored according to their
  labels.
- Heavy books/paper stay on the bottom shelf.
