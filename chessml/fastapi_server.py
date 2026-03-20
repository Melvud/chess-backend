import sys
import os
from pathlib import Path
from fastapi import FastAPI, UploadFile, File
import uvicorn
import torch
import numpy as np
import cv2
import io

# Add project root to sys.path to resolve 'chessml' package
root_path = str(Path(__file__).parent.parent)
if root_path not in sys.path:
    sys.path.append(root_path)

from chessml.models.torch.jit_wrappers import JITBoardDetector, JITPieceClassifier, JITMetaPredictor
from chessml.models.utils.board_recognition_helper import BoardRecognitionHelper
from chessml.data.images.picture import Picture

app = FastAPI()

# Model paths
MODELS_DIR = Path(__file__).parent / "models"
board_model_path = str(MODELS_DIR / "board_detector.pt")
piece_model_path = str(MODELS_DIR / "piece_classifier.pt")
meta_model_path = str(MODELS_DIR / "meta_predictor.pt")

# Initialize models
device = "cuda" if torch.cuda.is_available() else "cpu"
cpu_count = os.cpu_count() or 1
torch.set_num_threads(cpu_count)
print(f"Loading models on {device} (threads: {cpu_count})...")
detector = JITBoardDetector(board_model_path, device=device)
classifier = JITPieceClassifier(piece_model_path, device=device)
predictor = JITMetaPredictor(meta_model_path, device=device)

helper = BoardRecognitionHelper(detector, classifier, predictor)

@app.get("/health")
async def health():
    return {"status": "ok", "device": device}

@app.post("/scan")
async def scan(file: UploadFile = File(...)):
    contents = await file.read()
    nparr = np.frombuffer(contents, np.uint8)
    image_cv2 = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if image_cv2 is None:
        return {"error": "failed_to_decode_image"}
        
    picture = Picture(image_cv2)
    result = helper.recognize(picture)
    
    return {
        "fen": str(result.get_fen()),
        "flipped": bool(result.flipped)
    }

if __name__ == "__main__":
    port = int(os.environ.get("PYTHON_PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
