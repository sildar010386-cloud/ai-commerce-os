import sys, json, math, subprocess, random, numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter
OUT = sys.argv[1]; LIMIT = float(sys.argv[2]) if len(sys.argv) > 2 else None
START = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
P = json.load(open('/tmp/facework/reel02/plan.json'))
FPS, W, H = 30, 1080, 1920
DUR = P['dur']; NF = int(math.ceil(DUR * FPS)) + 1
ORANGE = (242, 107, 30); WHITE = (255, 255, 255)
FD = '/tmp/facework/reel01/fonts/Montserrat-'
fnt = lambda n, s: ImageFont.truetype(FD + n + '.ttf', int(round(s)))

# ---------- voice -> mouth state ----------
pcm = subprocess.run(['ffmpeg', '-v', 'error', '-i', '/tmp/facework/reel02/v21.mp3', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], capture_output=True).stdout
a = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
spf = 48000 // FPS
rms = np.array([np.sqrt(np.mean(a[i * spf:(i + 1) * spf] ** 2)) if i * spf < len(a) else 0 for i in range(NF)])
rms = np.convolve(rms, [0.25, 0.5, 0.25], 'same'); rms = rms / np.percentile(rms[rms > 0.01], 90)
CL, HF = 0.30, 0.85
raw = ['closed' if v < CL else ('half' if v < HF else 'open') for v in rms]
state = list(raw); cur = raw[0]
for i in range(NF):
    if raw[i] != cur and i + 1 < NF and raw[i + 1] == raw[i]: cur = raw[i]
    state[i] = cur
blink = set(); t = 1.3; random.seed(3)
while t < DUR - 0.3:
    f0 = int(t * FPS); ok = None
    for off in sorted(range(-20, 21), key=abs):
        f = f0 + off
        if 0 <= f and f + 3 <= NF and all(state[f + k] == 'closed' for k in range(3)): ok = f; break
    if ok is not None: blink.update({ok, ok + 1, ok + 2}); t = ok / FPS + 3.0 + random.random()
    else: t += 1.0
print('blinks', len(blink) // 3, {k: state.count(k) for k in ('closed', 'half', 'open')})

# ---------- poses ----------
POSES = {}
for p in ('01', '02', '03', '04', '05', '06', '07', '08', '09'):
    POSES[p] = {s: cv2.imread(f'/tmp/facework/reel01/poses/{p}_{s}.png') for s in ('closed', 'half', 'open', 'blink')}
S_A = 1.20; S_B = 1.34
AX, AY = 540.0, 400.0     # anchor in pose image -> screen
SX, SY = 540.0, 830.0
def char_layer(pose, st, scale, dx=0, dy=0):
    img = POSES[pose][st]
    M = np.float32([[scale, 0, SX - AX * scale + dx], [0, scale, SY - AY * scale + dy]])
    return cv2.warpAffine(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)

# ---------- b-roll ----------
caps = {}
def broll_frame(src, t_in_shot, scale):
    name, off = src.split(':'); spd = 1.0
    if '@' in off: off, spd = off.split('@'); spd = float(spd)
    off = float(off)
    key = (name, off)
    fidx = int(round((off + t_in_shot * spd) * FPS))
    if key not in caps or caps[key][1] != fidx:
        if key in caps and caps[key][1] == fidx - 1 - 0:
            pass
    cap, last, fr = caps.get(key, (None, -10, None))
    if cap is None:
        cap = cv2.VideoCapture(f'/home/user/work/reel01/{name}.mp4'); cap.set(cv2.CAP_PROP_POS_FRAMES, fidx); last = fidx - 1
    if fidx != last:
        if fidx != last + 1: cap.set(cv2.CAP_PROP_POS_FRAMES, fidx)
        ok, fr2 = cap.read()
        if ok: fr = fr2
    caps[key] = (cap, fidx, fr)
    M = np.float32([[scale, 0, W / 2 * (1 - scale)], [0, scale, H / 2 * (1 - scale)]])
    return cv2.warpAffine(fr, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE) if abs(scale - 1) > 1e-4 else fr

# ---------- camera transitions ----------
TRD = {'swipe_l': .22, 'swipe_r': .22, 'pop': .30, 'whip_up': .20, 'pull': .35, 'flash': .18, 'tilt': .32, 'pop_fast': .16}
def cam_fx(fr, dt, kind):
    d = TRD[kind]
    if dt >= d: return fr
    amt = (1 - dt / d) ** 2
    sc, tx, ty, rot, bl = 1.0, 0, 0, 0, (0, 0)
    if kind == 'swipe_l': tx = 44 * amt; bl = (int(7 * amt) * 2 + 1, 1)
    if kind == 'swipe_r': tx = -44 * amt; bl = (int(7 * amt) * 2 + 1, 1)
    if kind == 'pop': sc = 1 + .06 * amt
    if kind == 'pop_fast': sc = 1 + .09 * amt
    if kind == 'pull': sc = 1 - .06 * amt
    if kind == 'whip_up': ty = 48 * amt; bl = (1, int(9 * amt) * 2 + 1)
    if kind == 'tilt': rot = 1.6 * amt
    M = cv2.getRotationMatrix2D((W / 2, H / 2), rot, sc); M[0, 2] += tx; M[1, 2] += ty
    out = cv2.warpAffine(fr, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    if bl[0] > 1 or bl[1] > 1: out = cv2.blur(out, bl)
    if kind == 'flash': out = cv2.addWeighted(out, 1 - .55 * amt, np.full_like(out, 255), .55 * amt, 0)
    return out

# ---------- grading: bottom darkening + vignette ----------
yy = np.arange(H, dtype=np.float32)[:, None]
grad = np.clip(1.0 - 0.50 * np.clip((yy - 1000) / 560, 0, 1), 0.5, 1.0)
xx = np.arange(W, dtype=np.float32)[None, :]
rad = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
vig = 1.0 - 0.30 * np.clip((rad - 0.55) / 0.85, 0, 1) ** 1.5
GRADE = (grad * vig)[..., None].astype(np.float32)
grad2 = np.clip(1.0 - 0.28 * np.clip((yy - 1000) / 560, 0, 1), 0.7, 1.0)
GRADE_F = (grad2 * (1.0 - 0.18 * np.clip((rad - 0.55) / 0.85, 0, 1) ** 1.5))[..., None].astype(np.float32)

# ---------- text sprites ----------
def shadowed(layer_rgba, blur=14, alpha=.62, off=(0, 4)):
    """layer_rgba: PIL RGBA with colored text; returns RGBA with soft dark shadow underneath"""
    al = layer_rgba.split()[3]
    big = Image.new('L', layer_rgba.size, 0); big.paste(al, off)
    s1 = big.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * alpha * 1.6) if v * alpha * 1.6 < 255 else 255)
    s2 = big.filter(ImageFilter.GaussianBlur(3)).point(lambda v: int(v * .55))
    sh = Image.merge('RGBA', (Image.new('L', layer_rgba.size, 0),) * 3 + (Image.fromarray(np.maximum(np.array(s1), np.array(s2))),))
    sh.alpha_composite(layer_rgba)
    return sh

def block_shadow(size, bbox, pad=26, blur=40, alpha=.42):
    m = Image.new('L', size, 0); ImageDraw.Draw(m).rounded_rectangle((bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad), 40, fill=int(255 * alpha))
    m = m.filter(ImageFilter.GaussianBlur(blur))
    return Image.merge('RGBA', (Image.new('L', size, 0),) * 3 + (m,))

SZ = {0: 54, 1: 150, 2: 235}
MAXW = 880; MAXW_BIG = 828
def layout_group(g):
    """returns lines: [{lvl, toks:[idx], size, w, h, xs:[x per token]}] and total height"""
    lines = []; cur = None
    for i, t in enumerate(g['toks']):
        newline = cur is None or t['brk'] or t['lvl'] != cur['lvl'] or (t['lvl'] == 0 and False)
        if newline: cur = dict(lvl=t['lvl'], toks=[]); lines.append(cur)
        cur['toks'].append(i)
    # wrap normal lines wider than MAXW
    out = []
    for ln in lines:
        if ln['lvl'] == 0:
            f = fnt('Medium', SZ[0]); sp = f.getlength(' ')
            row = []; wrow = 0
            for i in ln['toks']:
                w = f.getlength(g['toks'][i]['text'])
                if row and wrow + sp + w > MAXW: out.append(dict(lvl=0, toks=row)); row = []; wrow = 0
                wrow += (sp if row else 0) + w; row.append(i)
            out.append(dict(lvl=0, toks=row))
        else: out.append(ln)
    y = 0
    for ln in out:
        lvl = ln['lvl']; fam = 'Medium' if lvl == 0 else 'Black'
        size = SZ[lvl]
        txts = [g['toks'][i]['text'] for i in ln['toks']]
        while True:
            f = fnt(fam, size); sp = f.getlength(' ') * (1 if lvl == 0 else 1.5)
            ws = [f.getlength(t) for t in txts]; tw = sum(ws) + sp * (len(ws) - 1)
            if lvl == 0 or tw <= MAXW_BIG or size < 40: break
            size -= 2
        x = (W - tw) / 2; xs = []
        for w in ws: xs.append(x); x += w + sp
        ln.update(size=size, fam=fam, xs=xs, ws=ws, tw=tw, y=y)
        y += int(size * (1.30 if lvl == 0 else 1.0)) + (6 if lvl == 0 else 12)
    return out, y

def render_group(g, k, pops):
    lines, hh = g['_lay']
    pad = 80
    img = Image.new('RGBA', (W, hh + 2 * pad), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    bb = [W, 1e9, 0, 0]
    for ln in lines:
        f = fnt(ln['fam'], ln['size']); col = WHITE if ln['lvl'] != 2 else ORANGE
        for j, i in enumerate(ln['toks']):
            if i >= k: continue
            t = g['toks'][i]; sc = pops.get(i, 1.0)
            c = ORANGE if t['lvl'] == 2 else WHITE
            if t['lvl'] == 1 and t['text'].isdigit(): c = ORANGE
            ff = f if sc == 1.0 else fnt(ln['fam'], ln['size'] * sc)
            x = ln['xs'][j] + ln['ws'][j] / 2; yb = pad + ln['y'] + ln['size'] * 0.5
            asc = ff.getbbox('Hg')[1]
            d.text((x, yb), t['text'], font=ff, fill=c + (255,), anchor='mm')
            bb[0] = min(bb[0], ln['xs'][j]); bb[1] = min(bb[1], pad + ln['y']); bb[2] = max(bb[2], ln['xs'][j] + ln['ws'][j]); bb[3] = max(bb[3], pad + ln['y'] + ln['size'])
    out = shadowed(img, blur=15, alpha=.62)
    if bb[2] > bb[0]:
        out = Image.alpha_composite(block_shadow(out.size, bb, pad=24, blur=38, alpha=.40), out)
    return np.array(out)
cache = {}
def group_sprite(gi, t):
    g = P['groups'][gi]
    if '_lay' not in g: g['_lay'] = layout_group(g)
    k = sum(1 for tk in g['toks'] if tk['s'] <= t + 1e-3)
    pops = {}
    for i, tk in enumerate(g['toks'][:k]):
        if tk['lvl'] and t - tk['s'] < 0.18:
            ph = int((t - tk['s']) / 0.18 * 5); pops[i] = 1.08 - 0.08 * ph / 5
    key = (gi, k, tuple(sorted(pops.items())))
    if key not in cache: cache[key] = render_group(g, k, pops)
    return cache[key], g['_lay'][1]

def blit(fr, spr, x, y, alpha=1.0):
    h, w = spr.shape[:2]
    x0, y0 = max(0, x), max(0, y); x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0: return
    s = spr[y0 - y:y1 - y, x0 - x:x1 - x].astype(np.float32)
    al = s[..., 3:4] / 255 * alpha
    reg = fr[y0:y1, x0:x1].astype(np.float32)
    fr[y0:y1, x0:x1] = np.clip(reg * (1 - al) + s[..., :3][..., ::-1] * al, 0, 255).astype(np.uint8)

# ---------- permanent title (header) ----------
def title_sprite():
    img = Image.new('RGBA', (W, 330), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    l1 = 'ПОЧЕМУ НИКТО НЕ ГОВОРИТ,'; l2a = 'ЧТО '; l2b = 'ГЛАЖКА СТАЛА ПРОЩЕ?'
    s1 = 100
    while fnt('BlackItalic', s1).getlength(l1) > 1010 or fnt('BlackItalic', s1).getlength(l2a + l2b) > 1010: s1 -= 1
    f1 = fnt('BlackItalic', s1)
    y1 = 40; y2 = y1 + int(s1 * 1.22)
    d.text((W / 2, y1 + s1 / 2), l1, font=f1, fill=WHITE + (255,), anchor='mm')
    wa = f1.getlength(l2a); wb = f1.getlength(l2b); x0 = (W - wa - wb) / 2
    d.text((x0, y2 + s1 / 2), l2a, font=f1, fill=WHITE + (255,), anchor='lm')
    d.text((x0 + wa, y2 + s1 / 2), l2b, font=f1, fill=ORANGE + (255,), anchor='lm')
    out = shadowed(img, blur=12, alpha=.8, off=(0, 5))
    print('title size', s1, 'height', y2 + s1 - y1)
    return np.array(out), y2 + s1 - y1
TITLE, TITLE_H = title_sprite()
TITLE_Y = 262          # sprite top; text starts ~y=302, ends ~y=302+TITLE_H
tg = np.clip(1 - (np.arange(H, dtype=np.float32) - 230) / 360, 0, 1)
tg[:230] = 1.0
TGRAD = (1 - 0.42 * (tg ** 1.4 * (np.arange(H) < 600)))[:, None, None].astype(np.float32)   # soft dark gradient behind the title

# ---------- top-zone inserts ----------
icache = {}
def insert_sprite(ins, t):
    k = sum(1 for it in ins['items'] if it[1] <= t + 1e-3)
    pop = {}
    for j, it in enumerate(ins['items'][:k]):
        if t - it[1] < 0.18: pop[j] = 1.15 - 0.15 * int((t - it[1]) / 0.18 * 5) / 5
    key = (id(ins), k, tuple(sorted(pop.items())))
    if key in icache: return icache[key]
    title = ins['style'] == 'title'
    size = 58 if title else 46
    items = ins['items']; txt_all = [it[0] for it in items]
    fam = 'Black' if title else 'ExtraBold'
    dot = 26
    while True:
        f = fnt(fam, size); ws = [f.getlength(tx) for tx in txt_all]
        tw = sum(ws) + dot * (len(ws) - 1) + 40 * (len(ws) - 1)
        if tw <= 960 or size < 30: break
        size -= 2
    img = Image.new('RGBA', (W, 140), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    x = (W - tw) / 2; cy = 70
    for j, (tx, w) in enumerate(zip(txt_all, ws)):
        if j < k:
            sc = pop.get(j, 1.0); ff = f if sc == 1 else fnt(fam, size * sc)
            col = ORANGE if title else WHITE
            d.text((x + w / 2, cy), tx, font=ff, fill=col + (255,), anchor='mm')
        if j < len(ws) - 1:
            if j + 1 < k: d.ellipse((x + w + 20, cy - 9, x + w + 38, cy + 9), fill=ORANGE + (255,))
            x += w + dot + 40
        else: x += w
    out = shadowed(img, blur=10, alpha=.7)
    icache[key] = np.array(out); return icache[key]

# ---------- PiP ----------
PIPD = 260
def pip_sprite(st, scale):
    img = POSES['01'][st][180:700, 280:800]
    img = cv2.resize(img, (PIPD, PIPD), interpolation=cv2.INTER_AREA)
    ring = 8
    s = int(PIPD * scale); 
    yy2, xx2 = np.ogrid[:PIPD + 40, :PIPD + 40]
    c = (PIPD + 40) / 2
    dist = np.sqrt((xx2 - c) ** 2 + (yy2 - c) ** 2)
    R = PIPD / 2
    rgba = np.zeros((PIPD + 40, PIPD + 40, 4), np.float32)
    canvas = np.zeros((PIPD + 40, PIPD + 40, 3), np.float32); canvas[20:20 + PIPD, 20:20 + PIPD] = img
    inner = np.clip(R - dist, 0, 1)
    ringm = np.clip(R + ring - dist, 0, 1) - inner
    shad = np.clip(1 - (dist - R) / 20, 0, 1) * 0.5 * (dist >= R)
    a_img = inner
    col = np.array(ORANGE[::-1], np.float32)
    rgba[..., :3] = canvas * inner[..., None] + col * ringm[..., None]
    rgba[..., 3] = np.maximum(np.maximum(inner, ringm), shad) * 255
    rgba[..., :3] = np.where((inner + ringm)[..., None] > 0, rgba[..., :3] / np.maximum((inner + ringm)[..., None], 1e-3), 0)
    out = rgba.astype(np.uint8)
    if abs(scale - 1) > 1e-3:
        n = int(out.shape[0] * scale); out = cv2.resize(out, (n, n), interpolation=cv2.INTER_AREA)
    return out
def blit_bgra(fr, spr, cx, cy):
    h, w = spr.shape[:2]
    s = np.zeros((h, w, 4), np.uint8); s[..., :3] = spr[..., :3][..., ::-1]; s[..., 3] = spr[..., 3]
    blit(fr, s, int(cx - w / 2), int(cy - h / 2))
PIP_C = (44 + PIPD // 2 + 10, 560 + PIPD // 2)

# ---------- main loop ----------
shots = P['shots']; groups = P['groups']; ins_list = P['ins']
hook_end = P['hook_end']
RUNS = []
for sh_ in shots:
    if sh_['kind'] == 'broll':
        if RUNS and abs(RUNS[-1][1] - sh_['t0']) < 1e-6: RUNS[-1][1] = sh_['t1']
        else: RUNS.append([sh_['t0'], sh_['t1']])
print('runs', RUNS)
def shot_at(t):
    for i, s in enumerate(shots):
        if s['t0'] <= t + 1e-6 < s['t1']: return i, s
    return len(shots) - 1, shots[-1]
f_start = int(START * FPS); f_end = NF if LIMIT is None else min(NF, f_start + int(LIMIT * FPS))
proc = subprocess.Popen(['ffmpeg', '-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                         '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', OUT], stdin=subprocess.PIPE)
bgr_ring = (ORANGE[2], ORANGE[1], ORANGE[0])
for fi in range(f_start, f_end):
    t = fi / FPS
    si, sh = shot_at(t); dt = t - sh['t0']; sl = sh['t1'] - sh['t0']
    prog = dt / max(sl, 1e-3)
    breath = 1 + 0.006 * math.sin(2 * math.pi * t / 3.6)
    if sh['kind'] == 'pose':
        sc = (S_A if sh['plan'] == 'A' else S_B) * (1 + 0.02 * min(1.0, dt / 3.0)) * breath
        st = 'blink' if fi in blink else state[fi]
        dxs = 3 * math.sin(2 * math.pi * t / 5.0)
        base = char_layer(sh['src'], st, sc, dxs, 2 * math.sin(2 * math.pi * t / 3.6 + 1))
    else:
        sc = 1.0 + 0.05 * min(1.0, dt / 2.5) + (0.04 if sh['plan'] == 'B' else 0)
        base = broll_frame(sh['src'], dt, sc)
    base = np.clip(base.astype(np.float32) * (GRADE if sh['kind'] == 'pose' else GRADE_F) * TGRAD, 0, 255).astype(np.uint8)
    if sh['tr']: base = cam_fx(base, dt, sh['tr'])
    fr = base
    # permanent title
    blit(fr, TITLE, 0, TITLE_Y)
    if t >= hook_end:
        for gi, g in enumerate(groups):
            if g['s'] - 1e-3 <= t < g['e']:
                spr, hh = group_sprite(gi, t)
                top = min(1115, 1510 - hh)
                blit(fr, spr, 0, top - 80)
                break
    # inserts (top zone)
    for ins in ins_list:
        if ins['s'] <= t < ins['e']:
            al = min(1.0, (t - ins['s']) / 0.1 + 0.4, (ins['e'] - t) / 0.12)
            blit(fr, insert_sprite(ins, t), 0, 505 - 70, max(0, al))
    # pip: one run per contiguous footage block, below the title (top-left)
    run = next((r for r in RUNS if r[0] <= t < r[1]), None)
    if run:
        age = t - run[0]
        scl = 1.0 if age > 0.3 else (0.6 + 0.5 * age / 0.3 if age < 0.2 else 1.1 - 0.1 * (age - 0.2) / 0.1)
        if t > run[1] - 0.1: scl = max(0.0, (run[1] - t) / 0.1)
        st = 'blink' if fi in blink else state[fi]
        blit_bgra(fr, pip_sprite(st, max(scl, 0.05)), *PIP_C)
    proc.stdin.write(fr.tobytes())
    if fi % 150 == 0: print('frame', fi, '/', NF, flush=True)
proc.stdin.close(); proc.wait(); print('done')
