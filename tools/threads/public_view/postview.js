const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 900, height: 2400 } });
  await p.goto('https://www.threads.com'+process.argv[2], { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(6000);
  for(let i=0;i<3;i++){await p.mouse.wheel(0,2500);await p.waitForTimeout(2000);}
  const t=await p.evaluate(()=>document.body.innerText);
  console.log(t.replace(/\n+/g,' | ').slice(0,3500));
  const hs=await p.evaluate(()=>[...new Set([...document.querySelectorAll('a[href^="/@"]')].map(a=>a.getAttribute('href').split('/')[1]))]);
  console.log(hs.join(' '));
  await b.close();
})();
