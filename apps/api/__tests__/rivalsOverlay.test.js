// @ts-nocheck
"use strict";
const { MongoMemoryServer } = require("mongodb-memory-server");
const { connect } = require("../src/db/connect");
const { OverlayLiveService } = require("../src/services/overlayLive");
const { RivalsService } = require("../src/services/rivals");
let mongo,db;
beforeAll(async()=>{mongo=await MongoMemoryServer.create();db=await connect({uri:mongo.getUri(),dbName:"rivals_overlay"});});
afterAll(async()=>{await db?.close();await mongo?.stop();});
beforeEach(async()=>{await Promise.all([db.opponents.deleteMany({}),db.games.deleteMany({}),db.pulseCharacterLinks.deleteMany({})]);await db.opponents.insertOne({userId:"owner",pulseId:"1-S2-1-99",pulseCharacterId:"101",displayNameSample:"Rival",race:"Zerg",wins:1,losses:0,gameCount:1,lastSeen:new Date()});});
const row=()=>({userId:"owner",gameId:"one",date:new Date(),result:"Victory",myRace:"Protoss",myBuild:"Gateway",durationSec:400,map:"Ghost River",opponent:{pulseId:"1-S2-1-99",pulseCharacterId:"101",displayName:"Rival",race:"Zerg",strategy:"Pool"}});
test("a matched saved rival sets starred before and after a game below the old repeat threshold",async()=>{
 const isStarred=jest.fn().mockResolvedValue(true),svc=new OverlayLiveService(db,{rivals:{isStarred}});await db.games.insertOne(row());
 const pre=await svc.buildFromOpponentName("owner","Rival","Zerg",101,"Protoss","1-S2-1-99");
 const post=await svc.buildFromGame("owner",row());
 expect(pre.rival).toMatchObject({starred:true,headToHead:{wins:1,losses:0}});expect(post.rival).toMatchObject({starred:true});
 expect(isStarred).toHaveBeenCalledTimes(2);for(const call of isStarred.mock.calls)expect(call).toMatchObject(["owner",{pulseId:"1-S2-1-99",pulseCharacterId:"101"}]);
});
test("a display-name fallback cannot attach another account's explicit star, and failures remain optional",async()=>{
 const isStarred=jest.fn().mockResolvedValue(true),svc=new OverlayLiveService(db,{rivals:{isStarred}});
 const weak=await svc.buildFromOpponentName("owner","Rival","Zerg",null,"Protoss");
 expect(weak.opponentIdentityMatched).toBe(false);expect(weak.rival).toBeUndefined();expect(isStarred).not.toHaveBeenCalled();
 isStarred.mockRejectedValue(new Error("temporary"));const matched=await svc.buildFromOpponentName("owner","Rival","Zerg",101,"Protoss","1-S2-1-99");expect(matched.rival).toBeUndefined();
});
test("private header and overlay keys use only this owner's recorded identity and existing public aliases",async()=>{
 await db.pulseCharacterLinks.insertOne({pulseCharacterId:"101",accountId:"900",proId:"88"});
 const users={getPreferences:jest.fn().mockResolvedValue({keys:["acct:900"]})},svc=new RivalsService(db,{users});
 expect(await svc.identityKeys("other","1-S2-1-99")).toBeNull();
 expect(await svc.identityKeys("owner","1-S2-1-99")).toEqual({keys:["pro:88","acct:900","solo:1-S2-1-99"]});
 expect(await svc.isStarred("owner",{pulseId:"1-S2-1-99",pulseCharacterId:"101"})).toBe(true);
 expect(users.getPreferences).toHaveBeenCalledWith("owner","rivals");
});
