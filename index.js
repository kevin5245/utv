import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const API_TOKEN = process.env.WEB_LIVE_API_TOKEN || '';
const DOUYIN_COOKIE = process.env.DOUYIN_COOKIE || '';
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '12000', 10);
const BROWSER_UA = process.env.BROWSER_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PLATFORM_HOST_ALLOWLIST = {
  huya: [/\.huya\.com$/i, /^huya\.com$/i, /\.msstatic\.com$/i, /^msstatic\.com$/i],
  bilibili: [/\.bilibili\.com$/i, /^bilibili\.com$/i, /\.bilivideo\.com$/i, /^bilivideo\.com$/i],
  douyin: [/\.douyin\.com$/i, /^douyin\.com$/i, /\.douyincdn\.com$/i, /^douyincdn\.com$/i, /\.bytegoofy\.com$/i, /^bytegoofy\.com$/i, /\.bytedance\.com$/i, /^bytedance\.com$/i]
};

const dataFile = path.join(__dirname, 'data.json');
let appData = { settings: { intervalMinutes: 10 }, channels: [] };
if (fs.existsSync(dataFile)) {
  try { appData = JSON.parse(fs.readFileSync(dataFile, 'utf-8')); } catch (e) {}
}
const saveAppData = () => fs.writeFileSync(dataFile, JSON.stringify(appData, null, 2));

function json(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...extraHeaders });
  res.end(payload);
}

function text(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function requireAuth(req, res, url) {
  if (!API_TOKEN) return true;
  if (url && url.searchParams.get('token') === API_TOKEN) return true;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-token'];
  if (token === API_TOKEN) return true;
  json(res, 401, { error: 'unauthorized' });
  return false;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
}

function getRequestOrigin(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function proxyUrl(req, streamUrl, type, platform) {
  const origin = getRequestOrigin(req);
  const params = new URLSearchParams({ url: streamUrl, platform });
  return `${origin}/proxy/${type}?${params.toString()}`;
}

function getHuyaAntiCode(oldAntiCode, streamName) {
  const paramsT = 100; const sdkVersion = 2403051612; const now = Date.now(); const sdkSid = now;
  const initUuid = (Math.floor((now % 10000000000) * 1000) + Math.floor(1000 * Math.random())) % 4294967295;
  const uid = Math.floor(Math.random() * (1400009999999 - 1400000000000 + 1)) + 1400000000000;
  const seqId = uid + sdkSid; const targetUnixTime = Math.floor((now + 110624) / 1000);
  const wsTime = targetUnixTime.toString(16).toLowerCase();
  const urlQuery = new URLSearchParams(oldAntiCode); const fm = urlQuery.get('fm');
  if (!fm) return oldAntiCode;
  const wsSecretPrefix = Buffer.from(decodeURIComponent(fm), 'base64').toString().split('_')[0];
  const wsSecretHash = crypto.createHash('md5').update(`${seqId}|${urlQuery.get('ctype')}|${paramsT}`).digest('hex');
  const wsSecret = `${wsSecretPrefix}_${uid}_${streamName}_${wsSecretHash}_${wsTime}`;
  const wsSecretMd5 = crypto.createHash('md5').update(wsSecret).digest('hex');
  return `wsSecret=${wsSecretMd5}&wsTime=${wsTime}&seqid=${seqId}&ctype=${urlQuery.get('ctype')}&ver=1&fs=${urlQuery.get('fs')}&uuid=${initUuid}&u=${uid}&t=${paramsT}&sv=${sdkVersion}&sdk_sid=${sdkSid}&codec=264`;
}

async function resolveHuya(roomId) {
  const response = await fetchWithTimeout(`https://www.huya.com/${encodeURIComponent(roomId)}`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const match = html.match(/stream:\s*(\{"data".*?),"iWebDefaultBitRate"/);
  if (!match) throw new Error('未找到直播数据');
  const payload = JSON.parse(`${match[1]}}`);
  const gameLiveInfo = payload.data?.[0]?.gameLiveInfo;
  const streamInfo = payload.data?.[0]?.gameStreamInfoList?.[0];
  if (!streamInfo) throw new Error('直播未开启');
  return { platform: 'huya', type: 'flv', originalUrl: `${streamInfo.sFlvUrl}/${streamInfo.sStreamName}.${streamInfo.sFlvUrlSuffix}?${getHuyaAntiCode(streamInfo.sFlvAntiCode, streamInfo.sStreamName)}`, name: gameLiveInfo?.nick || '', title: gameLiveInfo?.introduction || '' };
}

async function resolveBilibili(roomId) {
  const headers = { 'User-Agent': BROWSER_UA, 'Referer': 'https://live.bilibili.com/' };
  const roomInitRes = await fetchWithTimeout(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(roomId)}`, { headers });
  const roomInitData = await roomInitRes.json();
  if (roomInitData.code !== 0) throw new Error(roomInitData.message);
  if (roomInitData.data.live_status !== 1) throw new Error('直播未开启');
  const realRoomId = roomInitData.data.room_id;
  const playInfoRes = await fetchWithTimeout(`https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${realRoomId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`, { headers });
  const playInfoData = await playInfoRes.json();
  if (playInfoData.code !== 0) throw new Error(playInfoData.message);
  const streamList = playInfoData.data?.playurl_info?.playurl?.stream || [];
  for (const stream of streamList) {
    for (const format of stream.format || []) {
      if (format.format_name !== 'ts') continue;
      for (const codec of format.codec || []) {
        const urlInfo = codec.url_info?.[0];
        if (urlInfo?.host && codec.base_url) return { platform: 'bilibili', type: 'm3u8', originalUrl: `${urlInfo.host}${codec.base_url}${urlInfo.extra || ''}`, name: '', title: '' };
      }
    }
  }
  throw new Error('未找到m3u8地址');
}

async function resolveDouyin(roomId) {
  const headers = { 'User-Agent': BROWSER_UA, 'Referer': 'https://live.douyin.com/' };
  if (DOUYIN_COOKIE) headers.Cookie = DOUYIN_COOKIE;
  const params = new URLSearchParams({ aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', web_rid: roomId });
  const response = await fetchWithTimeout(`https://live.douyin.com/webcast/room/web/enter/?${params.toString()}`, { headers });
  const data = await response.json();
  const roomData = data.data?.data?.[0];
  if (!roomData) throw new Error('获取失败');
  if (roomData.status !== 2) throw new Error('直播未开启');
  const hlsPullUrlMap = roomData.stream_url?.hls_pull_url_map;
  if (!hlsPullUrlMap) throw new Error('未找到地址');
  const originalUrl = hlsPullUrlMap.ORIGIN || hlsPullUrlMap.FULL_HD1 || hlsPullUrlMap.HD1 || Object.values(hlsPullUrlMap)[0];
  return { platform: 'douyin', type: 'm3u8', originalUrl, name: data.data?.user?.nickname || '', title: roomData.title || '' };
}

async function resolveStream(platform, roomId) {
  if (platform === 'huya') return resolveHuya(roomId);
  if (platform === 'bilibili') return resolveBilibili(roomId);
  if (platform === 'douyin') return resolveDouyin(roomId);
  throw new Error(`不支持的平台: ${platform}`);
}

function getReferer(platform, targetUrl) {
  if (platform === 'bilibili' || targetUrl.includes('bilibili.com')) return 'https://live.bilibili.com/';
  if (platform === 'douyin' || targetUrl.includes('douyin.com')) return 'https://live.douyin.com/';
  return 'https://www.huya.com/';
}

async function handleStream(req, res, url) {
  if (!requireAuth(req, res, url)) return;
  const platform = url.searchParams.get('platform') || '';
  const roomId = url.searchParams.get('roomId') || '';
  const isDirect = url.searchParams.get('direct') === '1';

  if (!platform || !roomId) return json(res, 400, { error: '缺少 platform 或 roomId' });
  const stream = await resolveStream(platform, roomId);
  const proxiedUrl = proxyUrl(req, stream.originalUrl, stream.type, stream.platform);
  
  const targetUrl = isDirect ? stream.originalUrl : proxiedUrl;
  
  res.writeHead(302, { Location: targetUrl });
  res.end();
}

async function handleProxy(_req, res, url) {
  const targetUrl = url.searchParams.get('url');
  const platform = url.searchParams.get('platform') || '';
  if (!targetUrl) return json(res, 400, { error: '缺少 url 参数' });
  const response = await fetchWithTimeout(targetUrl, { headers: { 'User-Agent': BROWSER_UA, 'Referer': getReferer(platform, targetUrl) } });
  if (!response.ok) return json(res, 502, { error: `请求失败: HTTP ${response.status}` });
  
  const contentType = response.headers.get('content-type') || '';
  res.writeHead(200, { 'Content-Type': contentType || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  if (!response.body) return res.end();
  
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function generatePlaylist(req, res, format) {
  if (!requireAuth(req, res, new URL(req.url, `http://${req.headers.host}`))) return;
  const origin = getRequestOrigin(req);
  const tokenStr = API_TOKEN ? `&token=${API_TOKEN}` : '';
  
  if (format === 'm3u') {
    let out = "#EXTM3U\n";
    appData.channels.forEach(ch => {
      const directStr = ch.playMode === 'direct' ? '&direct=1' : '';
      const url = `${origin}/stream?platform=${ch.platform}&roomId=${ch.roomId}${tokenStr}${directStr}`;
      out += `#EXTINF:-1 group-title="${ch.group || '默认'}",${ch.name}\n${url}\n`;
    });
    return text(res, 200, out, 'application/vnd.apple.mpegurl; charset=utf-8');
  } 
  
  if (format === 'txt') {
    const groups = {};
    appData.channels.forEach(ch => {
      if (!groups[ch.group]) groups[ch.group] = [];
      const directStr = ch.playMode === 'direct' ? '&direct=1' : '';
      groups[ch.group].push(`${ch.name},${origin}/stream?platform=${ch.platform}&roomId=${ch.roomId}${tokenStr}${directStr}`);
    });
    let out = "";
    for (const g in groups) {
      out += `${g || '默认'},#genre#\n` + groups[g].join('\n') + '\n';
    }
    return text(res, 200, out, 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    
    if (url.pathname === '/admin') {
      if (!requireAuth(req, res, url)) return;
      const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf-8');
      return text(res, 200, html, 'text/html; charset=utf-8');
    }
    
    if (url.pathname === '/api/config') {
      if (!requireAuth(req, res, url)) return;
      if (req.method === 'GET') return json(res, 200, appData);
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
          appData = JSON.parse(body);
          saveAppData();
          json(res, 200, { success: true });
        });
        return;
      }
    }

    if (url.pathname === '/playlist.m3u') return generatePlaylist(req, res, 'm3u');
    if (url.pathname === '/playlist.txt') return generatePlaylist(req, res, 'txt');

    if (url.pathname === '/stream') return await handleStream(req, res, url);
    if (url.pathname.startsWith('/proxy/')) return await handleProxy(req, res, url);
    if (url.pathname === '/' || url.pathname === '/health') return json(res, 200, { ok: true, admin: '/admin' });
    
    return json(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message });
  }
});

setInterval(async () => {
  for (const ch of appData.channels) {
    try {
      await resolveStream(ch.platform, ch.roomId);
      ch.status = 'online';
    } catch (error) {
      ch.status = 'offline';
    }
  }
  saveAppData();
}, (appData.settings.intervalMinutes || 10) * 60000);

server.listen(PORT, HOST, () => {
  console.log(`MoonTVPlus live manager started on http://${HOST}:${PORT}/admin`);
});
