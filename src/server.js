import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateSubmission,transition} from './domain.js';
const port=Number(process.env.PORT||3000);
const items=new Map();
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
    const forbidden=error.message==='Forbidden transition';
    return send(res,forbidden?403:error instanceof SyntaxError?400:422,{error:error.message});
  }
});
server.listen(port,()=>console.log('MODUS FLOW listening on '+port+(demo?' (DEMO MODE)':'')));
