import glob, json, os, mediapipe as mp, numpy as np
from mediapipe.tasks.python import vision, BaseOptions
det = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(base_options=BaseOptions(model_asset_path='/tmp/fm/face_landmarker.task'), num_faces=1))
out={}
for f in sorted(glob.glob('/home/user/bikas-music/avatar/poses/*.png')):
    img = mp.Image.create_from_file(f); r = det.detect(img)
    if not r.face_landmarks: print('NOFACE', f); continue
    W,H=img.width,img.height
    out[os.path.basename(f)[:3] if '05b2' not in f else '05d']=[[p.x*W,p.y*H] for p in r.face_landmarks[0]]
    p=np.array(out[list(out)[-1]]); print(os.path.basename(f)[:4], 'top',p[10].round(0),'chin',p[152].round(0),'nose',p[1].round(0),'eyeL',p[33].round(0))
json.dump(out,open('lm_all.json','w'))
