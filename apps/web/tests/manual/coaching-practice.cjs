/* Actual coaching workspace/clientApi, local synthetic owner/plans only.
 * Run from apps/web after production build. Nonlocal requests are blocked. */
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),esbuild=require('esbuild');
const {chromium,expect}=require('@playwright/test');
const root=process.cwd(),origin='http://127.0.0.1:3246',now='2026-09-24T12:00:00.000Z',writes=[];
fs.mkdirSync('.tmp',{recursive:true});
const students=[{id:'alex',name:'Alex',userId:'alex-user'},{id:'blair',name:'Blair',userId:'blair-user'}];
const buckets=[1,8,15,22,29].map((day,index)=>({key:'period-'+index,startsAt:'2026-09-'+String(day).padStart(2,'0')+'T00:00:00Z',endsAt:index===4?'2026-10-06T00:00:00Z':'2026-09-'+String(day+7).padStart(2,'0')+'T00:00:00Z',playedGames:index<3?5:0,requiredGames:5,remainingGames:index<3?0:5,complete:index<3}));
const base={id:'weekly-alex',rev:1,status:'active',student:students[0],coach:{id:'coach',name:'Coach'},createdAt:'2026-09-01T00:00:00Z',updatedAt:now,requirement:{type:'total',requiredGames:5,recurrence:'weekly',timeZone:'America/New_York',build:null,title:'Weekly macro practice',note:'Keep the scout alive and review the replay.',window:{startsOn:'2026-09-01',endsOn:'2026-10-05',startsAt:'2026-09-01T00:00:00Z',endsAt:'2026-10-06T00:00:00Z',endExclusive:true}},progress:{state:'active',playedGames:15,requiredGamesTotal:25,completedBuckets:3,totalBuckets:5,currentBucket:buckets[3],buckets,games:[],replayGames:[],replayGameCount:15,gamesTruncated:false,lastGameAt:'2026-09-23T17:00:00Z'}};
const plans=[base,{...base,id:'weekly-blair',student:students[1],requirement:{...base.requirement,title:'Blair weekly games'},progress:{...base.progress,currentBucket:{...buckets[3],playedGames:4},lastGameAt:null}},
 {...base,id:'ended',requirement:{...base.requirement,title:'Earlier plan',window:{...base.requirement.window,endsAt:'2026-09-20T00:00:00Z'}},progress:{...base.progress,state:'missed',currentBucket:null}},
 {...base,id:'cancelled',status:'cancelled',requirement:{...base.requirement,type:'build',recurrence:'once',build:{id:'removed',name:'Retired opener',matchBy:'slug'},title:'Cancelled opener',window:{startsOn:'2026-09-14',endsOn:'2026-09-20',startsAt:'2026-09-14T00:00:00Z',endsAt:'2026-09-21T00:00:00Z',endExclusive:true}},progress:{...base.progress,state:'cancelled',currentBucket:null}},
 {...base,id:'upcoming',requirement:{...base.requirement,title:'Next practice window',window:{...base.requirement.window,startsAt:'2026-10-01T00:00:00Z'}},progress:{...base.progress,state:'upcoming',currentBucket:null}}];
const stateOf=plan=>plan.status==='cancelled'?'cancelled':Date.parse(plan.requirement.window.startsAt)>Date.parse(now)?'upcoming':Date.parse(plan.requirement.window.endsAt)<=Date.parse(now)?'ended':'active';
let evidenceFailed=false;
const json=(res,data,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(data))};
const boundaries={
 '@clerk/nextjs':"const auth={isLoaded:true,isSignedIn:true,userId:'local-coach',getToken:async()=>'local-jwt'};export const useAuth=()=>auth;",
 '@/lib/useUserSocket':"export const useUserSocket=()=>{};",
 'next/link':"import React from'react';export default function Link({href,children,prefetch,scroll,...props}){return <a href={href} {...props}>{children}</a>}",
};
(async()=>{
 await esbuild.build({stdin:{contents:"import React from'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';import{ToastProvider}from'@/components/ui/Toast';import CoachingPractice from'@/app/coaching/CoachingPractice';createRoot(document.getElementById('root')).render(<SWRConfig value={{provider:()=>new Map(),shouldRetryOnError:false,revalidateOnFocus:false}}><ToastProvider><main className='mx-auto min-w-0 max-w-6xl p-4 pb-12'><h1 className='mb-5 text-h2 font-semibold'>Coaching practice</h1><CoachingPractice role='coach'/></main></ToastProvider></SWRConfig>);",loader:'tsx',resolveDir:root},bundle:true,outfile:'.tmp/coaching-practice-fixture.js',alias:{'@':root},jsx:'automatic',plugins:[{name:'local-auth-only',setup(build){build.onResolve({filter:/.*/},args=>boundaries[args.path]?{path:args.path,namespace:'fixture'}:undefined);build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:boundaries[args.path],loader:'tsx',resolveDir:root}))}}],define:{'process.env.NODE_ENV':'"production"','process.env.NEXT_PUBLIC_API_BASE':JSON.stringify(origin)},logLevel:'warning'});
 const css=fs.readdirSync('.next/static/css',{recursive:true}).filter(name=>name.endsWith('.css')).map(name=>fs.readFileSync(path.join('.next/static/css',name),'utf8')).join('\n');
 const fonts="@font-face{font-family:FixtureSans;src:url('/fonts/hanken-grotesk-latin.woff2');font-weight:100 900}@font-face{font-family:FixtureDisplay;src:url('/fonts/bricolage-grotesque-latin.woff2');font-weight:100 900}:root{--font-sans:FixtureSans;--font-display:FixtureDisplay;--font-serif:serif}";
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,origin);
  if(url.pathname==='/v1/coaching/state')return json(res,{state:{students}});
  if(url.pathname==='/v1/coaching/practice-sharing')return json(res,{rev:1,relationships:students.map(student=>({student,coach:base.coach,status:'accepted'}))});
  if(url.pathname==='/v1/coaching/assignments'){
   const scoped=plans.filter(plan=>!url.searchParams.get('studentId')||plan.student.id===url.searchParams.get('studentId')),counts={all:scoped.length};for(const state of ['active','upcoming','ended','cancelled'])counts[state]=scoped.filter(plan=>stateOf(plan)===state).length;
   return json(res,{serverTime:now,assignments:scoped.filter(plan=>!url.searchParams.get('state')||stateOf(plan)===url.searchParams.get('state')),counts,page:Number(url.searchParams.get('page')||1),limit:Number(url.searchParams.get('limit')||20),hasMore:false});
  }
  if(/^\/v1\/coaching\/students\/[^/]+\/games$/.test(url.pathname))return json(res,{games:[]});
  if(/^\/v1\/coaching\/assignments\/[^/]+\/games$/.test(url.pathname)){
   if(!evidenceFailed){evidenceFailed=true;return json(res,{error:{code:'local_busy',message:'Synthetic retry state'}},503)}
   return json(res,{assignmentId:base.id,page:1,limit:25,total:7,wins:4,losses:3,hasMore:false,games:[{gameId:'local-replay',date:'2026-09-23T17:00:00Z',map:'Synthetic map',opponent:'Local partner',result:'Victory',myBuild:'Recorded opener',isLadderGame:true,matchFormat:'1v1',replayAvailable:false}]});
  }
  if(req.method==='POST'){let body='';req.on('data',chunk=>body+=chunk);return req.on('end',()=>{writes.push({path:url.pathname,body:JSON.parse(body)});json(res,{assignment:base},201)})}
  if(url.pathname==='/fixture.js'){res.setHeader('content-type','text/javascript;charset=utf-8');return res.end(fs.readFileSync('.tmp/coaching-practice-fixture.js'))}
  if(url.pathname.startsWith('/fonts/')){res.setHeader('content-type','font/woff2');return res.end(fs.readFileSync(path.join('app',url.pathname)))}
  if(url.pathname.startsWith('/v1/'))return json(res,{error:{code:'unexpected_local_request'}},404);
  res.setHeader('content-type','text/html;charset=utf-8');res.end('<!doctype html><html data-theme="'+(url.searchParams.get('theme')==='dark'?'dark':'light')+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'\n'+fonts+'</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
 });
 await new Promise(resolve=>server.listen(3246,'127.0.0.1',resolve));const browser=await chromium.launch({headless:true});let checks=0;
 try{
  for(const width of [375,1440])for(const theme of ['light','dark']){
   evidenceFailed=false;const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.goto(origin+'/?theme='+theme);await expect(page.getByRole('region',{name:'Practice roster'})).toBeVisible();await expect(page.getByRole('combobox',{name:'Practice plan player'})).toHaveValue('');checks++;
   await expect(page.getByRole('region',{name:'Practice roster'}).getByText(/Behind schedule/).first()).toBeVisible();await page.evaluate(()=>document.fonts.ready);await page.getByRole('region',{name:'Practice roster'}).scrollIntoViewIfNeeded();await page.screenshot({path:'../../docs/handoff/screenshots/coaching-roster-'+theme+'-'+width+'.png'});checks++;
   await page.getByRole('combobox',{name:'Practice plan player'}).selectOption('alex');await expect(page.getByRole('button',{name:'Active (1)',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByText('Streak: 3 weeks')).toBeVisible();checks++;
   await page.getByRole('button',{name:'Week of Sep 7: 5 of 5 games · met'}).click();await expect(page.getByText('Selected week')).toBeVisible();checks++;
   await page.getByText('Games and replay evidence',{exact:true}).click();await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeVisible();await page.getByRole('button',{name:'Retry',exact:true}).click();await expect(page.getByText('7 games · 4–3 (57%)')).toBeVisible();checks++;
   await page.getByRole('heading',{name:'Weekly macro practice',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'../../docs/handoff/screenshots/coaching-plan-'+theme+'-'+width+'.png'});checks++;
   await page.getByRole('button',{name:'Cancelled (1)',exact:true}).click();await expect(page.getByRole('heading',{name:'Cancelled opener',exact:true})).toBeVisible();await page.getByRole('button',{name:'Assign again',exact:true}).click();await expect(page.getByRole('combobox',{name:'Student',exact:true})).toHaveValue('alex');await expect(page.getByRole('combobox',{name:'Build',exact:true})).toHaveValue('');await expect(page.getByText('Choose a build available for this student.',{exact:true})).toBeVisible();checks++;
   const dialog=page.getByRole('dialog');expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);checks++;
   await page.getByRole('button',{name:'Active (1)',exact:true}).click();await page.getByRole('button',{name:'Assign again',exact:true}).click();await expect(page.getByRole('dialog').getByRole('spinbutton',{name:'Required games'})).toHaveValue('5');await page.getByRole('button',{name:'Assign plan',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(writes.at(-1).body).toMatchObject({type:'total',recurrence:'weekly',timeZone:'America/New_York',requiredGames:5});checks++;
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);checks++;
   await context.close();console.log(JSON.stringify({width,theme,checks}));
  }
  console.log(JSON.stringify({checks,syntheticLocalWrites:writes.length,nonlocalTraffic:'blocked'}));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(error=>{console.error(error);process.exitCode=1});
