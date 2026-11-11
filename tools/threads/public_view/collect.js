// usage: node collect.js HANDLE [tab]  -> raw/HANDLE[_tab].json
const { chromium } = require('playwright');
const fs=require('fs');
(async () => {
  const h=process.argv[2], tab=process.argv[3]||'';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 900, height: 2400 } });
  await p.goto('https://www.threads.com/@'+h+(tab?'/'+tab:''), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(6000);
  if(!tab) await p.screenshot({ path: 'shots/'+h.replace(/\W/g,'_')+'.png' });
  const extract = () => p.evaluate(()=>{
    const out=[];
    document.querySelectorAll('div[data-pressable-container="true"]').forEach(c=>{
      const t=c.querySelector('time'); if(!t) return;
      const a=t.closest('a'); 
      const author=(c.querySelector('a[href^="/@"]')||{}).getAttribute?.('href')||'';
      const spans=[...c.querySelectorAll('span[dir="auto"]')].filter(s=>!s.closest('a')&&s.innerText.length>0&&!s.querySelector('time'));
      const text=spans.map(s=>s.innerText).join('\n---\n');
      const btns=[...c.querySelectorAll('svg[title]')].map(s=>{
        const b=s.closest('[role="button"]')||s.parentElement; return {t:s.getAttribute('title'), n:(b&&b.innerText||'').trim()};});
      const big=[...c.querySelectorAll('img')].filter(i=>!/profile picture/.test(i.alt||'')&&i.getBoundingClientRect().width>=120); const media={img:big.length, video:c.querySelectorAll('video').length, linkPreview:[...c.querySelectorAll('a[href^="https://l.threads.com"]')].length};
      const ext=[...c.querySelectorAll('a[href]')].map(x=>x.getAttribute('href')).filter(x=>!x.startsWith('/@')&&!x.startsWith('/')).slice(0,3);
      const label=(t.querySelector('abbr')||{}).innerText;
      out.push({author, permalink:a?a.getAttribute('href'):'', datetime:t.getAttribute('datetime'), label, text, btns, media, ext, full:c.innerText.slice(0,3000)});
    });
    return out;});
  let all=new Map();
  for(let i=0;i<14;i++){
    for(const x of await extract()) all.set(x.permalink+'|'+x.datetime+'|'+x.text.slice(0,30), x);
    const before=all.size;
    await p.mouse.wheel(0,2500); await p.waitForTimeout(2500);
    for(const x of await extract()) all.set(x.permalink+'|'+x.datetime+'|'+x.text.slice(0,30), x);
    if(all.size===before && i>1) break;
  }
  const body=await p.evaluate(()=>document.body.innerText);
  const hdr=body.slice(0,700);
  fs.writeFileSync('raw/'+h.replace(/\W/g,'_')+(tab?'_'+tab:'')+'.json', JSON.stringify({handle:h,tab,collectedAt:new Date().toISOString(),header:hdr,loginWall:/Log in to see more/.test(body),posts:[...all.values()]},null,1));
  console.log(h,tab,'posts',all.size,'loginwall',/Log in to see more/.test(body));
  await b.close();
})();
