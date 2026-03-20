import torch
import torch.nn.functional as F
import numpy as np
import cv2
from PIL import Image, ImageDraw
from torchvision import transforms
from typing import List, Tuple, Any

from chessml.data.images.picture import Picture
from chessml.data.assets import BOARD_SIZE, PIECE_CLASSES

class JITBoardDetector:
    def __init__(self, model_path: str, device: str = "cpu"):
        self.device = device
        self.model = torch.jit.load(model_path, map_location=device)
        self.model.eval()
        # MobileViT V2 - MUST BE 256x256 and NO NORMALIZATION based on tests
        self.transform = transforms.Compose([
            transforms.Resize((256, 256)),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
        ])

    def predict_coords(self, img: Picture) -> np.ndarray:
        tensor_image = self.transform(img.pil).unsqueeze(0).to(self.device)
        with torch.no_grad():
            output = self.model(tensor_image)
            # Apply the mapping used in original BoardDetector
            raw = output.squeeze().cpu().numpy()
            mapped = 2 * (1 / (1 + np.exp(-raw))) - 0.5
            return mapped

    def extract_board_image(self, original_image: Picture) -> Picture:
        coords = self.predict_coords(original_image)
        w, h = original_image.pil.size
        # Coords are [tl_x, tl_y, tr_x, tr_y, br_x, br_y, bl_x, bl_y]
        pts1 = np.float32([
            [coords[0] * w, coords[1] * h],
            [coords[2] * w, coords[3] * h],
            [coords[4] * w, coords[5] * h],
            [coords[6] * w, coords[7] * h],
        ])

        width_a = np.sqrt(((coords[4] - coords[6]) ** 2 + (coords[5] - coords[7]) ** 2)) * w
        width_b = np.sqrt(((coords[2] - coords[0]) ** 2 + (coords[3] - coords[1]) ** 2)) * w
        maxWidth = max(int(width_a), int(width_b))

        height_a = np.sqrt(((coords[2] - coords[4]) ** 2 + (coords[3] - coords[5]) ** 2)) * h
        height_b = np.sqrt(((coords[0] - coords[6]) ** 2 + (coords[1] - coords[7]) ** 2)) * h
        maxHeight = max(int(height_a), int(height_b))

        pts2 = np.float32([
            [0, 0],
            [maxWidth - 1, 0],
            [maxWidth - 1, maxHeight - 1],
            [0, maxHeight - 1],
        ])

        matrix = cv2.getPerspectiveTransform(pts1, pts2)
        extracted_image = cv2.warpPerspective(original_image.cv2, matrix, (maxWidth, maxHeight))
        return Picture(extracted_image)

class JITPieceClassifier:
    def __init__(self, model_path: str, device: str = "cpu"):
        self.device = device
        self.model = torch.jit.load(model_path, map_location=device)
        self.model.eval()
        # Piece classifier - usually 224x224 or 256x256. 
        # We'll try NO NORMALIZATION here too as it's common for these JIT exports.
        self.transform = transforms.Compose([
            transforms.Resize((224, 224)),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
        ])

    def classify_pieces(self, images: List[Picture]) -> List[int]:
        tensors = []
        for img in images:
            tensors.append(self.transform(img.pil))
        
        batch = torch.stack(tensors).to(self.device)
        with torch.no_grad():
            outputs = self.model(batch)
            predicted = torch.argmax(outputs, 1)
            return predicted.cpu().numpy().tolist()

class JITMetaPredictor:
    def __init__(self, model_path: str, device: str = "cpu"):
        self.device = device
        self.model = torch.jit.load(model_path, map_location=device)
        self.model.eval()

    def predict(self, board_rep: np.ndarray) -> Tuple[bool, bool, bool, bool, bool, bool]:
        # board_rep is (13, 8, 8)
        tensor = torch.from_numpy(board_rep).float().unsqueeze(0).to(self.device)
        with torch.no_grad():
            output = self.model(tensor)
            # Assuming sigmoid output
            res = (torch.sigmoid(output) > 0.5).squeeze().cpu().numpy()
            return tuple(res)
