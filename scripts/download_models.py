import os
import gdown
from pathlib import Path

def download_models():
    checkpoint_dir = Path("chessml/checkpoints")
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    models = {
        "10T7DVnGI6Qh5QEZdBjU09SpYSPgXTiMV": "bd-MobileViTV2FPN-v1.ckpt",
        "1zteWazd3e1RErtjjSrWsvzm_9_LxXrIo": "pc-EfficientNetV2Classifier-v1.ckpt",
        "1ovmG0ZRKD29SG25iARTNWbxOCZdMAv5m": "mp-MetaPredictor-v1.ckpt"
    }

    print("--- Starting model downloads ---")
    
    for file_id, filename in models.items():
        output_path = checkpoint_dir / filename
        print(f"\nDownloading {filename}...")
        # gdown handles existing files by default, but we can be explicit if needed
        gdown.download(id=file_id, output=str(output_path), quiet=False, fuzzy=True)

    print("\n--- All models downloaded successfully ---")
    for f in checkpoint_dir.glob("*.ckpt"):
        size_mb = f.stat().st_size / (1024 * 1024)
        print(f"{f.name}: {size_mb:.2f} MB")

if __name__ == "__main__":
    download_models()
