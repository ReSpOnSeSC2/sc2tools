"""Aspect-preserving tray/window icons. Pillow is imported on demand."""
from . import palette

# The palette colour for each HealthSnapshot.tray level.
_TRAY_DOTS = {"green": palette.GREEN, "amber": palette.AMBER, "red": palette.RED, "grey": palette.GREY}


def _square_pad(image):
    from PIL import Image
    image = image.convert("RGBA")
    size = max(image.size)
    result = Image.new("RGBA", (size, size))
    result.alpha_composite(image, ((size - image.width) // 2, (size - image.height) // 2))
    return result


def dot_color(tray_level):
    """The dot for a snapshot's tray level; ``None`` while starting, so no dot."""
    return _TRAY_DOTS.get(tray_level)


def render_tray_image(base, dot):
    from PIL import Image, ImageDraw
    image = _square_pad(base).resize((64, 64), Image.Resampling.LANCZOS)
    if dot:
        draw = ImageDraw.Draw(image)
        draw.ellipse((37, 37, 63, 63), fill=palette.RING)
        draw.ellipse((40, 40, 60, 60), fill=dot)
    return image
