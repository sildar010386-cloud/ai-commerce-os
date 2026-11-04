import json, glob, cv2, numpy as np
D='/home/user/bikas-music/avatar/poses/'
LM={k:np.array(v,np.float32) for k,v in json.load(open('lm_all.json')).items()}
files={}
for f in glob.glob(D+'*.png'):
    n=f.split('/')[-1]
    k='05d' if n.startswith('05b2') else n[:3]
    files[k]=f
I={k:cv2.imread(f) for k,f in files.items()}
H,W=1920,1080
idx=[33,133,263,362,1,4,6,168,234,454,152,10]
MOUTH=[61,291,0,17,37,267,84,314,40,270,91,321,146,375,152,148,377,176,400,164,18,200,421,57,287,43,273]
CHIN=[152,148,377,176,400,199,175,396]
EYE_R=[33,133,159,145,160,144,158,153,246,161,163,7]; EYE_L=[263,362,386,374,387,373,385,380,466,388,390,249]
def align(src,dst):
    M,_=cv2.estimateAffinePartial2D(LM[src][idx],LM[dst][idx],method=cv2.LMEDS)
    img=cv2.warpAffine(I[src],M,(W,H),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_REPLICATE)
    return img,cv2.transform(LM[src][None],M)[0]
def hullmask(pts,pad,blur):
    m=np.zeros((H,W),np.uint8); cv2.fillPoly(m,[cv2.convexHull(pts.astype(np.int32))],255)
    if pad: m=cv2.dilate(m,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(pad,pad)))
    return cv2.GaussianBlur(m,(blur|1,blur|1),0).astype(np.float32)[...,None]/255
def mouth_from(base_key,src_key,chin):
    base=I[base_key].astype(np.float32)
    a,pa=align(src_key,base_key)
    ids=MOUTH+(CHIN if chin else [])
    m=hullmask(np.vstack([LM[base_key][ids],pa[ids]]),25,31)
    return base*(1-m)+a.astype(np.float32)*m
def eyes_from(base_img,base_key,src_key):
    a,pa=align(src_key,base_key)
    m=np.maximum(hullmask(np.vstack([LM[base_key][EYE_R],pa[EYE_R]]),17,17),hullmask(np.vstack([LM[base_key][EYE_L],pa[EYE_L]]),17,17))
    return base_img*(1-m)+a.astype(np.float32)*m
poses={'01':('01a','01b'),'02':('02a','02b'),'03':('03a','03b'),'04':('04a','04b'),'05':('05a','05b'),'06':('06a','06b'),'07':('07a','07b'),'08':('08a','08b'),'09':('09a','09b')}
for p,(ka,kb) in poses.items():
    # keys in I/LM are 3-char: '01a'
    out={}
    out['closed']=I[ka].astype(np.float32)
    out['open']=mouth_from(ka,kb,True)
    out['half']=mouth_from(ka,'01v',False) if p!='01' else mouth_from(ka,'01v',False)
    out['blink']=eyes_from(out['closed'],ka,'01g')
    for s,im in out.items(): cv2.imwrite(f'poses/{p}_{s}.png',np.clip(im,0,255).astype(np.uint8))
# check sheet: face crops
rows=[]
for p in poses:
    row=[]
    for s in ('closed','half','open','blink'):
        im=cv2.imread(f'poses/{p}_{s}.png')[180:700,230:850]; row.append(cv2.resize(im,(310,260)))
    rows.append(np.hstack(row))
cv2.imwrite('poses_check.jpg',np.vstack(rows[:5]),[cv2.IMWRITE_JPEG_QUALITY,88]); cv2.imwrite('poses_check2.jpg',np.vstack(rows[5:]),[cv2.IMWRITE_JPEG_QUALITY,88])
