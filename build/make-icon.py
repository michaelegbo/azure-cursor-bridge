from pathlib import Path

from PIL import Image


root = Path(__file__).resolve().parents[1]
source = Image.open(root / "build" / "icon-source.png").convert("RGBA")

# Keep the original transparent artwork centered in a square and generate a
# crisp PNG for Electron plus the complete Windows icon-size set.
icon = source.resize((512, 512), Image.Resampling.LANCZOS)
icon.save(root / "electron" / "icon.png", optimize=True)
icon.save(
    root / "build" / "icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
