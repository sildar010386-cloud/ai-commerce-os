import json,re,sys,statistics as st
from datetime import datetime,timedelta,timezone
H=sys.argv[1]
j=json.load(open(f'raw/{H.replace(".","_")}.json'))
def num(p,t):
    for b in p['btns']:
        if b['t']==t and b['n']:
            m=re.sub(r'[^\d.K]','',b['n'].split('\n')[0]); 
            try: return int(float(m[:-1])*1000) if m.endswith('K') else int(m)
            except: return 0
    return 0
def dt(p): return datetime.fromisoformat(p['datetime'].replace('Z','+00:00'))
ps=[p for p in j['posts'] if p['author']=='/@'+H]
# feed order; mark continuation: later datetime than previous top-level (feed newest first)
top=[];cont=[];prev=None;cur=None
for p in ps:
    if prev is not None and dt(p)>prev:
        cont.append((cur,p)); continue
    top.append(p); prev=dt(p); cur=p
    p['_cont']=[]
for c,p in cont: c['_cont'].append(p)
SELL=re.compile(r'цен[аы]|\d\s?(тг|тенге|₸|₽|р\b|руб)|стоимост|заказ|в наличии|предзаказ|код товара|каспи|kaspi|артикул|промокод|купи|скидк|акци|доставк|whatsapp|директ|direct|тапсырыс|бағасы|сатылым|жеңілдік|рассрочк|бонус|подарок|осталось|продано',re.I)
def txt(p): return p['text'].replace('\n---\n','\n')
def lang(t):
    kz=len(re.findall(r'[әіңғүұқөһӘІҢҒҮҰҚӨҺ]',t)); ru=len(re.findall(r'[а-яА-ЯёЁ]',t))
    kwords=len(re.findall(r'\b(мен|бар|және|үшін|бұл|қазақстан|жеткізу|сіз|біз|тегін|бүгін|қайырлы|кім|не|қай)\b',t.lower()))
    if kz>=3 or kwords>=2: return 'kk/mixed' if ru>40 and kz<6 else 'kk'
    return 'ru' if ru>0 else 'none'
A=lambda d:(d+timedelta(hours=5))
rows=[]
for p in top:
    t=txt(p); 
    rows.append(dict(permalink=p['permalink'],dt=p['datetime'],alm=A(dt(p)).strftime('%Y-%m-%d %H:%M'),likes=num(p,'Like'),replies=num(p,'Comment'),reposts=num(p,'Repost'),shares=num(p,'Share'),
      media='video' if p['media']['video'] else ('photo' if p['media']['img']>1 else ('photo' if p['media']['img']==1 else 'text')),imgs=p['media']['img'],link=p['media']['linkPreview']>0,
      text=t,len=len(t),selling=bool(SELL.search(t)),lang=lang(t),cont=len(p['_cont']),conttext=[txt(c) for c in p['_cont']]))
json.dump(rows,open(f'raw/{H.replace(".","_")}_analysis.json','w'),ensure_ascii=False,indent=1)
n=len(rows)
print('##',H,'followers/header:',re.sub(r'\n',' | ',j['header'])[:260])
print('top-level',n,'continuation posts',len(cont),'raw containers',len(ps),'window',rows[-1]['alm'],'->',rows[0]['alm'],'(Almaty)')
days={}
for r in rows: days.setdefault(r['alm'][:10],0); days[r['alm'][:10]]+=1
d=sorted(days.items()); 
first=datetime.fromisoformat(rows[-1]['alm'][:10]); last=datetime.fromisoformat(rows[0]['alm'][:10]); span=(last-first).days+1
allc=[days.get((first+timedelta(days=i)).strftime('%Y-%m-%d'),0) for i in range(span)]
print('calendar days span',span,'per day (incl zero days) min/med/max',min(allc),st.median(allc),max(allc),'active days',len(days))
hrs={}
for r in rows: hrs[int(r['alm'][11:13])]=hrs.get(int(r['alm'][11:13]),0)+1
print('hours Almaty',sorted(hrs.items()))
print('single-post threads',sum(1 for r in rows if r['cont']==0),'multi',sum(1 for r in rows if r['cont']>0),'chains',[r['cont']+1 for r in rows if r['cont']>0])
from collections import Counter
print('media',Counter(r['media'] for r in rows),'link previews',sum(r['link'] for r in rows))
print('lang',Counter(r['lang'] for r in rows))
print('len median',st.median([r['len'] for r in rows]))
sell=[r for r in rows if r['selling']];reach=[r for r in rows if not r['selling']]
def stat(rs,k): 
    v=[r[k] for r in rs]; return (st.median(v),max(v)) if v else None
for name,rs in (('all',rows),('selling',sell),('reach',reach),('text-only',[r for r in rows if r['media']=='text']),('with-media',[r for r in rows if r['media']!='text'])):
    print(name,len(rs),'likes med/max',stat(rs,'likes'),'replies',stat(rs,'replies'),'reposts',stat(rs,'reposts'),'shares',stat(rs,'shares'))
print('TOP5 likes');[print(' ',r['alm'],r['likes'],r['replies'],r['reposts'],r['shares'],r['permalink'],'|',r['text'][:200].replace('\n',' / ')) for r in sorted(rows,key=lambda r:-r['likes'])[:5]]
print('TOP5 replies');[print(' ',r['alm'],r['likes'],r['replies'],r['reposts'],r['shares'],r['permalink'],'|',r['text'][:200].replace('\n',' / ')) for r in sorted(rows,key=lambda r:-r['replies'])[:5]]
print('WEAKEST5');[print(' ',r['alm'],r['likes'],r['replies'],r['permalink'],'|',r['text'][:100].replace('\n',' / ')) for r in sorted(rows,key=lambda r:(r['likes']+r['replies']))[:5]]
print('FIRST LINES');[print(' ',('S' if r['selling'] else 'R'),r['text'].split('\n')[0][:110]) for r in rows[:15]]
# replies tab
try:
    k=json.load(open(f'raw/{H.replace(".","_")}_replies.json'))
    mine=[p for p in k['posts'] if p['author']=='/@'+H]
    print('REPLIES TAB: containers',len(k['posts']),'authored by shop',len(mine),'dates',min(p['datetime'] for p in mine) if mine else None,max(p['datetime'] for p in mine) if mine else None, 'median chars',st.median([len(txt(p)) for p in mine]) if mine else None)
    for p in mine[:8]: print('   ',p['datetime'][:16],'L',num(p,'Like'),'|',txt(p)[:120].replace('\n',' / '))
except Exception as e: print('no replies',e)
