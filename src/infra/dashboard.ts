/**
 * Dashboard — lightweight Web status panel for agents-to-im.
 *
 * Starts an HTTP server on CTI_DASHBOARD_PORT (default 13578) that serves:
 *   GET /            — Single-page HTML dashboard (dark theme, auto-refresh)
 *   GET /api/status  — JSON status data for the dashboard
 *
 * The dashboard is purely read-only and requires no authentication
 * since it binds to 127.0.0.1 by default.
 */

import http from 'node:http';
import { CTI_HOME } from '../config/config.js';
import type { JsonFileStore } from './store.js';

// ── Types ──

interface DashboardDeps {
  store: JsonFileStore;
  getUptime: () => number;
  getBridgeStatus: () => {
    running: boolean;
    startedAt: string | null;
    adapters: Array<{
      channelType: string;
      running: boolean;
      connectedAt: string | null;
      lastMessageAt: string | null;
      error: string | null;
    }>;
  };
}

let deps: DashboardDeps | null = null;
let server: http.Server | null = null;

// ── API ──

function buildStatusJson(): Record<string, unknown> {
  if (!deps) return { error: 'Dashboard not initialized' };

  const bridgeStatus = deps.getBridgeStatus();
  const bindings = deps.store.listChannelBindings();
  const uptime = deps.getUptime();

  const sessions = bindings.map((b) => {
    const ext = deps!.store.getSessionExt(b.codepilotSessionId);
    return {
      chatId: b.chatId.slice(0, 12) + '…',
      sessionId: b.codepilotSessionId.slice(0, 8) + '…',
      runtime: ext?.runtime || 'claude',
      title: ext?.title || '(untitled)',
      mode: b.mode,
      model: b.model || 'default',
      workDir: b.workingDirectory || '~',
      active: b.active,
      updatedAt: b.updatedAt,
    };
  });

  return {
    bridge: bridgeStatus,
    uptime,
    pid: process.pid,
    home: CTI_HOME,
    sessions,
    sessionCount: sessions.length,
    timestamp: new Date().toISOString(),
  };
}

// ── Dashboard HTML ──

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agents-to-im Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0e17;--surface:#111827;--surface2:#1e293b;--border:#1e293b;
  --text:#e2e8f0;--text2:#94a3b8;--accent:#6366f1;--accent2:#818cf8;
  --green:#10b981;--red:#ef4444;--orange:#f59e0b;--blue:#3b82f6;
  --radius:12px;--font:'Inter',system-ui,-apple-system,sans-serif;
}
body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;padding:0}
.container{max-width:1200px;margin:0 auto;padding:24px 20px}

/* Header */
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid var(--border)}
.header h1{font-size:22px;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;display:flex;align-items:center;gap:10px}
.header h1 .icon{font-size:26px;-webkit-text-fill-color:initial}
.meta{font-size:13px;color:var(--text2);text-align:right}
.meta .pid{font-family:monospace;color:var(--text)}

/* Status indicator */
.status-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.status-dot.on{background:var(--green);box-shadow:0 0 8px rgba(16,185,129,.5)}
.status-dot.off{background:var(--red);box-shadow:0 0 8px rgba(239,68,68,.4)}

/* Cards grid */
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:28px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;transition:border-color .2s,transform .15s}
.card:hover{border-color:var(--accent);transform:translateY(-2px)}
.card .label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--text2);margin-bottom:8px}
.card .value{font-size:28px;font-weight:700}
.card .value.green{color:var(--green)}.card .value.red{color:var(--red)}
.card .value.blue{color:var(--blue)}.card .value.orange{color:var(--orange)}

/* Section */
.section{margin-bottom:28px}
.section h2{font-size:16px;font-weight:600;margin-bottom:14px;color:var(--text);display:flex;align-items:center;gap:8px}
.section h2 .badge{font-size:11px;background:var(--accent);color:#fff;padding:2px 8px;border-radius:20px;font-weight:500}

/* Adapters */
.adapters{display:flex;gap:12px;flex-wrap:wrap}
.adapter-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;min-width:200px;flex:1}
.adapter-card .name{font-weight:600;font-size:15px;margin-bottom:6px;text-transform:capitalize}
.adapter-card .detail{font-size:12px;color:var(--text2);margin-top:4px}

/* Table */
.table-wrap{overflow-x:auto;border-radius:var(--radius);border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:12px 14px;background:var(--surface2);color:var(--text2);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
td{padding:10px 14px;border-top:1px solid var(--border);vertical-align:middle}
tr:hover td{background:rgba(99,102,241,.04)}
.mono{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px;color:var(--accent2)}
.tag{display:inline-block;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:500}
.tag.claude{background:rgba(99,102,241,.15);color:var(--accent2)}
.tag.codex{background:rgba(245,158,11,.15);color:var(--orange)}
.tag.active{background:rgba(16,185,129,.15);color:var(--green)}
.tag.inactive{background:rgba(239,68,68,.12);color:var(--red)}
.empty{text-align:center;padding:40px;color:var(--text2);font-size:14px}

/* Footer */
.footer{text-align:center;padding:20px 0;color:var(--text2);font-size:12px;border-top:1px solid var(--border);margin-top:20px}
.footer a{color:var(--accent2);text-decoration:none}

/* Pulse animation */
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.refreshing{animation:pulse 1s ease-in-out}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1><span class="icon">⚡</span> agents-to-im</h1>
    <div class="meta">
      <div>PID <span class="pid" id="pid">—</span></div>
      <div id="last-update" style="margin-top:4px">Loading…</div>
    </div>
  </div>

  <div class="cards" id="cards"></div>

  <div class="section" id="adapters-section">
    <h2>Adapters <span class="badge" id="adapter-count">0</span></h2>
    <div class="adapters" id="adapters"></div>
  </div>

  <div class="section">
    <h2>Sessions <span class="badge" id="session-count">0</span></h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Chat</th><th>Session</th><th>Runtime</th><th>Title</th><th>Mode</th><th>Model</th><th>Work Dir</th><th>Status</th></tr>
        </thead>
        <tbody id="sessions"><tr><td colspan="8" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="footer">
    <a href="https://github.com/francize/agents-to-im" target="_blank">agents-to-im</a> &middot; Dashboard refreshes every 5s
  </div>
</div>
<script>
function fmt(s){if(!s)return'—';const d=new Date(s);return d.toLocaleString()}
function uptime(s){
  if(!s||s<0)return'—';
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);
  return (h?h+'h ':'')+(m?m+'m ':'')+(sec+'s');
}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

async function refresh(){
  try{
    const r=await fetch('/api/status');
    const d=await r.json();
    // PID
    document.getElementById('pid').textContent=d.pid||'—';
    document.getElementById('last-update').textContent='Updated '+new Date().toLocaleTimeString();
    // Cards
    const running=d.bridge?.running;
    document.getElementById('cards').innerHTML=\`
      <div class="card"><div class="label">Status</div><div class="value \${running?'green':'red'}"><span class="status-dot \${running?'on':'off'}"></span>\${running?'Running':'Stopped'}</div></div>
      <div class="card"><div class="label">Uptime</div><div class="value blue">\${uptime(d.uptime)}</div></div>
      <div class="card"><div class="label">Sessions</div><div class="value orange">\${d.sessionCount||0}</div></div>
      <div class="card"><div class="label">Adapters</div><div class="value">\${(d.bridge?.adapters||[]).length}</div></div>
    \`;
    // Adapters
    const adapters=d.bridge?.adapters||[];
    document.getElementById('adapter-count').textContent=adapters.length;
    document.getElementById('adapters').innerHTML=adapters.length?adapters.map(a=>\`
      <div class="adapter-card">
        <div class="name"><span class="status-dot \${a.running?'on':'off'}"></span>\${esc(a.channelType)}</div>
        <div class="detail">Last msg: \${fmt(a.lastMessageAt)}</div>
        \${a.error?'<div class="detail" style="color:var(--red)">Error: '+esc(a.error)+'</div>':''}
      </div>
    \`).join(''):'<div class="empty">No adapters registered</div>';
    // Sessions
    const sessions=d.sessions||[];
    document.getElementById('session-count').textContent=sessions.length;
    const tbody=document.getElementById('sessions');
    if(!sessions.length){tbody.innerHTML='<tr><td colspan="8" class="empty">No active sessions</td></tr>';return}
    tbody.innerHTML=sessions.map(s=>\`<tr>
      <td class="mono">\${esc(s.chatId)}</td>
      <td class="mono">\${esc(s.sessionId)}</td>
      <td><span class="tag \${s.runtime}">\${esc(s.runtime)}</span></td>
      <td>\${esc(s.title)}</td>
      <td>\${esc(s.mode)}</td>
      <td class="mono">\${esc(s.model)}</td>
      <td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">\${esc(s.workDir)}</td>
      <td><span class="tag \${s.active?'active':'inactive'}">\${s.active?'active':'inactive'}</span></td>
    </tr>\`).join('');
  }catch(e){console.error('Dashboard refresh failed:',e)}
}
refresh();
setInterval(refresh,5000);
</script>
</body>
</html>`;
}

// ── Server ──

export function startDashboard(options: DashboardDeps): void {
  deps = options;
  const port = parseInt(process.env.CTI_DASHBOARD_PORT || '13578', 10);
  const host = process.env.CTI_DASHBOARD_HOST || '127.0.0.1';

  server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/api/status') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(buildStatusJson()));
      return;
    }

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, host, () => {
    console.log(`[dashboard] Status panel available at http://${host}:${port}`);
  });

  // Don't let the dashboard server keep the process alive
  server.unref();
}

export function stopDashboard(): void {
  if (server) {
    server.close();
    server = null;
  }
  deps = null;
}
