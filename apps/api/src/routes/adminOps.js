"use strict";
const express=require("express");
const { buildDoctor }=require("../services/doctor");
const { AdminActivationService }=require("../services/adminActivation");
const { AdminRolesService }=require("../services/adminRoles");
/** Mounted only behind the parent's authenticated admin gate. @param {any} deps */
function buildAdminOpsRouter(deps) {
  const router=express.Router(), db=deps.admin.db;
  const activation=new AdminActivationService({db});
  const roles=new AdminRolesService({db,protectedIds:deps.protectedAdminIds,protectedEmails:deps.protectedAdminEmails,onRevoked:deps.onAdminRevoked});
  router.use((_req,res,next)=>{res.set("Cache-Control","private, no-store");next();});
  router.get("/jobs",async(_req,res,next)=>{try{res.json(await deps.jobLedger.snapshot());}catch(error){next(error);}});
  router.post("/jobs/:job/run",async(req,res,next)=>{try{res.locals.auditAction="job.run";res.locals.auditTarget=String(req.params.job);res.json(await deps.jobLedger.runNow(String(req.params.job)));}catch(error){next(error);}});
  router.get("/audit",async(req,res,next)=>{try{res.json(await deps.adminAudit.list({action:req.query.action,target:req.query.target,before:req.query.before,limit:req.query.limit}));}catch(error){next(error);}});
  router.get("/activation",async(req,res,next)=>{try{res.json(await activation.snapshot(Number(req.query.weeks)||8));}catch(error){next(error);}});
  router.get("/users/:userId/support",async(req,res,next)=>{try{
    const userId=String(req.params.userId);await requireKnownUser(deps,userId);
    const [devices,doctor,replayArchive,imports,audit]=await Promise.all([
      deps.pairings.listDevices(userId), buildDoctor(deps,userId), deps.games.replayArchiveStatus(userId),
      db.importJobs.find({userId},{projection:{_id:0,jobId:1,status:1,createdAt:1,updatedAt:1,total:1,completed:1,failed:1}}).sort({createdAt:-1}).limit(5).toArray(),
      deps.adminAudit.list({target:userId,limit:10}),
    ]);
    res.json({userId,devices:devices.map((/** @type {any} */ d)=>({deviceId:d.deviceId,hostname:d.hostname,os:d.agentOs,version:d.agentVersion,lastSeenAt:d.lastSeenAt,online:Boolean(d.lastSeenAt&&Date.now()-+new Date(d.lastSeenAt)<180000)})),doctor,replayArchive,imports,audit:audit.items});
  }catch(error){next(error);}});
  router.post("/users/:userId/revoke-admin",async(req,res,next)=>{try{res.locals.auditAction="admin.revoke";res.locals.auditTarget=String(req.params.userId);res.json(await roles.revoke(String(req.params.userId),req.auth?.userId||""));}catch(error){next(error);}});
  return router;
}
/** Games-only legacy IDs pass existence lookup; mutation fences still require a real owner row. @param {any} deps @param {string} userId */
async function requireKnownUser(deps,userId) {
  const [user,game]=await Promise.all([deps.admin.db.users.findOne({userId},{projection:{_id:1}}),deps.admin.db.games.findOne({userId},{projection:{_id:1}})]);
  if(!user&&!game) throw Object.assign(new Error("user_not_found"),{status:404,code:"user_not_found"});
}
module.exports={buildAdminOpsRouter,requireKnownUser};
