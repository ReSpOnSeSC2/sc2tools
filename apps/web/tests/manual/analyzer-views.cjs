/* Run from apps/web after the production build: node tests/manual/analyzer-views.cjs.
 * Actual components and final production CSS, synthetic data only. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');
execFileSync(process.execPath, ['tests/manual/analyzer-views-fixture.cjs'], { stdio: 'inherit' });
const web = process.cwd(), repo = path.resolve(web, '../..'), origin = 'http://127.0.0.1:3227';
const css = fs.readdirSync('.next/static/css').filter(name => name.endsWith('.css')).map(name => fs.readFileSync(path.join('.next/static/css', name), 'utf8')).join('\n');
const fonts = "@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2')}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2')}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay}body{font-family:FixtureSans,sans-serif}";
const html = `<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body class="bg-bg text-text"><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const server = http.createServer((req,res) => {
  const url = new URL(req.url, origin);
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type','text/javascript'); return res.end(fs.readFileSync(path.join(repo,'.cache/analyzer-views-fixture.js'))); }
  if (url.pathname.startsWith('/app')) { res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(html); }
  if (url.pathname.startsWith('/fonts/')) {
    const base = path.resolve(web,'app/fonts'), file = path.resolve(base,url.pathname.slice(7));
    if (file.startsWith(base+path.sep) && fs.existsSync(file)) { res.setHeader('Content-Type','font/woff2'); return res.end(fs.readFileSync(file)); }
  }
  res.statusCode=404; res.end();
});
let checks=0;
(async()=>{
  await new Promise(resolve=>server.listen(3227,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try {
    for(const width of (process.env.VIEWS_FIXTURE_WIDTHS ? process.env.VIEWS_FIXTURE_WIDTHS.split(',').map(Number) : [320,390,768,1440])) {
      const context=await browser.newContext({viewport:{width,height:1000},hasTouch:true});
      const errors=[],external=[];
      await context.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort()});
      await context.addInitScript(()=>{
        localStorage.setItem('analyzer.filters',JSON.stringify({preset:'last_30d',race:'T',regions:'NA',regions_rev:1}));
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(!window.fixtureClipboardOk)throw Error('Synthetic denied clipboard');window.fixtureCopied=text}}});
      });
      const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin+'/app/maps?filters=1&preset=all&race=P&opp_race=Z&regions=EU&token=private-fixture-token');
      await expect.poll(()=>page.evaluate(()=>window.fixtureFilters?.race)).toBe('P').catch(async error=>{console.error(JSON.stringify({width,errors,url:page.url(),text:(await page.locator('body').innerText()).slice(0,2500)}));throw error});checks++;
      const stored=await page.evaluate(()=>localStorage.getItem('analyzer.filters'));
      await page.getByRole('button',{name:'Copy link to this view',exact:true}).tap();
      const fallback=page.getByLabel('Copy this view link');await expect(fallback).toBeFocused();
      const copied=new URL(await fallback.inputValue());
      if(copied.searchParams.get('race')!=='P'||copied.searchParams.get('regions')!=='EU'||copied.toString().includes('private-fixture-token'))throw Error('Copied cohort/privacy mismatch');checks++;
      await page.evaluate(()=>window.fixtureClipboardOk=true);await page.getByRole('button',{name:'Copy link to this view',exact:true}).tap();
      await expect(page.getByText('View link copied.',{exact:true})).toBeVisible();checks++;
      await page.getByRole('button',{name:'Views',exact:true}).tap();const dialog=page.getByRole('dialog',{name:'Saved views',exact:true});await expect(dialog).toBeVisible();checks++;
      const field=dialog.getByLabel('View name',{exact:true});await field.fill('PvZ Europe');await page.evaluate(()=>window.fixtureFailNext=true);await field.press('Enter');
      await expect(dialog.getByRole('alert')).toHaveText('Fixture temporarily unavailable');await expect(field).toHaveValue('PvZ Europe');checks++;
      await field.press('Enter');await expect(dialog.getByText('View saved.',{exact:true})).toBeVisible();checks++;
      const writes=await page.evaluate(()=>window.fixtureWrites.length);
      await field.fill('PVZ EUROPE');await field.press('Enter');await expect(dialog.getByRole('alert')).toHaveText('A view with that name already exists.');
      if(await page.evaluate(()=>window.fixtureWrites.length)!==writes)throw Error('Duplicate name wrote preferences');checks++;
      await dialog.getByRole('button',{name:'Rename PvZ Europe',exact:true}).tap();const rename=dialog.getByLabel('Rename view',{exact:true});await rename.fill('Reviewed Europe view');await rename.press('Enter');
      await expect(dialog.getByText('View renamed.',{exact:true})).toBeVisible();checks++;
      await dialog.getByRole('button',{name:'Set Reviewed Europe view as default',exact:true}).tap();await expect(dialog.getByText('Default view set.',{exact:true})).toBeVisible();checks++;
      const target=await page.evaluate(()=>window.fixtureResolveHome({},false));const defaultUrl=new URL(target,origin);
      if(defaultUrl.pathname!=='/app/maps'||defaultUrl.searchParams.get('race')!=='P'||defaultUrl.searchParams.get('regions')!=='EU')throw Error('Actual default-page handler changed cohort');checks++;
      const lookup=await page.evaluate(()=>window.fixtureDefaultLookups);
      if(await page.evaluate(()=>window.fixtureResolveHome({},true))!==null)throw Error('Default reapplied inside session');
      if(await page.evaluate(()=>window.fixtureResolveHome({filters:'1'},false))!==null)throw Error('Default overrode explicit empty URL');
      if(await page.evaluate(()=>window.fixtureDefaultLookups)!==lookup)throw Error('Default lookup added session/explicit-query requests');checks++;
      const controls=await dialog.getByRole('button').evaluateAll(nodes=>nodes.map(node=>({label:node.textContent,height:node.getBoundingClientRect().height})).filter(row=>row.height>0));
      if(controls.some(row=>row.height<43))throw Error('Small dialog touch target:'+JSON.stringify(controls));checks++;
      for(const theme of ['dark','light']){
        await page.evaluate(value=>document.documentElement.setAttribute('data-theme',value),theme);
        // Let the real color transitions finish before assessing the theme.
        await page.waitForTimeout(250);
        const contrast=await dialog.getByRole('button').evaluateAll(nodes=>{
          const rgb=value=>value.match(/[\d.]+/g)?.map(Number)||[];
          const luminance=channels=>channels.slice(0,3).map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4}).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
          return nodes.filter(node=>node.textContent.trim()).map(node=>{
            let parent=node,background=[];
            while(parent){const value=rgb(getComputedStyle(parent).backgroundColor);if(value.length===3||value[3]>0){background=value;break}parent=parent.parentElement}
            const a=luminance(rgb(getComputedStyle(node).color)),b=luminance(background);
            return{label:node.textContent,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
          });
        });
        if(contrast.some(row=>!Number.isFinite(row.ratio)||row.ratio<4.5))throw Error('Button contrast:'+JSON.stringify({width,theme,contrast}));
        await page.screenshot({path:path.join(repo,`docs/handoff/screenshots/analyzer-views-${theme}-${width}.png`),fullPage:false});checks++;
      }
      await dialog.getByRole('button',{name:'Clear default view',exact:true}).tap();await expect(dialog.getByText('Default view cleared.',{exact:true})).toBeVisible();checks++;
      await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Views',exact:true})).toBeFocused();
      await page.getByRole('button',{name:'Views',exact:true}).press('Enter');await expect(dialog).toBeVisible();checks++;
      await dialog.getByRole('button',{name:'Delete Reviewed Europe view',exact:true}).tap();await expect(dialog.getByText('View deleted.',{exact:true})).toBeVisible();checks++;
      await dialog.getByRole('button',{name:'Apply Other matchup',exact:true}).tap();await expect(dialog).toHaveCount(0);
      await expect.poll(()=>page.evaluate(()=>window.fixtureFilters?.race)).toBe('Z');await expect(page).toHaveURL(/\/app\/macro\?/);checks++;
      await page.evaluate(()=>window.fixtureNavigate('/app/maps?filters=1&preset=all&race=P','push'));await expect.poll(()=>page.evaluate(()=>window.fixtureFilters?.race)).toBe('P');
      await page.evaluate(()=>window.fixtureNavigate('/app/maps?filters=1&preset=all&race=Z','push'));await expect.poll(()=>page.evaluate(()=>window.fixtureFilters?.race)).toBe('Z');
      await page.goBack();await expect.poll(()=>page.evaluate(()=>window.fixtureFilters?.race)).toBe('P');await page.goForward();await expect.poll(()=>page.evaluate(()=>window.fixtureFilters?.race)).toBe('Z');checks++;
      await page.getByRole('button',{name:'Fixture Terran',exact:true}).tap();await page.evaluate(()=>window.fixtureNavigate('/app/maps?filters=1&preset=all&race=P','push',450));
      await expect.poll(()=>page.evaluate(()=>window.fixtureFilters?.race)).toBe('P');await page.waitForTimeout(550);
      if(new URL(page.url()).searchParams.get('race')!=='P')throw Error('Pending timer overwrote incoming cohort');checks++;
      if(await page.evaluate(()=>localStorage.getItem('analyzer.filters'))!==stored)throw Error('Shared URL state persisted into recipient storage');checks++;
      await page.evaluate(()=>window.fixtureNavigate('/app/maps?filters=1&map=Sanctuary%20II&map_exact=broken','push'));
      await expect(page.getByRole('alert')).toContainText('invalid exact map cohort');await expect(page.getByRole('heading',{name:'Your filtered history',exact:true})).toHaveCount(0);checks++;
      await page.getByRole('button',{name:'Use current filters',exact:true}).tap();await expect(page.getByRole('heading',{name:'Your filtered history',exact:true})).toBeVisible();checks++;
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
      if(overflow||errors.length||external.length)throw Error(JSON.stringify({width,overflow,errors,external}));checks++;
      await page.goto(origin+'/app/maps');await expect.poll(()=>page.evaluate(()=>window.fixtureFilters?.race)).toBe('T');
      await page.getByRole('button',{name:'Fixture Protoss',exact:true}).tap();
      if(await page.evaluate(()=>JSON.parse(localStorage.getItem('analyzer.filters')).race)!=='P')throw Error('Normal manual filter selection stopped persisting');checks++;
      console.log(JSON.stringify({width,checks,overflow,errors,external}));await context.close();
    }
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
  console.log(`${checks} saved-view browser checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
