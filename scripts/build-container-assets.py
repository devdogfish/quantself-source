#!/usr/bin/env python3
"""Build registered container state and shadow assets without resampling."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

STATE_NAMES = ("back", "front", "empty")
ASSET_NAMES = (*STATE_NAMES, "shadow")
REFERENCE_WIDTH = 1634
REFERENCE_SIDE_MARGIN = 64
REFERENCE_BOTTOM_MARGIN = 96


@dataclass(frozen=True)
class Preset:
    directory: str
    output_prefix: str
    target_size: tuple[int, int] | None = None


PRESETS = (
    Preset("6L-container", "6l", (1634, 962)),
    Preset("39L-container", "39l"),
    Preset("80L-container", "80l"),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Crop registered container states and shadows as PNG/WebP.",
    )
    parser.add_argument(
        "--input-dir",
        required=True,
        type=Path,
        help="Directory containing 6L-container, 39L-container, and 80L-container.",
    )
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args()


def standardized_image(path: Path, preset: Preset) -> Image.Image:
    image = Image.open(path)

    if preset.target_size == (1634, 962):
        if path.stem == "back" and image.size == (1634, 963):
            image = image.crop((0, 1, 1634, 963))
        elif path.stem in {"front", "empty", "shadow"} and image.size == (
            1635,
            962,
        ):
            image = image.crop((1, 0, 1635, 962))

    if preset.target_size is not None and image.size != preset.target_size:
        raise ValueError(
            f"{path}: expected {preset.target_size}, found {image.size}",
        )

    return image.convert("RGBA")


def union_alpha_bounds(images: list[Image.Image]) -> tuple[int, int, int, int]:
    bounds = [image.getchannel("A").getbbox() for image in images]
    if any(bound is None for bound in bounds):
        raise ValueError("Every container state must contain visible pixels")

    visible_bounds = [bound for bound in bounds if bound is not None]
    return (
        min(bound[0] for bound in visible_bounds),
        min(bound[1] for bound in visible_bounds),
        max(bound[2] for bound in visible_bounds),
        max(bound[3] for bound in visible_bounds),
    )


def crop_box(
    source_size: tuple[int, int],
    container_bounds: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    source_width, _ = source_size
    side_margin = round(
        REFERENCE_SIDE_MARGIN * source_width / REFERENCE_WIDTH,
    )
    bottom_margin = round(
        REFERENCE_BOTTOM_MARGIN * source_width / REFERENCE_WIDTH,
    )
    left, top, right, bottom = container_bounds
    return (
        left - side_margin,
        top,
        right + side_margin,
        bottom + bottom_margin,
    )


def save_asset(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination.with_suffix(".png"), optimize=True)
    image.save(
        destination.with_suffix(".webp"),
        exact=True,
        lossless=True,
        method=6,
    )


def assert_transparent_corners(image: Image.Image, name: str) -> None:
    alpha = image.getchannel("A")
    corners = (
        alpha.getpixel((0, 0)),
        alpha.getpixel((image.width - 1, 0)),
        alpha.getpixel((0, image.height - 1)),
        alpha.getpixel((image.width - 1, image.height - 1)),
    )
    if any(corners):
        raise ValueError(f"{name}: exported corners must be transparent")


def build_preset(input_dir: Path, output_dir: Path, preset: Preset) -> None:
    source_dir = input_dir / preset.directory
    images = {
        name: standardized_image(source_dir / f"{name}.png", preset)
        for name in ASSET_NAMES
    }
    sizes = {image.size for image in images.values()}
    if len(sizes) != 1:
        raise ValueError(
            f"{source_dir}: states must share dimensions; found {sorted(sizes)}",
        )

    source_size = next(iter(sizes))
    bounds = union_alpha_bounds([images[name] for name in STATE_NAMES])
    shared_crop = crop_box(source_size, bounds)
    exports = {name: image.crop(shared_crop) for name, image in images.items()}

    export_sizes = {image.size for image in exports.values()}
    if len(export_sizes) != 1:
        raise AssertionError("Shared crop produced inconsistent dimensions")

    for name, image in exports.items():
        asset_name = f"{preset.output_prefix}/{name}"
        assert_transparent_corners(image, asset_name)
        save_asset(image, output_dir / asset_name)

    shadow_bounds = exports["shadow"].getchannel("A").getbbox()
    if shadow_bounds is None:
        raise ValueError(f"{source_dir}: shadow must contain visible pixels")
    if (
        shadow_bounds[0] <= 0
        or shadow_bounds[1] <= 0
        or shadow_bounds[2] >= exports["shadow"].width
        or shadow_bounds[3] >= exports["shadow"].height
    ):
        raise ValueError(f"{source_dir}: shadow blur touches an exported edge")

    print(
        f"{preset.output_prefix}: source={source_size[0]}x{source_size[1]} "
        f"crop={shared_crop} export="
        f"{exports['back'].width}x{exports['back'].height}",
    )


def main() -> None:
    args = parse_args()
    for preset in PRESETS:
        build_preset(args.input_dir, args.output_dir, preset)


if __name__ == "__main__":
    main()
