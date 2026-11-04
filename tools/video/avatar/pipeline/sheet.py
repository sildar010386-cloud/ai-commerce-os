import sys, subprocess, cv2, numpy as np
f=sys.argv[1]; ts=[float(x) for x in sys.argv[2].split(',')]; out=sys.argv[3]; w=int(sys.argv[4]) if len(sys.argv)>4 else 360
ims=[]
for t in ts:
    p=subprocess.run(['ffmpeg','-v','error','-ss',str(t),'-i',f,'-frames:v','1','-f','image2pipe','-vcodec','png','-'],capture_output=True).stdout
    im=cv2.imdecode(np.frombuffer(p,np.uint8),1)
    if im is None: im=np.zeros((1920,1080,3),np.uint8)
    im=cv2.resize(im,(w,int(w*16/9)),interpolation=cv2.INTER_AREA)
    cv2.putText(im,f'{t:.2f}',(6,22),cv2.FONT_HERSHEY_SIMPLEX,0.7,(0,255,255),2); ims.append(im)
n=int(sys.argv[5]) if len(sys.argv)>5 else 6
while len(ims)%n: ims.append(np.zeros_like(ims[0]))
cv2.imwrite(out,np.vstack([np.hstack(ims[i:i+n]) for i in range(0,len(ims),n)]),[cv2.IMWRITE_JPEG_QUALITY,88])
