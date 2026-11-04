import sys, json, mediapipe as mp, numpy as np
from mediapipe.tasks.python import vision, BaseOptions
img = mp.Image.create_from_file(sys.argv[1])
det = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=sys.argv[2]), num_faces=1))
r = det.detect(img)
W, H = img.width, img.height
pts = [[round(p.x*W, 1), round(p.y*H, 1)] for p in r.face_landmarks[0]]
json.dump(pts, open(sys.argv[3], "w")); print(len(pts))
