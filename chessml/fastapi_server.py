from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import torch
import numpy as np
import cv2
from PIL import Image
import io
import asyncio
import time
from pathlib import Path
from typing import Optional

import sys
import os
from pathlib import Path

# Add project root to sys.path to resolve 'chessml' package
root_path = str(Path(__file__).parent.parent)
if root_path not in sys.path:
    sys.path.append(root_path)

from chessml.models.torch.jit_wrappers import JITBoardDetector, JITPieceClassifier, JITMetaPredictor
from chessml.models.utils.board_recognition_helper import BoardRecognitionHelper
from chessml.data.images.picture import Picture

app = FastAPI(title="ChessML Recognition Service (TorchScript)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for models and lifecycle
helper: Optional[BoardRecognitionHelper] = None
last_used_time: float = 0
IDLE_TIMEOUT = 300  # 5 minutes
load_lock = asyncio.Lock()
process_lock = asyncio.Lock()  # For queueing multiple requests

async def get_helper():
    global helper, last_used_time
    
    async with load_lock:
        if helper is None:
            models_dir = Path(__file__).parent / "models"
            print(f"Lazy loading TorchScript models from {models_dir}...")
            
            try:
                # 1. Board Detector
                bd_model = JITBoardDetector(str(models_dir / "board_detector.pt"))
                
                # 2. Piece Classifier
                pc_model = JITPieceClassifier(str(models_dir / "piece_classifier.pt"))
                
                # 3. Meta Predictor
                mp_model = JITMetaPredictor(str(models_dir / "meta_predictor.pt"))
                
                helper = BoardRecognitionHelper(bd_model, pc_model, mp_model)
                print("TorchScript models loaded successfully.")
            except Exception as e:
                print(f"Error loading models: {e}")
                import traceback
                traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"Failed to load models: {str(e)}")
        
        last_used_time = time.time()
        return helper

async def cleanup_idle_models():
    global helper
    while True:
        await asyncio.sleep(60)  # Check every minute
        if helper is not None and (time.time() - last_used_time) > IDLE_TIMEOUT:
            async with load_lock:
                if helper is not None and (time.time() - last_used_time) > IDLE_TIMEOUT:
                    print("Idle timeout reached. Unloading models to save resources...")
                    helper = None
                    import gc
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_idle_models())

@app.post("/scan")
async def scan_image(file: UploadFile = File(...)):
    async with process_lock:
        recognition_helper = await get_helper()
        
        try:
            contents = await file.read()
            nparr = np.frombuffer(contents, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if img is None:
                raise HTTPException(status_code=400, detail="Invalid image file")
            
            picture = Picture(img)
            
            # Perform recognition
            result = recognition_helper.recognize(picture)
            
            # Update last used time again after processing
            global last_used_time
            last_used_time = time.time()
            
            return {
                "fen": result.get_fen(),
                "flipped": result.flipped,
                "status": "success"
            }
        except Exception as e:
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "recognition"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
