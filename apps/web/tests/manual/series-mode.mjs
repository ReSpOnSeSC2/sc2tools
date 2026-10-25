// Run from apps/web: node tests/manual/series-mode.mjs. Every external request is blocked.
import{startSeriesFixture}from'./series-mode-fixture.mjs';
import {chromium,expect} from '@playwright/test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
const fixture=await startSeriesFixture();const base='http://127.0.0.1:4328',out='../../.cache/series-evidence';await fs.mkdir(out,{recursive:true});const browser=await chromium.launch({headless:true});let checks=0;const errors=[],external=[];
const check=async p=>{await p;checks++};const state=async page=>(await(await page.request.get(base+'/__series/state')).json());const emit=async(page,value)=>page.evaluate(value=>window.seriesFixture.emit(value),value);
async function open(width,theme){const context=await browser.newContext({viewport:{width,height:950},colorScheme:theme,reducedMotion:'reduce'});await context.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();external.push(route.request().url());return route.abort()});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/?theme='+theme);await page.evaluate(()=>document.fonts.ready);await check(expect(page.getByRole('button',{name:'Start series',exact:true})).toBeEnabled());return{context,page}}
try{
 await (await browser.newContext()).request.post(base+'/__series/reset');
 const{context,page}=await open(390,'light');
 await check(expect(page.getByLabel('Opponent',{exact:true})).toHaveValue('Recorded opponent'));
 await check(expect(page.locator('.widget-shell')).toHaveCount(0));
 await page.getByRole('button',{name:'Preview sample',exact:true}).click();await check(expect(page.locator('.widget-shell')).toHaveCount(2));
 await check(expect(page.getByTestId('dedicated')).toContainText('SAMPLE'));assert.equal((await state(page)).writes,0);checks++;
 await page.getByRole('button',{name:'Stop sample',exact:true}).click();await check(expect(page.locator('.widget-shell')).toHaveCount(0));
 await page.getByLabel('Opponent',{exact:true}).fill('Clem');await page.getByRole('combobox',{name:/^Format/}).selectOption('5');await page.getByRole('textbox',{name:/^Map order/}).fill('Alcyone\nGoldenaura\nSite Delta\nOceanborn\nGhost River');await page.getByRole('button',{name:'Start series',exact:true}).click();
 await check(expect(page.getByText('Series started',{exact:true})).toBeVisible());let saved=await state(page);assert.equal(saved.writes,1);checks++;
 await check(expect(page.getByRole('region',{name:'Series controls'})).toContainText('Recorded lifetime H2H unavailable'));
 await page.getByRole('button',{name:'Enable Series widget',exact:true}).click();await emit(page,saved.snapshot);await check(expect(page.locator('.widget-shell')).toHaveCount(2));
 const played=async(id,result,toon)=>{const value=await(await page.request.post(base+'/__series/game',{data:{id,result,toon}})).json();await emit(page,value);return value};
 let next=await played('tie','Tie');assert.equal(next.gamesPlayed,1);assert.deepEqual(next.score,{you:0,opponent:0});checks+=2;await check(expect(page.getByTestId('dedicated')).toContainText('Current map: Goldenaura'));
 next=await played('win','Victory');assert.equal(next.score.you,1);checks++;const duplicate=await played('win','Victory');assert.equal(duplicate.revision,next.revision);checks++;
 const wrong=await played('wrong','Victory','1-S2-1-123');assert.equal(wrong.revision,next.revision);checks++;
 await emit(page,{...next,revision:1,score:{you:0,opponent:0}});await check(expect(page.getByTestId('dedicated')).toContainText('1–0'));
 await page.getByRole('button',{name:'Preview sample',exact:true}).click();next=await played('loss','Defeat');await check(expect(page.getByTestId('dedicated')).toContainText('2–1'));await page.getByRole('button',{name:'Stop sample',exact:true}).click();await check(expect(page.getByTestId('dedicated')).toContainText('1–1'));
 await page.getByRole('button',{name:'Add a win for you',exact:true}).click();await check(expect(page.getByRole('region',{name:'Series controls'})).toContainText('2–1'));await page.getByRole('button',{name:'Add a win for you',exact:true}).click();await check(expect(page.getByRole('region',{name:'Series controls'})).toContainText('SERIES WON'));await page.getByRole('button',{name:'Remove a win for you',exact:true}).click();await check(expect(page.getByRole('region',{name:'Series controls'})).toContainText('IN PROGRESS'));
 await page.getByRole('button',{name:'Use current map pool',exact:true}).click();await page.getByRole('textbox',{name:/^Map order/}).fill('Newer map draft');await check(expect(page.getByText(/newer map draft was kept/)).toBeVisible());await check(expect(page.getByRole('textbox',{name:/^Map order/})).toHaveValue('Newer map draft'));
 const beforeEnd=(await state(page)).writes;const end=page.getByRole('button',{name:'End series',exact:true});await end.click();await check(expect(page.getByRole('dialog')).toBeVisible());await check(expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeFocused());await page.keyboard.press('Escape');await check(expect(page.getByRole('dialog')).toHaveCount(0));assert.equal((await state(page)).writes,beforeEnd);checks++;
 await end.click();await page.getByRole('dialog').getByRole('button',{name:'End series',exact:true}).click();await check(expect(page.getByRole('region',{name:'Series controls'})).toContainText('ENDED'));await check(expect(page.getByRole('button',{name:'Add a win for you',exact:true})).toBeDisabled());
 await context.close();
 for(const width of[320,390,768,1440])for(const theme of['light','dark']){const seedContext=await browser.newContext();const seeded=await(await seedContext.request.post(base+'/__series/seed')).json();await seedContext.close();const{context,page}=await open(width,theme);await emit(page,seeded);await page.getByRole('button',{name:'Enable Series widget',exact:true}).click();await check(expect(page.getByTestId('dedicated')).toContainText('2–1'));await check(expect(page.getByTestId('aio')).toContainText('Recorded lifetime H2H: 7W–5L–1D'));
 const geometry=await page.evaluate(()=>({viewport:innerWidth,body:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('button')].filter(el=>el.getBoundingClientRect().width>0).map(el=>({text:el.textContent,rect:el.getBoundingClientRect().toJSON()}))}));assert.ok(geometry.body<=geometry.viewport+1,JSON.stringify(geometry));checks++;for(const button of geometry.buttons){assert.ok(button.rect.left>=-1&&button.rect.right<=width+1,JSON.stringify(button));checks++}await page.screenshot({path:out+`/series-${theme}-${width}.png`,fullPage:true});await context.close()}
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks+=2;console.log(JSON.stringify({checks,captures:8,errors,external},null,2));await fs.writeFile(out+'/result.json',JSON.stringify({checks,captures:8,errors,external},null,2));
}finally{await browser.close();await fixture.close()}



