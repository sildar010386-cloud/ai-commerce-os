"""Motion-graphic layers for HyperFrames reels (owner test 2026-10-15: use HyperFrames fully, not only captions).

A spec may carry "fx": [{"type": ..., "t": start_s, "dur": seconds, ...}, ...]. captions.py calls render(fx, total)
and appends the returned HTML, CSS and GSAP lines to the composition. The middle band (y 470-1150) is free:
plates sit at the top, captions at the bottom. Animation rules follow the HyperFrames skills
(counting-dynamic-scale, stat-bars-and-fills, kinetic-beat-slam, particle-burst, svg-path-draw).

Types:
  zoom      punch-in on the background video           {scale}
  flash     white flash on a cut                       {}
  slam      big word slams in with a shake             {text, color}
  timer     ring fills while a number counts up        {value, label, color}
  thermo    two gauges fill and count up               {items: [{label, value, unit, color, icon}], max}
  compare   two bars grow, ✗ / ✓ badges                {rows: [{label, value, text, color, mark}], max}
  checklist items tick in at their own times           {items: [[text, t_abs], ...]}
  steam     soft particles rise from a point           {x, y, n}
  cta       comment bubble types «ПАР» and pulses      {text}
Compact "band" widgets (owner 2026-10-15: animation must not cover the footage — small, semi-transparent,
top band y 265-515 only; captions go to the bottom):
  b_count   icon + number counts from→to + label        {icon, frm, to, unit, label, color}
  b_bar     label + bar fills + ✗/✓                     {label, text, color, mark}
  b_ring    small ring counts 0→value + text            {value, text, color}
  b_crease  wavy line straightens (creases → smooth)    {before, after, at, until}
  b_compare two mini bars                               {rows: [{label, value, text, color, mark}]}
  b_bubble  «ПАР» typed in a comment bubble, pulses     {text, hint}
Camera work on the live footage (test 3, 2026-10-15):
  whip      blur + sideways shift across a cut          {}            (t = cut time)
  punch     small punch-in right after a cut            {scale}
  zoomto    slow zoom into a point of the footage       {x, y, scale}
  callout   ellipse drawn around a point + label         {x, y, rx, ry, label}
  beforeafter  full-frame stills ДО / ПОСЛЕ, wipe       {before, after}  (image files, copied by captions.py)
Slam accepts {top} to move it out of the middle.
"""
import html, random

CSS = """.fx{position:absolute;pointer-events:none}
.panel{left:70px;right:70px;top:470px;height:660px;background:rgba(255,255,255,.93);border-radius:44px;
 box-shadow:0 18px 50px rgba(0,0,0,.35);opacity:0;font-family:"Liberation Sans","DejaVu Sans",sans-serif;color:#151515}
.flash{inset:0;background:#fff;opacity:0}
.slam{left:0;right:0;top:640px;text-align:center;font-weight:900;font-size:170px;line-height:1;opacity:0;
 text-shadow:0 8px 0 #000,0 0 30px rgba(0,0,0,.6),4px 0 0 #000,-4px 0 0 #000}
.num{font-weight:900;font-variant-numeric:tabular-nums;display:inline-block}
.lbl{font-weight:800;font-size:56px;text-align:center}
.bar{position:absolute;height:96px;border-radius:48px;transform-origin:left center}
.badge{position:absolute;font-size:84px;font-weight:900;opacity:0}
.chk{position:absolute;left:60px;right:60px;height:110px;display:flex;align-items:center;font-weight:800;font-size:64px;opacity:0}
.chk b{flex:none;width:92px;height:92px;border-radius:50%;background:#3DDC84;color:#fff;display:flex;align-items:center;
 justify-content:center;margin-right:30px;font-size:60px;transform:scale(0)}
.dot{position:absolute;width:70px;height:70px;border-radius:50%;background:rgba(255,255,255,.85);filter:blur(10px);opacity:0}
.bubble{left:140px;right:140px;top:960px;height:170px;background:#fff;border-radius:85px;display:flex;align-items:center;
 justify-content:center;font-weight:900;font-size:96px;color:#FF7A1A;opacity:0;box-shadow:0 14px 40px rgba(0,0,0,.4)}
.bubble i{font-style:normal;display:inline-block;opacity:0}
.band{left:60px;right:60px;top:265px;height:250px;background:rgba(255,255,255,.62);border-radius:34px;
 backdrop-filter:blur(8px);box-shadow:0 10px 30px rgba(0,0,0,.25);opacity:0;font-family:"Liberation Sans","DejaVu Sans",sans-serif;color:#151515}
.band .t{position:absolute;font-weight:900;white-space:nowrap}
.bubble:after{content:"";position:absolute;left:120px;bottom:-40px;border:26px solid transparent;border-top:30px solid #fff}
"""


def render(fx, total):
    """Return (html, js) for the fx list."""
    body, js = [], []
    for k, f in enumerate(fx):
        t, d = float(f["t"]), float(f.get("dur", 1.5))
        d = min(d, total - t)
        i = f"fx{k}"
        clip = f'class="fx {{cls}} clip" id="{i}" data-start="{t:.2f}" data-duration="{d:.2f}" data-track-index="{100 + k}"'
        kind = f["type"]
        if kind == "zoom":
            s = f.get("scale", 1.15)
            js.append(f'tl.fromTo("#bg",{{scale:1}},{{scale:{s},duration:{d / 2:.2f},ease:"power2.out"}},{t:.2f});')
            js.append(f'tl.to("#bg",{{scale:1,duration:{d / 2:.2f},ease:"power2.in"}},{t + d / 2:.2f});')
        elif kind == "flash":
            body.append(f'<div {clip.format(cls="flash")}></div>')
            js.append(f'tl.fromTo("#{i}",{{opacity:0}},{{opacity:.9,duration:.06}},{t:.2f});')
            js.append(f'tl.to("#{i}",{{opacity:0,duration:{max(d - .06, .1):.2f},ease:"power2.out"}},{t + .06:.2f});')
        elif kind == "slam":
            body.append(f'<div {clip.format(cls="slam")} style="color:{f.get("color", "#FFD60A")};font-size:{f.get("size", 170)}px;top:{f.get("top", 640)}px">'
                        f'{html.escape(f["text"])}</div>')
            js.append(f'tl.fromTo("#{i}",{{opacity:0,scale:3.2}},{{opacity:1,scale:1,duration:.22,ease:"power4.in"}},{t:.2f});')
            js.append(f'tl.fromTo("#{i}",{{x:-18}},{{x:18,duration:.05,yoyo:true,repeat:5,ease:"none"}},{t + .22:.2f});')
            js.append(f'tl.to("#{i}",{{x:0,duration:.05}},{t + .52:.2f});')
            js.append(f'tl.to("#{i}",{{opacity:0,scale:.7,duration:.18}},{t + d - .18:.2f});')
        elif kind == "timer":
            v, col = f.get("value", 9), f.get("color", "#FF7A1A")
            c = 2 * 3.14159 * 190
            body.append(f'<div {clip.format(cls="panel")}><svg width="940" height="560" style="position:absolute;top:20px;left:0">'
                        f'<circle cx="470" cy="280" r="190" fill="none" stroke="#eee" stroke-width="34"/>'
                        f'<circle id="{i}r" cx="470" cy="280" r="190" fill="none" stroke="{col}" stroke-width="34" '
                        f'stroke-linecap="round" transform="rotate(-90 470 280)" stroke-dasharray="{c:.0f}" '
                        f'stroke-dashoffset="{c:.0f}"/></svg>'
                        f'<div style="position:absolute;top:190px;left:0;right:0;text-align:center">'
                        f'<span class="num" id="{i}n" style="font-size:200px;color:{col}">0</span></div>'
                        f'<div class="lbl" style="position:absolute;bottom:40px;left:0;right:0">{html.escape(f.get("label", "секунд"))}</div></div>')
            cd = min(1.2, d - .5)
            js.append(f'tl.fromTo("#{i}",{{opacity:0,y:60,scale:.9}},{{opacity:1,y:0,scale:1,duration:.25,ease:"back.out(2)"}},{t:.2f});')
            js.append(f'(()=>{{const s={{v:0}},n=document.getElementById("{i}n");tl.to(s,{{v:{v},duration:{cd:.2f},ease:"power1.out",'
                      f'onUpdate:()=>{{n.textContent=Math.round(s.v)}}}},{t + .25:.2f});}})();')
            js.append(f'tl.fromTo("#{i}n",{{scale:.5}},{{scale:1,duration:{cd:.2f},ease:"power1.out"}},{t + .25:.2f});')
            js.append(f'tl.to("#{i}r",{{attr:{{"stroke-dashoffset":0}},duration:{cd:.2f},ease:"power1.out"}},{t + .25:.2f});')
            js.append(f'tl.to("#{i}n",{{scale:1.15,duration:.12,yoyo:true,repeat:1}},{t + .25 + cd:.2f});')
            js.append(f'tl.to("#{i}",{{opacity:0,y:-40,duration:.2}},{t + d - .2:.2f});')
        elif kind == "thermo":
            items, mx = f["items"], f.get("max", 220)
            n, cd = len(items), min(1.4, d - .6)
            parts = []
            for j, it in enumerate(items):
                x = 430 + int((j - (n - 1) / 2) * 400)  # gauge centres spread around the panel middle
                h = int(380 * it["value"] / mx)
                parts.append(
                    f'<div style="position:absolute;left:{x - 60}px;top:30px;width:200px;text-align:center;font-size:70px">{it.get("icon", "")}</div>'
                    f'<div style="position:absolute;left:{x}px;top:130px;width:80px;height:380px;border-radius:40px;background:#eee;overflow:hidden">'
                    f'<div id="{i}f{j}" style="position:absolute;bottom:0;left:0;right:0;height:{h}px;background:{it["color"]};'
                    f'transform-origin:bottom;transform:scaleY(0);border-radius:40px"></div></div>'
                    f'<div style="position:absolute;left:{x - 110}px;top:520px;width:300px;text-align:center">'
                    f'<span class="num" id="{i}n{j}" style="font-size:96px;color:{it["color"]}">0</span>'
                    f'<span class="num" style="font-size:96px;color:{it["color"]}">{html.escape(it.get("unit", ""))}</span></div>')
                lag = j * .35
                js.append(f'tl.to("#{i}f{j}",{{scaleY:1,duration:{cd:.2f},ease:"power2.out"}},{t + .25 + lag:.2f});')
                js.append(f'(()=>{{const s={{v:0}},e=document.getElementById("{i}n{j}");tl.to(s,{{v:{it["value"]},duration:{cd:.2f},'
                          f'ease:"power2.out",onUpdate:()=>{{e.textContent=Math.round(s.v)}}}},{t + .25 + lag:.2f});}})();')
            labels = "".join(f'<div class="lbl" style="position:absolute;top:620px;left:{430 + int((j - (n - 1) / 2) * 400) - 110}px;'
                             f'width:300px;font-size:50px">{html.escape(it["label"])}</div>' for j, it in enumerate(items))
            body.append(f'<div {clip.format(cls="panel")} style="height:700px">{"".join(parts)}{labels}</div>')
            js.append(f'tl.fromTo("#{i}",{{opacity:0,y:60}},{{opacity:1,y:0,duration:.25,ease:"back.out(2)"}},{t:.2f});')
            js.append(f'tl.to("#{i}",{{opacity:0,y:-40,duration:.2}},{t + d - .2:.2f});')
        elif kind == "compare":
            rows, mx = f["rows"], f.get("max", max(r["value"] for r in f["rows"]))
            parts = []
            for j, r in enumerate(rows):
                y = 90 + j * 280
                w = max(int(620 * r["value"] / mx), 110)
                parts.append(f'<div class="lbl" style="position:absolute;left:50px;top:{y}px;text-align:left">{html.escape(r["label"])}</div>'
                             f'<div class="bar" id="{i}b{j}" style="left:50px;top:{y + 80}px;width:{w}px;background:{r["color"]};transform:scaleX(0)"></div>'
                             f'<div class="num" id="{i}t{j}" style="position:absolute;left:{70 + w}px;top:{y + 88}px;font-size:70px;color:{r["color"]};opacity:0">'
                             f'{html.escape(r["text"])}</div>'
                             f'<div class="badge" id="{i}m{j}" style="right:40px;top:{y - 10}px">{r.get("mark", "")}</div>')
                lag = .25 + j * .6
                js.append(f'tl.to("#{i}b{j}",{{scaleX:1,duration:.55,ease:"power3.out"}},{t + lag:.2f});')
                js.append(f'tl.to("#{i}t{j}",{{opacity:1,duration:.2}},{t + lag + .45:.2f});')
                js.append(f'tl.fromTo("#{i}m{j}",{{opacity:0,scale:0}},{{opacity:1,scale:1,duration:.25,ease:"back.out(3)"}},{t + lag + .5:.2f});')
            body.append(f'<div {clip.format(cls="panel")} style="height:{120 + 280 * len(rows)}px">{"".join(parts)}</div>')
            js.append(f'tl.fromTo("#{i}",{{opacity:0,x:-120}},{{opacity:1,x:0,duration:.25,ease:"power3.out"}},{t:.2f});')
            js.append(f'tl.to("#{i}",{{opacity:0,x:120,duration:.2}},{t + d - .2:.2f});')
        elif kind == "checklist":
            items = f["items"]
            parts = []
            for j, (text, ta) in enumerate(items):
                parts.append(f'<div class="chk" id="{i}c{j}" style="top:{60 + j * 150}px"><b id="{i}k{j}">✓</b>{html.escape(text)}</div>')
                js.append(f'tl.fromTo("#{i}c{j}",{{opacity:0,x:-80}},{{opacity:1,x:0,duration:.22,ease:"power3.out"}},{ta:.2f});')
                js.append(f'tl.to("#{i}k{j}",{{scale:1,duration:.3,ease:"back.out(3)"}},{ta + .15:.2f});')
            body.append(f'<div {clip.format(cls="panel")} style="height:{80 + 150 * len(items)}px">{"".join(parts)}</div>')
            js.append(f'tl.fromTo("#{i}",{{opacity:0,y:50}},{{opacity:1,y:0,duration:.2}},{t:.2f});')
            js.append(f'tl.to("#{i}",{{opacity:0,y:-40,duration:.2}},{t + d - .2:.2f});')
        elif kind == "steam":
            rnd = random.Random(k * 7 + 3)
            x0, y0, n = f.get("x", 540), f.get("y", 1100), f.get("n", 14)
            dots = []
            for j in range(n):
                dx, dy = rnd.uniform(-220, 220), rnd.uniform(-520, -260)
                s, lag = rnd.uniform(.6, 1.8), rnd.uniform(0, d * .5)
                dots.append(f'<div class="dot" id="{i}d{j}" style="left:{x0 - 35}px;top:{y0 - 35}px"></div>')
                js.append(f'tl.fromTo("#{i}d{j}",{{opacity:0,x:0,y:0,scale:.3}},{{opacity:.9,x:{dx / 3:.0f},y:{dy / 3:.0f},scale:{s / 2:.2f},'
                          f'duration:{d * .3:.2f},ease:"power1.out"}},{t + lag:.2f});')
                js.append(f'tl.to("#{i}d{j}",{{opacity:0,x:{dx:.0f},y:{dy:.0f},scale:{s * 1.6:.2f},duration:{d * .45:.2f},ease:"power1.in"}},'
                          f'{t + lag + d * .3:.2f});')
            body.append(f'<div {clip.format(cls="")} style="inset:0">{"".join(dots)}</div>')
        elif kind == "cta":
            text = f.get("text", "ПАР")
            letters = "".join(f'<i id="{i}l{j}">{html.escape(ch)}</i>' for j, ch in enumerate(text))
            body.append(f'<div {clip.format(cls="bubble")}>💬&nbsp;{letters}</div>')
            js.append(f'tl.fromTo("#{i}",{{opacity:0,scale:.3,y:80}},{{opacity:1,scale:1,y:0,duration:.3,ease:"back.out(2.4)"}},{t:.2f});')
            for j in range(len(text)):
                js.append(f'tl.to("#{i}l{j}",{{opacity:1,duration:.05}},{t + .35 + j * .16:.2f});')
            p0 = t + .45 + len(text) * .16
            reps = max(int((d - (p0 - t) - .2) / .5), 1)
            js.append(f'tl.to("#{i}",{{scale:1.08,duration:.25,yoyo:true,repeat:{reps * 2 - 1},ease:"sine.inOut"}},{p0:.2f});')

        elif kind == "whip":
            js.append(f'tl.to("#bg",{{x:-90,filter:"blur(14px)",duration:.1,ease:"power2.in"}},{t - .1:.2f});')
            js.append(f'tl.fromTo("#bg",{{x:90,filter:"blur(14px)"}},{{x:0,filter:"blur(0px)",duration:.16,ease:"power2.out",immediateRender:false}},{t:.2f});')
        elif kind == "punch":
            js.append(f'tl.fromTo("#bg",{{scale:{f.get("scale", 1.08)}}},{{scale:1,duration:.4,ease:"power3.out",immediateRender:false}},{t:.2f});')
        elif kind == "zoomto":
            ox, oy = f["x"] / 10.8, f["y"] / 19.2
            js.append(f'tl.set("#bg",{{transformOrigin:"{ox:.1f}% {oy:.1f}%"}},{t:.2f});')
            js.append(f'tl.fromTo("#bg",{{scale:1}},{{scale:{f.get("scale", 1.3)},duration:{d:.2f},ease:"power1.inOut",immediateRender:false}},{t:.2f});')
            js.append(f'tl.set("#bg",{{scale:1,transformOrigin:"50% 50%"}},{t + d:.2f});')
        elif kind == "callout":
            x, y, rx, ry = f["x"], f["y"], f.get("rx", 240), f.get("ry", 110)
            L = int(3.3 * (rx + ry))
            body.append(f'<div {clip.format(cls="")} style="inset:0"><svg width="1080" height="1920" style="position:absolute;left:0;top:0">'
                        f'<ellipse id="{i}e" cx="{x}" cy="{y}" rx="{rx}" ry="{ry}" fill="none" stroke="#FFD60A" stroke-width="12" '
                        f'stroke-linecap="round" stroke-dasharray="{L}" stroke-dashoffset="{L}" transform="rotate(-8 {x} {y})"/></svg>'
                        f'<div class="t" id="{i}t" style="position:absolute;left:{max(x - rx, 40)}px;top:{y + ry + 20}px;font-weight:900;font-size:64px;'
                        f'color:#FFD60A;text-shadow:0 4px 0 #000,3px 0 0 #000,-3px 0 0 #000;opacity:0">{html.escape(f.get("label", ""))}</div></div>')
            js.append(f'tl.to("#{i}e",{{attr:{{"stroke-dashoffset":0}},duration:.45,ease:"power2.out"}},{t:.2f});')
            js.append(f'tl.fromTo("#{i}t",{{opacity:0,y:20}},{{opacity:1,y:0,duration:.2,ease:"back.out(2)"}},{t + .3:.2f});')
        elif kind == "beforeafter":
            body.append(f'<div {clip.format(cls="")} style="inset:0;overflow:hidden">'
                        f'<img src="{f["before"]}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"/>'
                        f'<div id="{i}w" style="position:absolute;inset:0;clip-path:inset(0 100% 0 0)">'
                        f'<img src="{f["after"]}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"/></div>'
                        f'<div id="{i}line" style="position:absolute;top:0;bottom:0;left:0;width:10px;background:#fff;box-shadow:0 0 20px #fff"></div>'
                        f'<div style="position:absolute;left:40px;top:360px;font-weight:900;font-size:90px;color:#FF4D4D;'
                        f'text-shadow:0 5px 0 #000,3px 0 0 #000,-3px 0 0 #000">ДО</div>'
                        f'<div id="{i}a" style="position:absolute;right:40px;top:360px;font-weight:900;font-size:90px;color:#3DDC84;opacity:0;'
                        f'text-shadow:0 5px 0 #000,3px 0 0 #000,-3px 0 0 #000">ПОСЛЕ ✨</div></div>')
            w0, w1 = t + .25, t + .85
            js.append(f'(()=>{{const s={{p:0}},w=document.getElementById("{i}w"),l=document.getElementById("{i}line");'
                      f'tl.to(s,{{p:1,duration:{w1 - w0:.2f},ease:"power2.inOut",onUpdate:()=>{{w.style.clipPath="inset(0 "+(100-s.p*100)+"% 0 0)";'
                      f'l.style.left=(s.p*1070)+"px"}}}},{w0:.2f});}})();')
            js.append(f'tl.to("#{i}a",{{opacity:1,duration:.15}},{w1 - .1:.2f});')
        elif kind.startswith("b_"):
            inner = ""
            if kind == "b_count":
                col = f.get("color", "#2F80ED")
                inner = (f'<div class="t" style="left:40px;top:40px;font-size:150px">{f.get("icon", "")}</div>'
                         f'<div class="t" style="left:230px;top:30px;font-size:120px;color:{col}"><span class="num" id="{i}n">{"+" if f["frm"] > 0 else ""}{f["frm"]}</span>'
                         f'{html.escape(f.get("unit", ""))}</div>'
                         f'<div class="t" style="left:232px;top:168px;font-size:46px">{html.escape(f.get("label", ""))}</div>')
                js.append(f'(()=>{{const s={{v:{f["frm"]}}},e=document.getElementById("{i}n");tl.to(s,{{v:{f["to"]},duration:{min(1.6, d - .6):.2f},'
                          f'ease:"power1.inOut",onUpdate:()=>{{const r=Math.round(s.v);e.textContent=(r>0?"+":"")+r}}}},{t + .3:.2f});}})();')
            elif kind == "b_bar":
                col = f.get("color", "#FF4D4D")
                inner = (f'<div class="t" style="left:40px;top:30px;font-size:54px">{html.escape(f["label"])}</div>'
                         f'<div id="{i}b" style="position:absolute;left:40px;top:120px;width:660px;height:84px;border-radius:42px;background:{col};'
                         f'transform-origin:left;transform:scaleX(0)"></div>'
                         f'<div class="t" id="{i}x" style="left:60px;top:126px;font-size:62px;color:#fff;opacity:0">{html.escape(f["text"])}</div>'
                         f'<div class="t" id="{i}m" style="right:40px;top:100px;font-size:100px;opacity:0">{f.get("mark", "")}</div>')
                js.append(f'tl.to("#{i}b",{{scaleX:1,duration:.9,ease:"power2.out"}},{t + .25:.2f});')
                js.append(f'tl.to("#{i}x",{{opacity:1,duration:.2}},{t + .8:.2f});')
                js.append(f'tl.fromTo("#{i}m",{{opacity:0,scale:0}},{{opacity:1,scale:1,duration:.25,ease:"back.out(3)"}},{t + 1.0:.2f});')
            elif kind == "b_ring":
                v, col = f.get("value", 9), f.get("color", "#FF7A1A")
                c = 2 * 3.14159 * 90
                inner = (f'<svg width="240" height="240" style="position:absolute;left:20px;top:5px"><circle cx="120" cy="120" r="90" fill="none" '
                         f'stroke="rgba(0,0,0,.12)" stroke-width="22"/><circle id="{i}r" cx="120" cy="120" r="90" fill="none" stroke="{col}" '
                         f'stroke-width="22" stroke-linecap="round" transform="rotate(-90 120 120)" stroke-dasharray="{c:.0f}" stroke-dashoffset="{c:.0f}"/></svg>'
                         f'<div class="t" style="left:20px;top:62px;width:240px;text-align:center;font-size:100px;color:{col}"><span class="num" id="{i}n">0</span></div>'
                         f'<div class="t" style="left:290px;top:70px;font-size:62px;white-space:normal;width:640px;line-height:1.15">{html.escape(f.get("text", ""))}</div>')
                cd = min(1.2, d - .5)
                js.append(f'(()=>{{const s={{v:0}},e=document.getElementById("{i}n");tl.to(s,{{v:{v},duration:{cd:.2f},ease:"power1.out",'
                          f'onUpdate:()=>{{e.textContent=Math.round(s.v)}}}},{t + .25:.2f});}})();')
                js.append(f'tl.to("#{i}r",{{attr:{{"stroke-dashoffset":0}},duration:{cd:.2f},ease:"power1.out"}},{t + .25:.2f});')
            elif kind == "b_crease":
                a0, a1 = float(f.get("at", t + .5)), float(f.get("until", t + d - .6))
                inner = (f'<div class="t" id="{i}l" style="left:40px;top:22px;font-size:52px;color:#FF4D4D">{html.escape(f.get("before", "заломы 😩"))}</div>'
                         f'<div class="t" id="{i}g" style="left:40px;top:22px;font-size:52px;color:#1FAF5A;opacity:0">{html.escape(f.get("after", "гладко ✨"))}</div>'
                         f'<svg width="960" height="170" style="position:absolute;left:0;top:80px"><polyline id="{i}p" fill="none" stroke="#FF4D4D" '
                         f'stroke-width="16" stroke-linecap="round" stroke-linejoin="round" points=""/></svg>')
                js.append(f'(()=>{{const s={{k:1}},p=document.getElementById("{i}p");const draw=()=>{{let a=[];for(let x=0;x<=840;x+=12){{'
                          f'const y=85+s.k*(38*Math.sin(x/23)+22*Math.sin(x/9+1)+12*Math.sin(x/4));a.push((x+60)+","+y.toFixed(1));}}'
                          f'p.setAttribute("points",a.join(" "));p.setAttribute("stroke",s.k>.5?"#FF4D4D":"#1FAF5A");}};draw();'
                          f'tl.to(s,{{k:0,duration:{a1 - a0:.2f},ease:"power2.inOut",onUpdate:draw}},{a0:.2f});}})();')
                js.append(f'tl.to("#{i}l",{{opacity:0,duration:.2}},{a1 - .1:.2f});')
                js.append(f'tl.to("#{i}g",{{opacity:1,duration:.2}},{a1 - .1:.2f});')
            elif kind == "b_compare":
                rows = f["rows"]
                mx = max(r["value"] for r in rows)
                for j, r in enumerate(rows):
                    y = 28 + j * 110
                    w = max(int(360 * r["value"] / mx), 70)
                    inner += (f'<div class="t" style="left:40px;top:{y + 8}px;font-size:50px;width:300px">{html.escape(r["label"])}</div>'
                              f'<div id="{i}b{j}" style="position:absolute;left:330px;top:{y}px;width:{w}px;height:76px;border-radius:38px;'
                              f'background:{r["color"]};transform-origin:left;transform:scaleX(0)"></div>'
                              f'<div class="t" id="{i}x{j}" style="left:{345 + w}px;top:{y + 8}px;font-size:52px;color:{r["color"]};opacity:0">'
                              f'{html.escape(r["text"])} {r.get("mark", "")}</div>')
                    js.append(f'tl.to("#{i}b{j}",{{scaleX:1,duration:.5,ease:"power3.out"}},{t + .25 + j * .5:.2f});')
                    js.append(f'tl.to("#{i}x{j}",{{opacity:1,duration:.2}},{t + .6 + j * .5:.2f});')
            elif kind == "b_bubble":
                text = f.get("text", "ПАР")
                letters = "".join(f'<i id="{i}l{j}" style="font-style:normal;opacity:0">{html.escape(ch)}</i>' for j, ch in enumerate(text))
                inner = (f'<div class="t" id="{i}c" style="left:0;right:0;top:20px;text-align:center;font-size:120px;color:#FF7A1A">💬 {letters}</div>'
                         f'<div class="t" style="left:0;right:0;top:170px;text-align:center;font-size:46px">{html.escape(f.get("hint", "👇 напишите в комментариях"))}</div>')
                for j in range(len(text)):
                    js.append(f'tl.to("#{i}l{j}",{{opacity:1,duration:.05}},{t + .35 + j * .16:.2f});')
                p0 = t + .45 + len(text) * .16
                reps = max(int((d - (p0 - t) - .2) / .5), 1)
                js.append(f'tl.to("#{i}c",{{scale:1.08,duration:.25,yoyo:true,repeat:{reps * 2 - 1},ease:"sine.inOut"}},{p0:.2f});')
            body.append(f'<div {clip.format(cls="band")}>{inner}</div>')
            js.append(f'tl.fromTo("#{i}",{{opacity:0,y:-30,scale:.92}},{{opacity:1,y:0,scale:1,duration:.25,ease:"back.out(2)"}},{t:.2f});')
            js.append(f'tl.to("#{i}",{{opacity:0,y:-20,duration:.18}},{t + d - .18:.2f});')
    return "\n".join(body), js
