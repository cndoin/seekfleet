import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface DashboardAgent {
  label: string;
  profile: string;
  state: string;
  inFlight: number;
  concurrency: number;
  totalRun: number;
  totalErrors: number;
  breaker?: string;
  tokens: number;
  costUsd: number;
  lastError?: string;
  tags: string[];
}

export interface DashboardCluster {
  id: string;
  routing: string;
  createdAt: number;
  agents: DashboardAgent[];
  requests: number;
  tokens: number;
  costUsd: number;
  failures: number;
  cacheHitRatio: number;
  budgetUsd?: number;
  budgetSpent: number;
}

export interface DashboardSession {
  runId: string;
  task: string;
  profile?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  tokens: number;
  costUsd: number;
  eventCount: number;
  error?: string;
}

export interface DashboardSnapshot {
  generatedAt: number;
  uptimeMs: number;
  clusters: DashboardCluster[];
  sessions: DashboardSession[];
}

export interface DashboardServerOptions {
  host?: string;
  port?: number;
  token?: string;
  getSnapshot(): DashboardSnapshot | Promise<DashboardSnapshot>;
  cancelSession?(runId: string): Promise<boolean> | boolean;
  shutdownCluster?(clusterId: string): Promise<boolean> | boolean;
}

export interface DashboardServerHandle {
  host: string;
  port: number;
  token: string;
  localUrl: string;
  lanUrls: string[];
  close(): Promise<void>;
}

export async function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("dashboard port must be an integer between 0 and 65535");
  }
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      setSecurityHeaders(res);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true, ts: Date.now() });
        return;
      }
      if (!authorized(req.headers.authorization, token)) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/snapshot") {
        json(res, 200, { ok: true, data: await opts.getSnapshot() });
        return;
      }
      const cancelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const ok = (await opts.cancelSession?.(decodeURIComponent(cancelMatch[1]!))) ?? false;
        json(res, ok ? 200 : 404, { ok });
        return;
      }
      const shutdownMatch = url.pathname.match(/^\/api\/clusters\/([^/]+)\/shutdown$/);
      if (req.method === "POST" && shutdownMatch) {
        const ok = (await opts.shutdownCluster?.(decodeURIComponent(shutdownMatch[1]!))) ?? false;
        json(res, ok ? 200 : 404, { ok });
        return;
      }
      json(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const localUrl = `http://127.0.0.1:${actualPort}/#token=${encodeURIComponent(token)}`;
  const lanUrls =
    host === "0.0.0.0" || host === "::"
      ? localIpv4Addresses().map((ip) => `http://${ip}:${actualPort}/#token=${encodeURIComponent(token)}`)
      : [];
  return {
    host,
    port: actualPort,
    token,
    localUrl,
    lanUrls,
    close: () => closeServer(server),
  };
}

function authorized(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function setSecurityHeaders(res: import("node:http").ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  );
}

function json(res: import("node:http").ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => server.closeAllConnections(), 1_000);
    forceTimer.unref();
    server.close((err) => {
      clearTimeout(forceTimer);
      if (err) reject(err);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

function localIpv4Addresses(): string[] {
  const out = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if ((entry.family === "IPv4" || (entry.family as unknown) === 4) && !entry.internal) out.add(entry.address);
    }
  }
  return [...out];
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#08111f">
  <title>SeekFleet Control</title>
  <style>
    :root{color-scheme:dark;--bg:#07101d;--panel:#0c1828;--panel2:#101f32;--line:#20334b;--text:#ecf5ff;--muted:#8ba1ba;--cyan:#42d9e8;--blue:#5d8dff;--green:#48e0a4;--amber:#ffbd62;--red:#ff6e7d;--radius:20px}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;background:radial-gradient(circle at 85% -10%,#17335b 0,transparent 34%),radial-gradient(circle at -10% 30%,#0c3840 0,transparent 28%),var(--bg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}
    button,input{font:inherit} button{color:inherit}.shell{width:min(1440px,100%);margin:auto;padding:28px clamp(16px,3vw,42px) 56px}
    header{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:14px}.mark{width:44px;height:44px;border-radius:14px;background:linear-gradient(145deg,var(--cyan),var(--blue));box-shadow:0 10px 35px #3f94ff55;display:grid;place-items:center;color:#06111f;font-weight:900;font-size:18px}.brand h1{font-size:20px;margin:0;letter-spacing:.01em}.brand p{margin:3px 0 0;color:var(--muted);font-size:12px}.head-actions{display:flex;align-items:center;gap:10px}.live{display:flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid #245046;border-radius:999px;background:#0c2823;color:#89f4c4;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 5px #48e0a422}.refresh{border:1px solid var(--line);background:#0d1b2b;border-radius:12px;padding:9px 12px;cursor:pointer}.refresh:hover{border-color:#456688}
    .hero{display:grid;grid-template-columns:1.25fr .75fr;gap:16px;margin-bottom:16px}.hero-main,.hero-side,.card{background:linear-gradient(150deg,#0d1b2dE8,#0a1625E8);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 18px 55px #02081555}.hero-main{padding:24px;position:relative;overflow:hidden}.hero-main:after{content:"";position:absolute;width:260px;height:260px;border-radius:50%;right:-90px;top:-120px;background:#3976ef22;filter:blur(2px)}.eyebrow{color:var(--cyan);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.16em}.hero h2{font-size:clamp(26px,4vw,42px);line-height:1.05;margin:12px 0 10px;max-width:700px}.sub{color:var(--muted);max-width:680px}.hero-side{padding:22px;display:flex;flex-direction:column;justify-content:space-between}.health-score{font-size:54px;font-weight:800;letter-spacing:-.06em}.health-score small{font-size:15px;color:var(--muted);letter-spacing:0}.meter{height:7px;background:#17283c;border-radius:9px;overflow:hidden}.meter span{display:block;height:100%;background:linear-gradient(90deg,var(--green),var(--cyan));border-radius:inherit;transition:width .4s}
    .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:16px}.kpi{padding:17px;background:#0c1929dd;border:1px solid var(--line);border-radius:16px}.kpi .label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.09em}.kpi strong{display:block;font-size:24px;margin-top:8px;letter-spacing:-.04em}.kpi .hint{font-size:11px;color:#698198;margin-top:3px}
    .section-head{display:flex;align-items:end;justify-content:space-between;margin:28px 2px 12px}.section-head h3{margin:0;font-size:17px}.section-head span{color:var(--muted);font-size:12px}.cluster-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{padding:18px}.cluster-top{display:flex;justify-content:space-between;gap:12px;align-items:start}.cluster-name{font-size:16px;font-weight:750}.meta{font-size:11px;color:var(--muted);margin-top:4px}.pill{padding:5px 9px;border-radius:999px;background:#152943;color:#94b8e5;font-size:10px;text-transform:uppercase;letter-spacing:.08em}.cluster-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}.mini{padding:10px;border-radius:12px;background:#0b1523;border:1px solid #192b40}.mini b{display:block;font-size:15px}.mini span{font-size:10px;color:var(--muted)}.agents{display:grid;gap:7px}.agent{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:10px;padding:10px 11px;border-radius:12px;background:#0a1523}.state-dot{width:8px;height:8px;border-radius:50%;background:var(--muted)}.state-dot.busy{background:var(--cyan);box-shadow:0 0 9px var(--cyan)}.state-dot.ready{background:var(--green)}.state-dot.down,.state-dot.stopped{background:var(--red)}.agent-name{font-weight:650}.agent-meta{font-size:10px;color:var(--muted)}.agent-load{text-align:right;font-variant-numeric:tabular-nums}.danger{border:1px solid #5a2d37;background:#2a151c;color:#ff9aaa;border-radius:10px;padding:7px 10px;cursor:pointer;font-size:11px}.danger:hover{background:#3c1922}
    .sessions{overflow:hidden}.session-row{display:grid;grid-template-columns:minmax(180px,2fr) 105px 110px 90px 100px 80px;align-items:center;gap:12px;padding:13px 6px;border-top:1px solid #17293d}.session-row:first-child{border-top:0}.task{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task small{display:block;color:var(--muted)}.status{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.status.running{color:var(--cyan)}.status.succeeded{color:var(--green)}.status.failed,.status.cancelled{color:var(--red)}.status.paused,.status.queued{color:var(--amber)}.empty{text-align:center;padding:34px;color:var(--muted)}.auth{position:fixed;inset:0;background:#050b14ee;display:none;place-items:center;padding:20px;z-index:10}.auth.show{display:grid}.auth-box{width:min(420px,100%);padding:26px;border:1px solid var(--line);border-radius:22px;background:var(--panel);box-shadow:0 30px 90px #0008}.auth h2{margin:0 0 8px}.auth p{color:var(--muted)}.auth input{width:100%;padding:13px;border:1px solid var(--line);border-radius:12px;background:#07101d;color:var(--text);outline:none}.auth button{width:100%;margin-top:10px;padding:12px;border:0;border-radius:12px;background:linear-gradient(90deg,var(--cyan),var(--blue));color:#06101c;font-weight:800;cursor:pointer}.toast{position:fixed;right:18px;bottom:18px;background:#13253a;border:1px solid #2b4869;padding:12px 15px;border-radius:12px;transform:translateY(90px);opacity:0;transition:.25s}.toast.show{transform:none;opacity:1}
    @media(max-width:980px){.hero{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(3,1fr)}.cluster-grid{grid-template-columns:1fr}}
    @media(max-width:650px){.shell{padding-top:18px}.brand p{display:none}.head-actions .live span:last-child{display:none}.hero-main,.hero-side{padding:19px}.kpis{grid-template-columns:repeat(2,1fr)}.kpi strong{font-size:21px}.cluster-stats{grid-template-columns:repeat(2,1fr)}.session-row{grid-template-columns:1fr auto}.session-row>*:nth-child(3),.session-row>*:nth-child(4),.session-row>*:nth-child(5){display:none}.section-head{margin-top:22px}}
  </style>
</head>
<body>
  <div class="shell">
    <header><div class="brand"><div class="mark">SF</div><div><h1>SeekFleet Control</h1><p>DeepSeek Harness · Local Operations</p></div></div><div class="head-actions"><div class="live"><i class="dot"></i><span id="connection">实时连接</span><span id="updated">--:--:--</span></div><button class="refresh" id="refresh">刷新</button></div></header>
    <main>
      <section class="hero"><div class="hero-main"><div class="eyebrow">Local agent fabric</div><h2>集群运行，一目了然。</h2><div class="sub">实时查看 Agent 负载、任务执行、Token 消耗与成本。控制操作受访问令牌保护，仅在你的局域网内可用。</div></div><div class="hero-side"><div><div class="eyebrow">整体健康度</div><div class="health-score"><span id="health">100</span><small> / 100</small></div></div><div><div class="meter"><span id="healthbar" style="width:100%"></span></div><div class="meta" id="healthtext">所有系统运行正常</div></div></div></section>
      <section class="kpis"><div class="kpi"><div class="label">Agent 总数</div><strong id="agents">0</strong><div class="hint" id="active">0 个执行中</div></div><div class="kpi"><div class="label">任务调用</div><strong id="requests">0</strong><div class="hint">累计请求</div></div><div class="kpi"><div class="label">Token</div><strong id="tokens">0</strong><div class="hint">输入 + 输出</div></div><div class="kpi"><div class="label">成本</div><strong id="cost">$0.000</strong><div class="hint">累计估算</div></div><div class="kpi"><div class="label">失败</div><strong id="failures">0</strong><div class="hint" id="success">成功率 100%</div></div><div class="kpi"><div class="label">会话</div><strong id="sessions">0</strong><div class="hint" id="running">0 个运行中</div></div></section>
      <div class="section-head"><h3>Agent 集群</h3><span id="clusterCount">0 个集群</span></div><section class="cluster-grid" id="clusters"></section>
      <div class="section-head"><h3>最近任务</h3><span>自动刷新 · 2 秒</span></div><section class="card sessions" id="sessionList"></section>
    </main>
  </div>
  <div class="auth" id="auth"><div class="auth-box"><div class="eyebrow">Protected dashboard</div><h2>输入访问令牌</h2><p>令牌在启动控制台时生成。手机首次打开时输入一次即可。</p><input id="tokenInput" type="password" autocomplete="current-password" placeholder="Dashboard token"><button id="unlock">进入控制台</button></div></div>
  <div class="toast" id="toast"></div>
  <script>
    const $=id=>document.getElementById(id); let token=""; let timer;
    const fmt=n=>new Intl.NumberFormat('zh-CN',{notation:n>=10000?'compact':'standard',maximumFractionDigits:1}).format(n||0);
    const money=n=>'$'+Number(n||0).toFixed(n>=1?2:4); const ago=ts=>{const s=Math.max(0,Math.floor((Date.now()-ts)/1000));return s<60?s+' 秒前':s<3600?Math.floor(s/60)+' 分钟前':Math.floor(s/3600)+' 小时前'};
    function getToken(){const hash=new URLSearchParams(location.hash.slice(1)).get('token');if(hash){localStorage.setItem('seekfleet-dashboard-token',hash);history.replaceState(null,'',location.pathname)}return hash||localStorage.getItem('seekfleet-dashboard-token')||''}
    async function api(path,options={}){const r=await fetch(path,{...options,headers:{authorization:'Bearer '+token,...options.headers}});if(r.status===401)throw new Error('AUTH');const v=await r.json();if(!r.ok||v.ok===false)throw new Error(v.error||'请求失败');return v.data??v}
    function toast(msg){$('toast').textContent=msg;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2200)}
    function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
    function render(d){const cs=d.clusters||[],ss=d.sessions||[],as=cs.flatMap(c=>c.agents||[]);const requests=cs.reduce((n,c)=>n+c.requests,0),tokens=cs.reduce((n,c)=>n+c.tokens,0),cost=cs.reduce((n,c)=>n+c.costUsd,0),fail=cs.reduce((n,c)=>n+c.failures,0),active=as.filter(a=>a.inFlight>0||a.state==='busy').length,running=ss.filter(s=>s.status==='running').length;const health=Math.max(0,Math.round(100-(as.length?as.filter(a=>['down','stopped'].includes(a.state)).length/as.length*70:0)-(requests?fail/requests*30:0)));
      $('agents').textContent=fmt(as.length);$('active').textContent=active+' 个执行中';$('requests').textContent=fmt(requests);$('tokens').textContent=fmt(tokens);$('cost').textContent=money(cost);$('failures').textContent=fmt(fail);$('success').textContent='成功率 '+(requests?Math.max(0,(1-fail/requests)*100).toFixed(1):'100')+'%';$('sessions').textContent=fmt(ss.length);$('running').textContent=running+' 个运行中';$('health').textContent=health;$('healthbar').style.width=health+'%';$('healthtext').textContent=health>90?'所有系统运行正常':health>70?'部分 Agent 需要关注':'集群存在异常';$('updated').textContent=new Date(d.generatedAt).toLocaleTimeString('zh-CN',{hour12:false});$('clusterCount').textContent=cs.length+' 个集群';
      const agentHtml=a=>'<div class="agent"><i class="state-dot '+esc(a.state)+'"></i><div><div class="agent-name">'+esc(a.label)+'</div><div class="agent-meta">'+esc(a.profile)+' · '+esc(a.tags.join(', ')||'default')+' · '+esc(a.breaker||'closed')+'</div></div><div class="agent-load"><b>'+a.inFlight+'/'+a.concurrency+'</b><div class="agent-meta">'+fmt(a.tokens)+' tok</div></div></div>';
      const clusterHtml=c=>'<article class="card"><div class="cluster-top"><div><div class="cluster-name">'+esc(c.id.slice(0,12))+'</div><div class="meta">'+esc(c.routing)+' · '+c.agents.length+' agents · '+ago(c.createdAt)+'</div></div><button class="danger" data-shutdown="'+esc(c.id)+'">关闭集群</button></div><div class="cluster-stats"><div class="mini"><b>'+fmt(c.requests)+'</b><span>调用</span></div><div class="mini"><b>'+fmt(c.tokens)+'</b><span>Token</span></div><div class="mini"><b>'+money(c.costUsd)+'</b><span>成本</span></div><div class="mini"><b>'+Math.round((c.cacheHitRatio||0)*100)+'%</b><span>缓存</span></div></div><div class="agents">'+c.agents.map(agentHtml).join('')+'</div></article>';
      $('clusters').innerHTML=cs.length?cs.map(clusterHtml).join(''):'<div class="card empty">尚未创建集群。通过 MCP 创建后会立即显示在这里。</div>';
      const sessionHtml=s=>'<div class="session-row"><div class="task" title="'+esc(s.task)+'">'+esc(s.task)+'<small>'+esc(s.runId.slice(0,8))+' · '+ago(s.updatedAt)+'</small></div><div class="status '+esc(s.status)+'">'+esc(s.status)+'</div><div>'+fmt(s.tokens)+' token</div><div>'+money(s.costUsd)+'</div><div>'+s.eventCount+' events</div><div>'+(s.status==='running'?'<button class="danger" data-cancel="'+esc(s.runId)+'">取消</button>':'')+'</div></div>';
      $('sessionList').innerHTML=ss.length?ss.slice(0,30).map(sessionHtml).join(''):'<div class="empty">暂无任务会话</div>';
      document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>act('取消这个任务？','/api/sessions/'+encodeURIComponent(b.dataset.cancel)+'/cancel'));
      document.querySelectorAll('[data-shutdown]').forEach(b=>b.onclick=()=>act('关闭整个集群？运行中任务会先尝试排空。','/api/clusters/'+encodeURIComponent(b.dataset.shutdown)+'/shutdown'));
    }
    async function act(question,path){if(!confirm(question))return;try{await api(path,{method:'POST'});toast('操作已提交');await load()}catch(e){toast(e.message)}}
    async function load(){try{const d=await api('/api/snapshot');render(d);$('connection').textContent='实时连接';$('auth').classList.remove('show')}catch(e){if(e.message==='AUTH'){$('auth').classList.add('show');clearInterval(timer)}else{$('connection').textContent='连接异常'}}}
    function start(){clearInterval(timer);load();timer=setInterval(load,2000)}
    $('unlock').onclick=()=>{token=$('tokenInput').value.trim();localStorage.setItem('seekfleet-dashboard-token',token);start()};$('tokenInput').onkeydown=e=>{if(e.key==='Enter')$('unlock').click()};$('refresh').onclick=load;token=getToken();if(token)start();else $('auth').classList.add('show');
  </script>
</body>
</html>`;
