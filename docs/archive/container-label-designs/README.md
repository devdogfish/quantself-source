# Container label design reference

Archived July 27, 2026.

## Selected design

**A1 - Mirrored** is the production default. It uses this order:

1. Container name
2. Full-width rounded QR code
3. Separator
4. QuantSelf/container label and reference ID

The generator identifies A1 as `editorial`.

## Comparison

- [Three-page comparison PDF](./container-label-design-comparison.pdf)
- [Side-by-side comparison image](./container-label-design-comparison.png)

Page order:

1. A1 - Mirrored (selected)
2. A2 - Title first
3. C - Full width equipment tag

## Downloadable C design

- [C - Full QR PDF](./container-label-c-full-qr.pdf)
- [C - Full QR image](./container-label-c-full-qr.png)

C - Full QR remains available beside A1 from the container page's **Label PDF**
chooser. C - Large QR and C - Tight were removed from the app and route API.

Implementation: `apps/web/lib/inventory-container-label.ts`
