"""Aspect-preserving tray/window icons. Pillow is imported on demand."""
from . import palette
from ..status_model import AgentStatus


def _square_pad(image):
    from PIL import Image
    image = image.convert("RGBA")
    size = max(image.size)
    result = Image.new("RGBA", (size, size))
    result.alpha_composite(image, ((size - image.width) // 2, (size - image.height) // 2))
    return result


def dot_color(view):
    if view.status == AgentStatus.WATCHING:
        return palette.BLUE if view.update_pending else palette.GREEN
    return {AgentStatus.SYNCING: palette.CYAN, AgentStatus.ERROR: palette.RED,
            AgentStatus.PAUSED: palette.AMBER, AgentStatus.NEEDS_PAIRING: palette.AMBER,
            AgentStatus.UNLINKED: palette.AMBER, AgentStatus.NEEDS_ATTENTION: palette.AMBER}.get(view.status)


def render_tray_image(base, dot):
    from PIL import Image, ImageDraw
    image = _square_pad(base).resize((64, 64), Image.Resampling.LANCZOS)
    if dot:
        draw = ImageDraw.Draw(image)
        draw.ellipse((37, 37, 63, 63), fill=palette.RING)
        draw.ellipse((40, 40, 60, 60), fill=dot)
    return image
