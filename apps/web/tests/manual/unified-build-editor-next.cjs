/* Actual Next/webpack public landing consumer. The real browser engine parses
 * the committed replay; one editor chunk fails, then recovers without upload. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process'),{chromium,expect}=require('@playwright/test');
const root=process.cwd();let child,browser,api,logs='';
async function port(){const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value}
(async()=>{
  api=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end('{}')});await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  const number=await port(),origin=`http://localhost:${number}`,apiOrigin=`http://127.0.0.1:${api.address().port}`;
  const pageFile=fs.readdirSync('.next/static/chunks/app').find(file=>/^page-.*\.js$/.test(file));
  const code=fs.readFileSync(path.join('.next/static/chunks/app',pageFile),'utf8');
  const loader=code.match(/Promise\.all\(\[([^\]]+)\]\)\.then\([^;]{0,100}\.BuildEditorModal\)/);
  if(!loader)throw new Error('Could not locate actual editor chunk loader');
  const ids=[...loader[1].matchAll(/\.e\((\d+)\)/g)].map(match=>match[1]),seen=[],failed=[];
  child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p',String(number),'-H','localhost'],{cwd:root,windowsHide:true,env:{...process.env,SC2TOOLS_API_BASE:apiOrigin,CLERK_SECRET_KEY:'sk_live_dummy',NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:'pk_live_Y2xlcmsuZXhhbXBsZS5jb20k'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{logs+=chunk});child.stderr.on('data',chunk=>{logs+=chunk});
  await new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('Next startup timeout: '+logs.slice(-1000))),30000);const check=()=>{if(logs.includes('Ready in')){clearTimeout(deadline);resolve()}else if(child.exitCode!==null){clearTimeout(deadline);reject(new Error('Next exited: '+logs.slice(-1000)))}else setTimeout(check,100)};check()});
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:960}}),page=await context.newPage();let failChunk=false,previewReads=0;const apiRequests=[],uploads=[];
  page.on('request',request=>{const url=new URL(request.url());if(url.origin===apiOrigin||url.pathname.startsWith('/v1/'))apiRequests.push({method:request.method(),path:url.pathname});if((request.postDataBuffer()?.byteLength??0)>32000)uploads.push(request.url())});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/v1/public/preview-replay'){previewReads++;return route.abort()}
    if(url.origin===origin){
      const candidate=ids.some(id=>new RegExp(`/chunks/${id}[.-]`).test(url.pathname));
      if(candidate){seen.push(url.pathname);if(failChunk){failChunk=false;failed.push(url.pathname);return route.abort('failed')}}
      return route.continue();
    }
    return route.abort();
  });
  await page.goto(origin,{waitUntil:'domcontentloaded'});const demo=page.getByRole('heading',{name:'Turn a replay into a custom build'}).locator('..').locator('..');
  await expect(demo).toBeVisible();expect(seen).toEqual([]);
  await expect(demo.getByText('Runs in your browser — the replay never leaves your device.')).toBeVisible();
  const reject=page.getByRole('button',{name:'Reject',exact:true});if(await reject.isVisible())await reject.click();
  await demo.locator('input[type=file]').setInputFiles(path.resolve('../replay-engine/tests/fixtures/replays/warpgate_adept_tracking.SC2Replay'));
  await expect(page.getByRole('heading',{name:'Which player are you?'})).toBeVisible({timeout:120000});
  // Shared chunks may also serve the analyzer. Only fail after that real
  // analyzer is ready, so this remains an editor-import recovery specimen.
  failChunk=true;
  await page.getByRole('button',{name:/ReSpOnSe.*Protoss/}).click();
  await expect(page.getByRole('dialog',{name:'Build editor could not load'})).toBeVisible({timeout:120000});expect(failed).toHaveLength(1);expect(previewReads).toBe(0);
  await page.getByRole('button',{name:'Retry editor'}).click();await expect(page.getByRole('textbox',{name:/^Name/})).toBeVisible();
  await expect(page.getByText(/Demo: rules and preview are local/)).toBeVisible();expect(seen.filter(file=>file===failed[0])).toHaveLength(2);expect(previewReads).toBe(0);
  await expect(page.getByRole('button',{name:/Add rule:/}).first()).toBeVisible();
  expect(apiRequests).toEqual([]);expect(uploads).toEqual([]);
  console.log(JSON.stringify({result:'PASS',checks:{realLandingParse:true,editorRetry:true,ruleControls:true,noPreviewRequests:true,noApiRequests:true,noReplayUploads:true},failedChunk:failed[0],editorChunkRequests:seen.length,previewReads,apiRequests,uploads,boundary:'Actual local Next/worker/replay/editor; only dummy auth/API and one intentional editor chunk failure. No server-preview fixture.'}));await context.close();
})().catch(error=>{console.error(error);console.error(logs.slice(-2000));process.exitCode=1}).finally(async()=>{
  await browser?.close();
  if(child&&child.exitCode===null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill();await closed}
  if(api){api.closeAllConnections();await new Promise(resolve=>api.close(resolve))}
});
