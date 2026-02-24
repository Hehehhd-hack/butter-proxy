'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory cookie jar keyed by IP + domain
const cookieJar = new Map();

app.use(cors({ origin: '*', credentials: true }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// ─── SELF PING (keeps Railway from sleeping) ─────────────────────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;

setInterval(async () => {
  try {
    await axios.get(SELF_URL + '/ping', { timeout: 5000 });
    console.log('[ping] awake');
  } catch (e) { /* silent */ }
}, 4 * 60 * 1000); // every 4 minutes

// ─── URL HELPERS ─────────────────────────────────────────────────────────────

function toAbs(rel, base) {
  try { return new URL(rel, base).href; } catch { return null; }
}

function proxyHref(rel, base) {
  const abs = toAbs(rel, base);
  if (!abs) return rel;
  return '/fetch?url=' + encodeURIComponent(abs);
}

// ─── CSS REWRITER ─────────────────────────────────────────────────────────────

function rewriteCSS(css, baseUrl) {
  return css.replace(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/gi, (m, u) => {
    u = u.trim();
    if (u.startsWith('data:') || u.startsWith('/fetch?')) return m;
    const abs = toAbs(u, baseUrl);
    if (!abs) return m;
    return `url('/fetch?url=${encodeURIComponent(abs)}')`;
  });
}

// ─── HTML REWRITER ────────────────────────────────────────────────────────────

function rewriteHTML(html, baseUrl) {
  const origin = new URL(baseUrl).origin;

  // Remove security headers that block framing
  html = html.replace(/<meta[^>]*content-security-policy[^>]*>/gi, '');
  html = html.replace(/<meta[^>]*x-frame-options[^>]*>/gi, '');

  // Rewrite src, href, action, srcset, poster, data-src
  html = html.replace(
    /\b(src|href|action|poster|data-src|data-href)\s*=\s*(["'])([^"']*)\2/gi,
    (match, attr, quote, val) => {
      val = val.trim();
      if (!val || val.startsWith('data:') || val.startsWith('javascript:') ||
          val.startsWith('#') || val.startsWith('mailto:') ||
          val.startsWith('tel:') || val.startsWith('/fetch?')) return match;
      const abs = toAbs(val, baseUrl);
      if (!abs) return match;
      return `${attr}=${quote}/fetch?url=${encodeURIComponent(abs)}${quote}`;
    }
  );

  // Rewrite srcset (comma-separated list of url widthDescriptor)
  html = html.replace(/srcset\s*=\s*(["'])([^"']*)\1/gi, (match, quote, srcset) => {
    const rewritten = srcset.split(',').map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      if (!u || u.startsWith('/fetch?')) return part;
      const abs = toAbs(u, baseUrl);
      if (!abs) return part;
      return ['/fetch?url=' + encodeURIComponent(abs), ...rest].join(' ');
    }).join(', ');
    return `srcset=${quote}${rewritten}${quote}`;
  });

  // Rewrite inline CSS url()
  html = html.replace(/style\s*=\s*(["'])([^"']*)\1/gi, (match, quote, style) => {
    return `style=${quote}${rewriteCSS(style, baseUrl)}${quote}`;
  });

  // Rewrite <style> blocks
  html = html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, open, css, close) => {
    return open + rewriteCSS(css, baseUrl) + close;
  });

  // Inject interception script
  const script = `
<script>
(function(){
  var BASE='${baseUrl.replace(/'/g,"\\'")}';
  var PROXY='/fetch?url=';

  function abs(u){
    if(!u||u.startsWith('data:')||u.startsWith('javascript:')||
       u.startsWith('#')||u.startsWith('/fetch?'))return u;
    try{return new URL(u,BASE).href;}catch(e){return u;}
  }
  function px(u){return PROXY+encodeURIComponent(abs(u));}

  // Patch fetch
  var _fetch=window.fetch;
  window.fetch=function(r,o){
    if(typeof r==='string'&&/^https?:/.test(r))r=px(r);
    return _fetch.call(this,r,o);
  };

  // Patch XHR
  var _open=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    if(typeof u==='string'&&/^https?:/.test(u))u=px(u);
    return _open.apply(this,arguments);
  };

  // Patch pushState / replaceState
  var _push=history.pushState,_replace=history.replaceState;
  history.pushState=function(s,t,u){
    if(u)window.parent.postMessage({type:'bb-url',url:abs(u)},'*');
    return _push.apply(this,arguments);
  };
  history.replaceState=function(s,t,u){
    if(u)window.parent.postMessage({type:'bb-url',url:abs(u)},'*');
    return _replace.apply(this,arguments);
  };

  // Intercept clicks
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');
    if(!a)return;
    var h=a.getAttribute('href');
    if(!h||h.startsWith('#')||h.startsWith('javascript:')||h.startsWith('/fetch?'))return;
    e.preventDefault();e.stopPropagation();
    window.parent.postMessage({type:'bb-navigate',url:abs(h)},'*');
  },true);

  // Intercept forms
  document.addEventListener('submit',function(e){
    var f=e.target;
    var action=f.getAttribute('action')||BASE;
    if(action.startsWith('/fetch?'))return;
    e.preventDefault();
    var absAction=abs(action);
    var method=(f.method||'get').toUpperCase();
    var params=new URLSearchParams(new FormData(f)).toString();
    var finalUrl=method==='POST'?absAction:absAction+(absAction.includes('?')?'&':'?')+params;
    window.parent.postMessage({type:'bb-navigate',url:finalUrl,method:method,body:method==='POST'?params:null},'*');
  },true);

  // Report page URL to parent
  window.parent.postMessage({type:'bb-url',url:BASE},'*');
})();
</script>`;

  if (html.includes('</head>')) {
    html = html.replace('</head>', script + '</head>');
  } else if (html.includes('<body')) {
    html = html.replace(/<body[^>]*>/, m => m + script);
  } else {
    html = script + html;
  }

  return html;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/ping', (req, res) => res.send('🧈'));

app.get('/', (req, res) => {
  res.send(`<html><body style="background:#1a1200;color:#f5c842;
    font-family:sans-serif;display:flex;flex-direction:column;
    align-items:center;justify-content:center;height:100vh;
    gap:12px;text-align:center;padding:20px;">
    <div style="font-size:64px">🧈</div>
    <h1>Butter Proxy</h1>
    <p style="color:#c8a040">Running! Use /fetch?url=https://example.com</p>
  </body></html>`);
});

// ─── MAIN PROXY ───────────────────────────────────────────────────────────────
app.all('/fetch', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { return res.status(400).send('Invalid URL'); }

  // Cookie jar per session
  const key = (req.ip || 'x') + '::' + parsed.hostname;
  if (!cookieJar.has(key)) cookieJar.set(key, {});
  const jar = cookieJar.get(key);
  const cookieStr = Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ');

  const isPost = req.method === 'POST';

  try {
    const response = await axios({
      method: isPost ? 'POST' : 'GET',
      url: targetUrl,
      data: isPost ? req.body : undefined,
      responseType: 'arraybuffer',
      maxRedirects: 10,
      timeout: 20000,
      decompress: false, // we handle manually
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': parsed.origin + '/',
        'Origin': parsed.origin,
        ...(cookieStr ? { Cookie: cookieStr } : {}),
        'Upgrade-Insecure-Requests': '1',
      },
      validateStatus: () => true,
    });

    // Save cookies
    const setCookies = response.headers['set-cookie'];
    if (setCookies) {
      (Array.isArray(setCookies) ? setCookies : [setCookies]).forEach(c => {
        const [pair] = c.split(';');
        const [name, ...rest] = pair.split('=');
        jar[name.trim()] = rest.join('=').trim();
      });
    }

    // Strip blocking response headers
    const strip = new Set([
      'x-frame-options','content-security-policy',
      'content-security-policy-report-only','x-content-type-options',
      'strict-transport-security','set-cookie','transfer-encoding',
      'content-encoding','content-length',
    ]);
    Object.keys(response.headers).forEach(h => {
      if (!strip.has(h.toLowerCase())) {
        try { res.setHeader(h, response.headers[h]); } catch {}
      }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Frame-Options', 'ALLOWALL');

    const ct = (response.headers['content-type'] || '').toLowerCase();
    const enc = (response.headers['content-encoding'] || '').toLowerCase();

    // Decompress
    let buf = response.data;
    try {
      if (enc.includes('gzip'))    buf = zlib.gunzipSync(buf);
      else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
      else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
    } catch { /* use raw */ }

    res.setHeader('Content-Type', ct || 'application/octet-stream');

    if (ct.includes('text/html')) {
      return res.send(rewriteHTML(buf.toString('utf-8'), targetUrl));
    }
    if (ct.includes('text/css')) {
      return res.send(rewriteCSS(buf.toString('utf-8'), targetUrl));
    }
    // Everything else (JS, images, video, fonts) — send raw
    return res.send(buf);

  } catch (err) {
    console.error('Proxy error:', err.message);
    return res.status(500).send(`
      <html><body style="background:#1a1200;color:#f5c842;font-family:sans-serif;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        height:100vh;gap:16px;text-align:center;padding:20px;">
        <div style="font-size:60px">🧈</div>
        <h2>Couldn't load this page</h2>
        <p style="color:#c8a040;max-width:300px;line-height:1.6">
          This site may block proxies or use advanced protection. Try something else!
        </p>
        <p style="color:#555;font-size:12px">${err.message}</p>
      </body></html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`🧈 Butter Proxy on port ${PORT}`);
  console.log(`🧈 Keep-alive pinging ${SELF_URL}/ping every 4 min`);
});
