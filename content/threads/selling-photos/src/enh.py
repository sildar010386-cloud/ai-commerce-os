from PIL import Image, ImageEnhance, ImageFilter
D='/home/user/ai-commerce-os/content/threads/selling-photos/'
W='/tmp/claude-0/-home-user/806654ae-ec25-5531-a118-358aebc17e29/scratchpad/w/'
cfg={'1':('T-82_s5',(0,250,1080,1130),1.1,1.2),'2':('T-96_s8',(0,390,1080,1270),1.1,1.2),'3':('T-81_s5',(0,260,1080,1140),1.12,1.18)}
for k,(n,box,br,co) in cfg.items():
    im=Image.open(D+'src/'+n+'.jpg').convert('RGB').crop(box)
    if im.size!=(1080,880): im=im.resize((1080,880),Image.LANCZOS)
    im=ImageEnhance.Contrast(im).enhance(co)
    im=ImageEnhance.Brightness(im).enhance(br)
    im=ImageEnhance.Color(im).enhance(1.25)
    im=im.filter(ImageFilter.UnsharpMask(radius=2.4,percent=150,threshold=2))
    r,g,b=im.split()
    r=r.point(lambda v:min(255,int(v*1.04))); b=b.point(lambda v:int(v*0.96))
    Image.merge('RGB',(r,g,b)).save(W+f'p{k}.jpg',quality=95)
