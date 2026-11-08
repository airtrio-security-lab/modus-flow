import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateSubmission,transition} from './domain.js';
import {createContribution,recordAdoption,recordUsage,summary} from './contribution.js';
import {createDraft,updateDraft,preparePublication,publishDraft} from './draft.js';
const port=Number(process.env.PORT||3000);
const items=new Map();
const contributions=new Map();
const drafts=new Map();
const tokens=new Map();
function send(res,status,body,contentType='application/json; charset=utf-8'){
  res.writeHead(status,{'Content-Type':contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});
  res.end(contentType.startsWith('application/json')?JSON.stringify(body):body);
}
async function body(req){
  let text='';
  for await(const part of req){text+=part;if(text.length>100000)throw new Error('Payload too large');}
  return JSON.parse(text||'{}');
}
function actor(req){const bearer=req.headers.authorization||'';return tokens.get(bearer.replace(/^Bearer /,''));}
const demo=process.env.DEMO_MODE==='true';
if(demo){
  tokens.set('demo-employee',{id:'employee-1',role:'employee'});
  tokens.set('demo-manager',{id:'manager-1',role:'manager'});
}
const home=await readFile(resolve('public/index.html'),'utf8');
const script=await readFile(resolve('public/app.js'),'utf8');
const style=await readFile(resolve('public/style.css'),'utf8');
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ok:true,mode:demo?'demo':'restricted'});
    if(req.method==='GET'&&url.pathname==='/')return send(res,200,home,'text/html; charset=utf-8');
    if(req.method==='GET'&&url.pathname==='/app.js')return send(res,200,script,'text/javascript; charset=utf-8');
    if(req.method==='GET'&&url.pathname==='/style.css')return send(res,200,style,'text/css; charset=utf-8');
    if(!url.pathname.startsWith('/api/'))return send(res,404,{error:'Not found'});
    const user=actor(req);if(!user)return send(res,401,{error:'Authentication required'});
    if(url.pathname==='/api/me'&&req.method==='GET')return send(res,200,user);
    if(url.pathname==='/api/drafts'&&req.method==='GET')return send(res,200,[...drafts.values()].filter(d=>d.ownerId===user.id));
    if(url.pathname==='/api/drafts'&&req.method==='POST'){
      const draft=createDraft(user,await body(req));drafts.set(draft.id,draft);return send(res,201,draft);
    }
    const dm=url.pathname.match(/^\/api\/drafts\/([0-9a-f-]+)(?:\/(publish))?$/);
    if(dm){
      const draft=drafts.get(dm[1]);if(!draft||draft.ownerId!==user.id)return send(res,404,{error:'Not found'});
      if(req.method==='PATCH'&&!dm[2]){const next=updateDraft(draft,user,await body(req));drafts.set(draft.id,next);return send(res,200,next);}
      if(req.method==='POST'&&dm[2]==='publish'){
        const data=preparePublication(draft,user);const payload=validateSubmission(data);const now=new Date().toISOString();
        const item={id:randomUUID(),...payload,authorId:user.id,status:'submitted',createdAt:now,updatedAt:now,history:[{at:now,actorId:user.id,event:'published',draftId:draft.id}]};
        items.set(item.id,item);const next=publishDraft(draft,user,item.id);drafts.set(draft.id,next);
        const contribution=createContribution(item,user);contributions.set(contribution.id,contribution);
        return send(res,201,{request:item,contribution:summary(contribution)});
      }
    }

    if(url.pathname==='/api/contributions'&&req.method==='GET')return send(res,200,[...contributions.values()].map(summary));
    if(url.pathname==='/api/contributions'&&req.method==='POST'){
      const data=await body(req),request=items.get(data.requestId);
      if(!request)return send(res,404,{error:'Request not found'});
      if([...contributions.values()].some(c=>c.requestId===request.id))return send(res,409,{error:'Already registered'});
      const c=createContribution(request,user);contributions.set(c.id,c);return send(res,201,summary(c));
    }
    const cm=url.pathname.match(/^\/api\/contributions\/([0-9a-f-]+)\/(adoptions|usage)$/);
    if(cm&&req.method==='POST'){
      const c=contributions.get(cm[1]);if(!c)return send(res,404,{error:'Not found'});
      const data=await body(req),next=cm[2]==='adoptions'?recordAdoption(c,data,user):recordUsage(c,data,user);
      contributions.set(c.id,next);return send(res,201,summary(next));
    }
    if(url.pathname==='/api/requests'&&req.method==='GET'){
      const data=[...items.values()].filter(x=>user.role!=='employee'||x.authorId===user.id);
      return send(res,200,data.map(({history,...rest})=>({...rest,history:history.filter(()=>user.role!=='employee'||rest.authorId===user.id)})));
    }
    if(url.pathname==='/api/requests'&&req.method==='POST'){
      const payload=validateSubmission(await body(req));const now=new Date().toISOString();
      const item={id:randomUUID(),...payload,authorId:user.id,status:'submitted',createdAt:now,updatedAt:now,history:[{at:now,actorId:user.id,event:'submitted'}]};
      items.set(item.id,item);return send(res,201,item);
    }
    const match=url.pathname.match(/^\/api\/requests\/([0-9a-f-]+)\/status$/);
    if(match&&req.method==='PATCH'){
      const item=items.get(match[1]);if(!item)return send(res,404,{error:'Not found'});
      if(user.role==='employee'&&item.authorId!==user.id)return send(res,404,{error:'Not found'});
      const {status}=await body(req);const result=transition(item,status,user);
      result.history=[...item.history,{at:result.updatedAt,actorId:user.id,event:'status',from:item.status,to:status}];
      items.set(item.id,result);return send(res,200,result);
    }
    return send(res,404,{error:'Not found'});
  }catch(error){
    const forbidden=error.message==='Forbidden transition'||error.message==='Forbidden';
    return send(res,forbidden?403:error instanceof SyntaxError?400:422,{error:error.message});
  }
});
server.listen(port,()=>console.log('MODUS FLOW listening on '+port+(demo?' (DEMO MODE)':'')));
