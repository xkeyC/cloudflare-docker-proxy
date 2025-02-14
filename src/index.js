addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const routes = {
  "docker-hub-proxy.xkeyc.com": "https://registry-1.docker.io",
  "gcr-hub-proxy.xkeyc.com": "https://gcr.io",
  "ghcr-hub-proxy.xkeyc.com": "https://ghcr.io",
  "docker-ce-proxy.xkeyc.com": "https://download.docker.com",
  "translate-g-proxy.xkeyc.com": "https://translate.googleapis.com"
};

// 配置参数
const MODE = "release"; // 或 "debug"
const LOCAL_ADDRESS = "http://localhost:8787";
const TARGET_UPSTREAM = "https://registry-1.docker.io";

function routeByHosts(host) {
  return routes[host] || (MODE === "debug" ? TARGET_UPSTREAM : "");
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const upstream = routeByHosts(url.hostname);
  
  if (!upstream) {
    return new Response(JSON.stringify({ routes }), { status: 404 });
  }

  // 认证检查
  if (url.pathname === "/v2/") {
    const authCheck = await checkAuth(upstream);
    if (authCheck) return authCheck;
  }

  // Token获取
  if (url.pathname === "/v2/auth") {
    return handleAuth(upstream, url.searchParams);
  }

  // 请求转发
  return forwardRequest(request, upstream);
}

async function checkAuth(upstream) {
  const resp = await fetch(`${upstream}/v2/`, { method: "GET" });
  if (resp.status !== 401) return resp;

  const authHeader = resp.headers.get("Www-Authenticate");
  if (!authHeader) return resp;

  const headers = new Headers();
  const realm = MODE === "debug" 
    ? `${LOCAL_ADDRESS}/v2/auth` 
    : `https://${new URL(upstream).hostname}/v2/auth`;
  
  headers.set("Www-Authenticate", `Bearer realm="${realm}",service="cloudflare-docker-proxy"`);
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), { status: 401, headers });
}

async function handleAuth(upstream, searchParams) {
  const authCheck = await fetch(`${upstream}/v2/`, { method: "GET" });
  if (authCheck.status !== 401) return authCheck;

  const authHeader = authCheck.headers.get("Www-Authenticate");
  if (!authHeader) return authCheck;

  const wwwAuth = parseAuthenticate(authHeader);
  const tokenUrl = new URL(wwwAuth.realm);
  tokenUrl.searchParams.set("service", wwwAuth.service);
  if (searchParams.get("scope")) tokenUrl.searchParams.set("scope", searchParams.get("scope"));

  return fetch(tokenUrl);
}

async function forwardRequest(originalReq, upstream) {
  const url = new URL(originalReq.url);
  const newUrl = new URL(upstream + url.pathname + url.search);
  const isDockerHub = upstream.startsWith("https://registry-1.docker.io");

  const headers = new Headers();

  const keepHeaders = ["authorization", "content-type", "accept", "user-agent"];
  for (const h of keepHeaders) {
    const val = originalReq.headers.get(h);
    if (val) headers.set(h, val);
  }
  if (isDockerHub) {
    const contentSha = originalReq.headers.get("x-amz-content-sha256");
    headers.set("x-amz-content-sha256", contentSha || "UNSIGNED-PAYLOAD");
  }
  const newReq = new Request(newUrl, {
    method: originalReq.method,
    headers: headers,
    body: originalReq.body,
    redirect: "follow"
  });

  return fetch(newReq);
}

function parseAuthenticate(header) {
  const realmMatch = header.match(/realm="([^"]+)"/);
  const serviceMatch = header.match(/service="([^"]+)"/);
  return {
    realm: realmMatch ? realmMatch[1] : "",
    service: serviceMatch ? serviceMatch[1] : ""
  };
}
