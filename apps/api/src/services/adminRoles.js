"use strict";
class AdminRolesService {
  /** @param {{db:any,protectedIds?:string[],protectedEmails?:string[],onRevoked?:(id:string)=>void}} deps */
  constructor(deps) { this.db=deps.db; this.protectedIds=new Set(deps.protectedIds||[]); this.protectedEmails=new Set((deps.protectedEmails||[]).map(e=>e.toLowerCase())); this.onRevoked=deps.onRevoked; }
  /** A shared revision write makes concurrent removals conflict in Mongo's transaction,
   * so the retry reads fresh roles before checking the last-admin invariant.
   * @param {string} userId @param {string} actorId */
  async revoke(userId, actorId) {
    if(userId===actorId) throw failure("cannot_revoke_self",409);
    const revisions=this.db.db.collection("job_locks");
    try { await revisions.updateOne({_id:"admin-role-revision"},{$setOnInsert:{revision:0}},{upsert:true}); }
    catch(error) { if(/** @type {any} */(error).code!==11000) throw error; }
    const session=this.db.client.startSession();
    try {
      const result=await session.withTransaction(async()=>{
        await revisions.updateOne({_id:"admin-role-revision"},{$inc:{revision:1}},{session});
        const target=await this.db.users.findOne({userId,role:"admin"},{session,projection:{_id:0,userId:1,clerkUserId:1,email:1}});
        if(!target) throw failure("admin_not_found",404);
        if(this.protectedIds.has(target.clerkUserId)||this.protectedEmails.has(String(target.email||"").toLowerCase())) throw failure("configured_admin_protected",409);
        const admins=await this.db.users.find({role:"admin"},{session,projection:{clerkUserId:1}}).limit(2001).toArray();
        const effective=new Set([...this.protectedIds,...admins.map((/** @type {any} */ a)=>a.clerkUserId).filter(Boolean)]);
        if(effective.size<=1) throw failure("cannot_revoke_last_admin",409);
        const changed=await this.db.users.updateOne({userId,role:"admin"},{$set:{role:"user",roleRevokedAt:new Date()}},{session});
        if(!changed.modifiedCount) throw failure("admin_not_found",404);
        return {ok:true,userId,clerkUserId:target.clerkUserId};
      });
      this.onRevoked?.(result.clerkUserId);return {ok:true,userId};
    } finally { await session.endSession(); }
  }
}
/** @param {string} code @param {number} status */
function failure(code,status) {return Object.assign(new Error(code),{code,status});}
module.exports={AdminRolesService};
