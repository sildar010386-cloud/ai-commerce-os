"""Reel 01 plan: words, caption groups, shots, inserts, sfx events -> plan.json"""
import json, re
words = [w for w in json.load(open('/tmp/facework/reel02/v21.words.json')) if re.search(r'\w', w[0])]
FPS = 30
DUR = 46.39
HOOK_END = 3.70
def norm(s): return re.sub(r'[^\w]', '', s.lower().replace('ё', 'е'))

GROUPS = [
 "мы *годами достаём", "эту доску", "раскладываем посреди комнаты", "ищем розетку", "ждём пока нагреется утюг",
 "доска громоздкая", "шнур путается", "подставка то и дело падает", "и всё это ради одной *рубашки",
 "а потом доску", "надо сложить и убрать", "*каждый *раз", "поэтому гладить хочется", "как можно реже",
 "и вещи *копятся", "а можно *иначе", "есть ручной отпариватель", "он греется всего за", "**девять=9 **секунд",
 "нажали и пошёл *пар", "*два=2 *в=В *одном=1", "хотите *прижмите как утюг", "хотите *ведите паром",
 "рубашка висит на вешалке", "**доска /**не **нужна", "прибор небольшой", "он складывается в маленькую", "*коробку",
 "доставка казпочтой", "по всему казахстану", "*бесплатная", "хотите так же без доски", "напишите **пар в комментариях",
]
# skip the words hidden under the hook
wi = 0
while words[wi][1] < HOOK_END - 0.001: wi += 1
groups = []
for g in GROUPS:
    toks = []; brk = False
    for raw in g.split():
        if raw == '/': brk = True; continue
        if raw.startswith('/'): brk = True; raw = raw[1:]
        lvl = 2 if raw.startswith('**') else (1 if raw.startswith('*') else 0)
        raw = raw.lstrip('*')
        disp = None
        if '=' in raw: raw, disp = raw.split('=')
        w = words[wi]; assert norm(w[0]) == norm(raw), (w, raw)
        wi += 1
        disp = disp or raw
        toks.append(dict(text=disp.upper() if lvl else disp, lvl=lvl, s=w[1], e=w[2], brk=brk)); brk = False
    groups.append(dict(toks=toks))
assert wi == len(words), (wi, len(words))
for i, g in enumerate(groups):
    s = g['toks'][0]['s']; e = g['toks'][-1]['e']
    nxt = groups[i + 1]['toks'][0]['s'] if i + 1 < len(groups) else DUR
    g['s'] = s; g['e'] = min(nxt - 2 / FPS, e + 0.7, DUR)

# shots: (t0, kind, pose|clip, plan, transition)
TR = ['swipe_l', 'pop', 'whip_up', 'pull', 'flash', 'swipe_r', 'tilt', 'pop_fast']
S = [
 (0.00, 'pose', '01'), (1.50, 'broll', 'g_s1:0'), (3.01, 'pose', '02'), (5.65, 'pose', '07'), (7.30, 'pose', '04'), (8.80, 'pose', '04'),
 (10.19, 'pose', '08'), (12.20, 'pose', '07'), (14.01, 'broll', 'g_s2:0'), (16.00, 'pose', '03'), (18.32, 'pose', '08'), (19.45, 'pose', '02'),
 (22.00, 'broll', 'g_s3:0'), (23.22, 'broll', 'c1:0.2'), (24.32, 'broll', 'g_s4:0'), (25.90, 'broll', 'c1:3.4@1.8'), (28.10, 'broll', 'g_s5:0'),
 (29.85, 'broll', 'c4:6.0'), (31.32, 'broll', 'c4:14.0'), (32.66, 'broll', 'g_s6:0'), (34.17, 'broll', 'g_s7:0'), (36.61, 'broll', 'c2:11.0'),
 (37.73, 'broll', 'g_s8:0'), (39.00, 'broll', 'g_s9:0'), (40.80, 'broll', 'g_s10:0'), (42.85, 'pose', '09'), (44.41, 'pose', '05'), (45.40, 'pose', '05'),
]
shots = []
for i, (t0, kind, src) in enumerate(S):
    plan = 'A' if i % 2 == 0 else 'B'
    t1 = S[i + 1][0] if i + 1 < len(S) else DUR
    shots.append(dict(t0=t0, t1=t1, kind=kind, src=src, plan=plan, tr=None if i == 0 else TR[(i - 1) % 8]))
BROLL_FROM, BROLL_TO = 23.14, 35.97

# top-zone inserts: items (text, t_appear)
INS = [
 dict(style='line', s=7.65, e=10.10, items=[("РОЗЕТКА", 7.65), ("УТЮГ", 9.36)]),
 dict(style='line', s=10.19, e=13.95, items=[("ДОСКА", 10.19), ("ШНУР", 11.33), ("ПОДСТАВКА", 12.20)]),
 dict(style='title', s=24.64, e=25.88, items=[("РУЧНОЙ ОТПАРИВАТЕЛЬ", 24.64)]),
 dict(style='line', s=39.69, e=41.85, items=[("ДОСТАВКА КАЗПОЧТОЙ", 39.69)]),
]

# sfx events: (time of the word/cut, kind, priority)
ev = []
cutkind = {'swipe_l': 'whoosh', 'swipe_r': 'whoosh', 'whip_up': 'whoosh', 'pull': 'whoosh', 'tilt': 'whoosh',
           'pop': 'pop', 'pop_fast': 'pop', 'flash': 'flash'}
for sh in shots:
    if sh['tr']: ev.append((sh['t0'], cutkind[sh['tr']], 2))
for g in groups:
    for t in g['toks']:
        if t['lvl'] == 2: ev.append((t['s'], 'boom', 3))
        elif t['lvl'] == 1 and not (t['text'] in ('В', '1', 'РАЗ')): ev.append((t['s'], 'click', 1))
for ins in INS:
    for k, (txt, ta) in enumerate(ins['items']): ev.append((ta, 'ding' if ins['style'] == 'title' else 'click', 2.5 if ins['style'] == 'title' else 1))
ev.sort(key=lambda x: (x[0], -x[2]))
kept = []
for t, k, p in ev:
    if kept and t - kept[-1][0] < 0.9:
        if p > kept[-1][2]: kept[-1] = (t, k, p)
        continue
    kept.append((t, k, p))
kept.append((44.97 - 2.0, 'riser', 3))   # ends on the word "пар"
print(len(kept), 'sfx events')
json.dump(dict(words=words, groups=groups, shots=shots, ins=INS, sfx=kept, dur=DUR, hook_end=HOOK_END, broll=[BROLL_FROM, BROLL_TO]),
          open('/tmp/facework/reel02/plan.json', 'w'), ensure_ascii=False, indent=1)
for g in groups: print(round(g['s'], 2), round(g['e'], 2), ' '.join(('*' * t['lvl']) + t['text'] for t in g['toks']))
print([ (round(a,2),b) for a,b,c in kept])
