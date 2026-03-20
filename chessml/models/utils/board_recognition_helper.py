import numpy as np
from chessml.data.assets import PIECE_CLASSES, BOARD_SIZE, INVERTED_PIECE_CLASSES
import cv2
from typing import Iterator, Optional, Any, List, Tuple
from chessml.data.images.picture import Picture, autocorrect_brightness_contrast
from chessml.data.boards.board_representation import OnlyPieces
from chess import Board
from pathlib import Path


class RecognitionResult:
    def __init__(self, board_image: Picture):
        self.board_image = board_image
        self.board = Board()
        self.flipped = False

    def iterate_squares(
        self, square_size: int
    ) -> Iterator[tuple[Picture, int, int]]:

        resized_image = cv2.resize(
            self.board_image.cv2,
            (BOARD_SIZE * square_size, BOARD_SIZE * square_size),
            interpolation=cv2.INTER_CUBIC,
        )

        for row in range(BOARD_SIZE):
            y_start = row * square_size
            y_end = y_start + square_size
            rank_index = BOARD_SIZE - 1 - row
            for col in range(BOARD_SIZE):
                x_start = col * square_size
                x_end = x_start + square_size
                file_index = col

                yield Picture(
                    resized_image[y_start:y_end, x_start:x_end]
                ), rank_index, file_index

    def get_fen(self) -> str:
        return self.board.fen()


class BoardRecognitionHelper:
    def __init__(
        self,
        board_detector: Any,
        piece_classifier: Any,
        meta_predictor: Any,
    ):
        self.board_detector = board_detector
        self.piece_classifier = piece_classifier
        self.meta_predictor = meta_predictor

    def recognize(self, original_image: Picture) -> RecognitionResult:
        result = RecognitionResult(
            board_image=self.board_detector.extract_board_image(original_image)
        )

        squares, ranks, files = zip(*result.iterate_squares(square_size=128))

        # --- PASS 1: Brightness Corrected Recognition (Now Primary) ---
        corrected_squares = [Picture(autocorrect_brightness_contrast(s.cv2)).bw for s in squares]
        class_indexes, scores = self.piece_classifier.classify_pieces(corrected_squares)
        
        # Validate king counts
        if not self._is_king_count_valid(class_indexes):
            print("Invalid king count in Pass 1 (Corrected), retrying with Original images...")
            # --- PASS 2: Try with original images (Fallback) ---
            idx2, sc2 = self.piece_classifier.classify_pieces([s.bw for s in squares])
            
            if self._is_king_count_valid(idx2):
                class_indexes, scores = idx2, sc2
            else:
                # If both are invalid, we'll try to heal the best one (Pass 1) using scores
                print("Both passes failed validation, using confidence heuristics on Pass 1 (Corrected)...")
                class_indexes = self._heal_king_counts(class_indexes, scores)

        classified_squares = [[None] * BOARD_SIZE for _ in range(BOARD_SIZE)]
        for class_index, rank, file in zip(class_indexes, ranks, files):
            classified_squares[rank][file] = class_index

        fen_rows = []
        for row in reversed(classified_squares):
            fen_row = []
            empty_count = 0
            for class_index in row:
                if class_index == PIECE_CLASSES[None]:
                    empty_count += 1
                else:
                    if empty_count > 0:
                        fen_row.append(str(empty_count))
                        empty_count = 0
                    piece = INVERTED_PIECE_CLASSES[class_index]
                    fen_row.append(piece)
            if empty_count > 0:
                fen_row.append(str(empty_count))
            fen_rows.append("".join(fen_row))

        fen_position = "/".join(fen_rows)
        result.board.set_fen(f"{fen_position} w - - 0 1")

        (
            white_kingside_castling,
            white_queenside_castling,
            black_kingside_castling,
            black_queenside_castling,
            white_turn,
            flipped,
        ) = self.meta_predictor.predict(OnlyPieces()(result.board))

        castling = (
            "".join(
                [
                    "K" if white_kingside_castling else "",
                    "Q" if white_queenside_castling else "",
                    "k" if black_kingside_castling else "",
                    "q" if black_queenside_castling else "",
                ]
            )
            or "-"
        )

        result.board.set_fen(
            f"{fen_position} {'w' if white_turn else 'b'} {castling} - 0 1"
        )
        result.flipped = bool(flipped)

        return result

    def _is_king_count_valid(self, class_indexes: List[int]) -> bool:
        white_kings = class_indexes.count(PIECE_CLASSES['K'])
        black_kings = class_indexes.count(PIECE_CLASSES['k'])
        return white_kings == 1 and black_kings == 1

    def _heal_king_counts(self, class_indexes: List[int], scores: List[float]) -> List[int]:
        # Heuristic: Find all king candidates and pick the one with highest score for each color
        # All other kings are turned into Empty or their next best class (but we only have max class here)
        # So we turn them into Empty.
        
        new_indexes = list(class_indexes)
        
        for king_class in [PIECE_CLASSES['K'], PIECE_CLASSES['k']]:
            king_indices = [i for i, idx in enumerate(class_indexes) if idx == king_class]
            
            if len(king_indices) > 1:
                # Keep only the one with the highest score
                best_idx = max(king_indices, key=lambda i: scores[i])
                for i in king_indices:
                    if i != best_idx:
                        new_indexes[i] = PIECE_CLASSES[None]
            elif len(king_indices) == 0:
                # If no king, we could search for any square that might have been a king
                # but with argmax weights we can't easily do that without re-running classification
                # for now we leave 0 kings (it's better than 2)
                pass
                
        return new_indexes
