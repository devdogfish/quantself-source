# Container Asset Cropping

## Goal

Preprocess container images so every state renders with one frontend layout rule
while preserving the original container-to-shadow registration.

## Asset Contract

Each container preset owns:

- interchangeable complete states such as `front`, `back`, and `empty`;
- one separately rendered shadow, reused by every state;
- identical pixel dimensions and crop origin across all states;
- no stretching or aspect-ratio normalization.

The frontend renders the shadow once beneath the selected state. State changes
must not add another shadow.

## Crop Contract

At the current source resolution, retain this transparent registration area
around the detected container:

- left: 64 px;
- right: 64 px;
- top: 0 px;
- bottom: 96 px.

For different source resolutions, scale those values from the source width:
approximately 4% on each side and 6% below.

Container and shadow extraction must retain their original source coordinates.
Apply one crop rectangle to every state belonging to a preset. Never auto-trim
states independently. Soft shadow pixels remain inside the bottom and side
registration area.

## Dimension Standardization

Every state in one preset must have exactly equal dimensions before extraction
and cropping. Correct one-pixel export drift by cropping the redundant outer
row or column. Never resize or stretch an image to repair drift.

Before standardization, the 6 L sources were:

- `back.png`: 1634 × 963;
- `front.png`: 1635 × 962;
- `empty.png`: 1635 × 962.
- `shadow.png`: 1635 × 962.

The standardized target is 1634 × 962.

Resolved correction:

- `back.png`: remove the top row;
- `front.png`: remove the left column;
- `empty.png`: remove the left column.
- `shadow.png`: remove the left column.

This preserves the strongest shared lid, side, and bottom-edge registration
without resampling.

## Frontend Contract

The container scene uses the exported asset's natural aspect ratio. Shadow and
selected state share the same absolute origin and rendered width. The scene
allows visible shadow overflow and does not contain preset-specific offsets.

## Validation

- all states within each preset report identical dimensions;
- switching states causes no geometric jump;
- shadow appears once;
- shadow placement matches the uncropped source;
- no shadow blur touches an exported edge;
- no image was resampled during standardization.
