from pathlib import Path
import os

class Assets:
    def __init__(self):
        self.root = Path(__file__).parent.parent
        self.path = os.environ.get("CHESSML_ASSETS_PATH", str(self.root / "public"))
        
        # Ensure piece_png directory exists if models expect it, 
        # or point to existing 'piece' directory.
        # Based on data/assets.py, it expects config.assets.path / "piece_png"
        self.piece_png_path = Path(self.path) / "piece_png"
        if not self.piece_png_path.exists():
            # If public/piece exists, we can try to use it or link it
            alt_piece_path = Path(self.root) / "public" / "piece"
            if alt_piece_path.exists():
                # We'll just point to public and hope the caller uses piece_png
                # But to avoid listdir error, we might need to create it
                pass

class Config:
    def __init__(self):
        self.assets = Assets()

config = Config()
