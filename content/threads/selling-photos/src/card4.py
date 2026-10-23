"""T-112 card 4: AI scene (man in a wrinkled shirt) as big background + our real steamer in a round frame.
  python3 card4.py [ai_cover.jpg] [out_dir_for_tmp]   -> content/threads/T-112/4.jpg + selling-photos/4.jpg
"""
import os, subprocess, sys, shutil, glob, math
R='/home/user/ai-commerce-os/'
F=R+'tools/tiktok/fonts'
BG=sys.argv[1] if len(sys.argv)>1 else R+'content/carousels/K-04/src/ai_cover.jpg'
TMP=sys.argv[2] if len(sys.argv)>2 else '/tmp/claude-0/-home-user/806654ae-ec25-5531-a118-358aebc17e29/scratchpad/'
OUTS=[R+'content/threads/T-112/4.jpg',R+'content/threads/selling-photos/4.jpg'] if len(sys.argv)<=2 else [TMP+'4.jpg']
PROD=R+'content/carousels/K-02/src/p1.jpg'
BROWSER=glob.glob('/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell')[0]
css=f"""
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-800-normal.woff2);font-weight:800}}
@font-face{{font-family:M;src:url(file://{F}/montserrat-cyrillic-900-normal.woff2);font-weight:900}}
*{{margin:0;padding:0;box-sizing:border-box}}
:root{{--a:#FFD60A;--d:#1B1B1B}}
html,body{{width:1080px;height:1350px;overflow:hidden}}
body{{font-family:M,sans-serif;color:var(--d);position:relative;background:var(--a)}}
.photo{{position:absolute;left:0;top:0;width:1080px;height:880px;background:url(file://{BG}) center/cover;border-radius:0 0 80px 80px;border-bottom:14px solid var(--d);overflow:hidden}}
.round{{position:absolute;left:36px;bottom:36px;width:430px;height:430px;border-radius:50%;border:14px solid var(--d);box-shadow:12px 12px 0 var(--d);background:url(file://{PROD}) 32% 88%/150% auto;}}
.plaque{{position:absolute;background:#fff;border:7px solid var(--d);border-radius:36px;box-shadow:12px 12px 0 var(--d);font-weight:900;text-align:center;padding:18px 30px;line-height:1.05}}
.dark{{background:var(--d);color:var(--a)}}
.panel{{position:absolute;left:0;right:0;top:912px;bottom:0;padding:0 56px}}
h1{{font-weight:900;font-size:84px;line-height:1.02;letter-spacing:-1px;margin-bottom:22px}}
.box{{background:#fff;border:6px solid var(--d);border-radius:40px;padding:22px 34px;box-shadow:12px 12px 0 var(--d);font-weight:800;font-size:44px;line-height:1.2}}
.brand{{position:absolute;right:56px;bottom:16px;font-weight:800;font-size:28px;opacity:.7}}
"""
body='''<div class="photo"><div class="round"></div>
<div class="plaque dark" style="right:-30px;top:60px;font-size:52px;padding:18px 60px 18px 34px;transform:rotate(5deg);border-radius:36px 0 0 36px">Нагрев<br>9 секунд</div>
<div class="plaque" style="right:20px;bottom:44px;font-size:46px;transform:rotate(-3deg)">Без гладильной<br>доски</div></div>
<div class="panel"><h1>Рубашка ровная<br>за минуту</h1><div class="box">Гладит прямо на вешалке, доска не нужна</div></div><div class="brand">@bikas.home</div>'''
h=TMP+'c4.html'
open(h,'w').write(f'<html><head><meta charset="utf-8"><style>{css}</style></head><body>{body}</body></html>')
png=TMP+'c4.png'
subprocess.run([BROWSER,'--headless','--no-sandbox','--disable-gpu','--hide-scrollbars','--allow-file-access-from-files','--window-size=1080,1350','--virtual-time-budget=4000',f'--screenshot={png}','file://'+h],capture_output=True,check=True)
for o in OUTS: subprocess.run(['ffmpeg','-v','error','-y','-i',png,'-q:v','2',o],check=True)
