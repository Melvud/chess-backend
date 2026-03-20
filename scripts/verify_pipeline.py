import sys
import os
from pathlib import Path

# Add the project root to sys.path to find chessml package
project_root = Path(__file__).parent.parent
sys.path.append(str(project_root))

from chessml.models.lightning.board_detector_model import BoardDetector
from chessml.models.lightning.piece_classifier_model import PieceClassifier
from chessml.models.lightning.meta_predictor_model import MetaPredictor
from chessml.models.torch.vision_model_adapter import MobileViTV2FPN, EfficientNetV2Classifier
from chessml.models.utils.board_recognition_helper import BoardRecognitionHelper
from chessml.data.images.picture import Picture

def verify():
    checkpoint_dir = project_root / "chessml" / "checkpoints"
    test_image_path = project_root / "public" / "test_board.jpg"
    
    if not test_image_path.exists():
        print(f"Error: Test image not found at {test_image_path}")
        return

    print(f"Loading models from {checkpoint_dir}...")
    try:
        # Load models
        bd_model = BoardDetector.load_from_checkpoint(
            checkpoint_dir / "bd-MobileViTV2FPN-v1.ckpt",
            base_model_class=MobileViTV2FPN
        )
        bd_model.eval()
        
        pc_model = PieceClassifier.load_from_checkpoint(
            checkpoint_dir / "pc-EfficientNetV2Classifier-v1.ckpt",
            base_model_class=EfficientNetV2Classifier
        )
        pc_model.eval()
        
        mp_model = MetaPredictor.load_from_checkpoint(
            checkpoint_dir / "mp-MetaPredictor-v1.ckpt"
        )
        mp_model.eval()
        
        helper = BoardRecognitionHelper(bd_model, pc_model, mp_model)
        
        print(f"Processing image {test_image_path}...")
        picture = Picture(str(test_image_path))
        result = helper.recognize(picture)
        
        print("\nRecognition Result:")
        print(f"FEN: {result.get_fen()}")
        print(f"Flipped: {result.flipped}")
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\nVerification failed: {e}")

if __name__ == "__main__":
    verify()
