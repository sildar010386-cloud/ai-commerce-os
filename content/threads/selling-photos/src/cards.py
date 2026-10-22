import math, subprocess, os
F='/home/user/ai-commerce-os/tools/tiktok/fonts'
W='/tmp/claude-0/-home-user/806654ae-ec25-5531-a118-358aebc17e29/scratchpad/w/'
D='/home/user/ai-commerce-os/content/threads/selling-photos/'
BROWSER=[__import__('glob').glob('/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell')][0][0]
def star(n=14,ro=50,ri=40):
    pts=[]
    for i in range(n*2):
        r=ro if i%2==0 else ri; a=math.pi*i/n-math.pi/2
        pts.append(f"{50+r*math.cos(a):.1f}% {50+r*math.sin(a):.1f}%")
    return ",".join(pts)
ST=star()
CSS="""
@font-face{font-family:M;src:url(file://F/montserrat-cyrillic-800-normal.woff2);font-weight:800}
@font-face{font-family:M;src:url(file://F/montserrat-cyrillic-900-normal.woff2);font-weight:900}
@font-face{font-family:M;src:url(file://F/montserrat-latin-800-normal.woff2);font-weight:800;unicode-range:U+0000-00FF}
@font-face{font-family:M;src:url(file://F/montserrat-latin-900-normal.woff2);font-weight:900;unicode-range:U+0000-00FF}
*{margin:0;padding:0;box-sizing:border-box}
:root{--a:ACC;--d:#1B1B1B}
html,body{width:1080px;height:1350px;overflow:hidden}
body{font-family:M,"Noto Color Emoji",sans-serif;color:var(--d);position:relative;
 background:radial-gradient(circle at 20% 100%,rgba(255,255,255,.55) 0,rgba(255,255,255,0) 45%),var(--a)}
.deco{position:absolute;border-radius:50%;background:#fff;opacity:.35}
.photo{position:absolute;left:0;top:0;width:1080px;height:880px;background:url(file://PH) center/cover;
 border-radius:0 0 80px 80px;border-bottom:14px solid var(--d);overflow:hidden}
.fog{position:absolute;inset:0;FOG}
.panel{position:absolute;left:0;right:0;top:912px;bottom:0;padding:0 56px}
h1{font-weight:900;font-size:84px;line-height:1.02;letter-spacing:-1px;margin-bottom:22px}
.box{background:#fff;border:6px solid var(--d);border-radius:40px;padding:22px 34px;box-shadow:12px 12px 0 var(--d);
 font-weight:800;font-size:44px;line-height:1.2}
.brand{position:absolute;right:56px;bottom:16px;font-weight:800;font-size:28px;opacity:.7}
.burst{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;font-weight:900}
.burst i{position:absolute;inset:0;background:var(--d);clip-path:polygon(POLY)}
.burst b{position:absolute;inset:12px;background:BURSTBG;clip-path:polygon(POLY)}
.burst span{position:relative;line-height:.95;color:BURSTFG}
.plaque{position:absolute;background:#fff;border:7px solid var(--d);border-radius:36px;box-shadow:12px 12px 0 var(--d);
 font-weight:900;text-align:center;padding:20px 34px;line-height:1.05}
.dark{background:var(--d);color:var(--a)}
"""
def build(name,acc,photo,fog,burstbg,burstfg,body,panel):
    css=CSS.replace('F/',F+'/').replace('POLY',ST).replace('ACC',acc).replace('PH',photo).replace('FOG',fog).replace('BURSTBG',burstbg).replace('BURSTFG',burstfg)
    deco='<div class="deco" style="width:700px;height:700px;bottom:-330px;left:-250px"></div><div class="deco" style="width:420px;height:420px;bottom:-120px;right:-140px"></div>'
    html=f'<html><head><meta charset="utf-8"><style>{css}</style></head><body>{deco}<div class="photo"><div class="fog"></div>{body}</div><div class="panel">{panel}</div><div class="brand">@bikas.home</div></body></html>'
    h=W+name+'.html'; open(h,'w').write(html)
    png=W+name+'.png'
    subprocess.run([BROWSER,'--headless','--no-sandbox','--disable-gpu','--hide-scrollbars','--allow-file-access-from-files','--window-size=1080,1350','--virtual-time-budget=4000',f'--screenshot={png}','file://'+h],capture_output=True,check=True)
    subprocess.run(['ffmpeg','-v','error','-y','-i',png,'-q:v','2',D+name+'.jpg'],check=True)

# 1 yellow
build('1','#FFD60A',W+'p1.jpg','',
 '#FFD60A','#1B1B1B',
 '<div class="burst" style="right:22px;top:24px;width:300px;height:300px;font-size:80px;transform:rotate(8deg)"><i></i><b></b><span>2 в 1</span></div>'
 '<div class="plaque dark" style="right:-30px;top:350px;font-size:52px;padding:18px 60px 18px 34px;transform:rotate(5deg);border-radius:36px 0 0 36px">Нагрев<br>9 секунд</div>'
 '<div class="plaque" style="right:20px;bottom:44px;font-size:42px;transform:rotate(-3deg);padding:16px 26px">Без гладильной<br>доски</div>',
 '<h1>Находка<br>для дома</h1><div class="box">Прижал — гладит, ведёшь — отпаривает</div>')
# 2 mint
build('2','#2BE0A8',W+'p2.jpg','',
 '#FFD60A','#1B1B1B',
 '<div class="burst" style="right:20px;top:20px;width:330px;height:330px;font-size:78px;transform:rotate(8deg)"><i></i><b></b><span>10/10</span></div>'
 '<div class="plaque dark" style="left:-24px;top:60px;font-size:48px;padding:22px 44px 22px 46px;transform:rotate(-4deg);border-radius:0 36px 36px 0;text-align:left">БЕСПЛАТНАЯ<br>ДОСТАВКА<br><span style="color:#fff">по Казахстану</span></div>',
 '<h1>Гениальная<br>находка</h1><div class="box" style="font-size:42px">2 в 1: гладит и отпаривает. Складывается в маленькую коробку</div>')
# 3 blue
fog='background:radial-gradient(ellipse 20% 12% at 62% 20%,rgba(255,255,255,.9) 0,rgba(255,255,255,0) 100%),radial-gradient(ellipse 24% 14% at 78% 10%,rgba(255,255,255,.8) 0,rgba(255,255,255,0) 100%),radial-gradient(ellipse 20% 12% at 46% 14%,rgba(255,255,255,.75) 0,rgba(255,255,255,0) 100%),radial-gradient(ellipse 18% 10% at 88% 26%,rgba(255,255,255,.6) 0,rgba(255,255,255,0) 100%),radial-gradient(ellipse 18% 10% at 30% 20%,rgba(255,255,255,.55) 0,rgba(255,255,255,0) 100%);filter:blur(6px)'
build('3','#1EC8FF',W+'p3.jpg','',
 '#FFD60A','#1B1B1B',
 '<div class="burst" style="right:16px;bottom:30px;width:430px;height:430px;transform:rotate(-6deg);bottom:10px;right:6px"><i></i><b></b><span><div style="font-size:36px;margin-bottom:2px">НАГРЕВ</div><div style="font-size:140px">9</div><div style="font-size:46px">секунд</div></span></div>'
 '<div class="plaque" style="left:24px;top:30px;font-size:54px;transform:rotate(-4deg)">2 в 1</div>',
 '<h1>Греется за<br>9 секунд</h1><div class="box">Гладит и отпаривает без гладильной доски</div>')
# contact
subprocess.run(['ffmpeg','-v','error','-y','-framerate','1','-i',D+'%d.jpg','-vf','scale=480:-1,tile=3x1:padding=12:color=white','-frames:v','1','-q:v','3',D+'contact.jpg'],check=True)
