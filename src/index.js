addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request).catch(err => {
    console.log(`[Critical Error] ${err.stack}`);
    return new Response("Internal Server Error", { status: 500 });
  }));
});

// 上游路由配置
const routes = {
  "docker-hub-proxy.xkeyc.com": "https://registry-1.docker.io",
  "gcr-hub-proxy.xkeyc.com": "https://gcr.io",
  "ghcr-hub-proxy.xkeyc.com": "https://ghcr.io",
  "docker-ce-proxy.xkeyc.com": "https://download.docker.com",
  "translate-g-proxy.xkeyc.com": "https://translate.googleapis.com"
};

// 调试模式配置
const MODE = "production"; // 更改为 debug 进行本地测试
const LOCAL_ADDRESS = "http://localhost:8787";
const TARGET_UPSTREAM = "https://registry-1.docker.io"; // 调试模式专用上游

function routeByHosts(host) {
  return routes[host] || (MODE === "debug" ? TARGET_UPSTREAM : "");
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const upstream = routeByHosts(url.hostname);
  
  if (!upstream) {
    return new Response(JSON.stringify({ 
      error: "Invalid host", 
      valid_hosts: Object.keys(routes) 
    }), { status: 404 });
  }

  // 特殊端点处理
  if (url.pathname === "/v2/") {
    return handleV2Endpoint(upstream, url);
  }

  if (url.pathname === "/v2/auth") {
    return handleAuthEndpoint(upstream, url);
  }

  // 构造新请求头
  const newHeaders = new Headers(request.headers);
  syncCriticalHeaders(request, newHeaders); // 同步关键头信息

  // 构建上游请求
  const newUrl = new URL(upstream + url.pathname + url.search);
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: newHeaders,
    body: request.body,
    redirect: "follow"
  });

  // 添加调试日志
  if (MODE === "debug") {
    console.log(`Proxying to: ${newUrl}`);
    console.log(`Request headers: ${JSON.stringify([...newHeaders])}`);
  }

  return await fetch(newReq);
}

// 同步关键请求头
function syncCriticalHeaders(originalRequest, newHeaders) {
  const criticalHeaders = [
    'x-amz-content-sha256',
    'authorization',
    'content-type',
    'date'
  ];

  criticalHeaders.forEach(header => {
    const value = originalRequest.headers.get(header);
    if (value) newHeaders.set(header, value);
  });
}

// v2端点处理
async function handleV2Endpoint(upstream, url) {
  const checkUrl = new URL(upstream + "/v2/");
  const resp = await fetch(checkUrl, { method: "GET" });

  if (resp.status === 401) {
    const headers = new Headers();
    const authRealm = MODE === "debug" 
      ? `${LOCAL_ADDRESS}/v2/auth`
      : `https://${url.hostname}/v2/auth`;
    
    headers.set("Www-Authenticate", 
      `Bearer realm="${authRealm}",service="cloudflare-docker-proxy"`);
    
    return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
      status: 401,
      headers: headers
    });
  }
  return resp;
}

// 认证端点处理
async function handleAuthEndpoint(upstream, url) {
  const checkUrl = new URL(upstream + "/v2/");
  const resp = await fetch(checkUrl, { method: "GET" });
  
  if (resp.status !== 401) return resp;
  
  const authHeader = resp.headers.get("WWW-Authenticate");
  if (!authHeader) return resp;

  const wwwAuth = parseAuthenticate(authHeader);
  const tokenUrl = buildTokenUrl(wwwAuth, url.searchParams);
  return await fetch(tokenUrl);
}

// 解析认证头
function parseAuthenticate(header) {
  const params = {};
  header.replace(/(\w+)=("([^"]*)"|([^,]*))/g, (_, k, v) => {
    params[k] = v.replace(/^"(.*)"$/, '$1');
  });
  return params;
}

// 构建令牌URL
function buildTokenUrl(wwwAuth, params) {
  const url = new URL(wwwAuth.realm);
  if (wwwAuth.service) url.searchParams.set("service", wwwAuth.service);
  if (params.get("scope")) url.searchParams.set("scope", params.get("scope"));
  return url;
}
