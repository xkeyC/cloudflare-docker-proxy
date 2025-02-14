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

function routeByHosts(host) {
  return host in routes ? routes[host] : (MODE === "debug" ? TARGET_UPSTREAM : "");
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const upstream = routeByHosts(url.hostname);
  
  if (!upstream) {
    return new Response(JSON.stringify({ routes }), { status: 404 });
  }

  // 修复请求头
  const headers = new Headers(request.headers);
  const upstreamUrl = new URL(upstream);
  headers.set("Host", upstreamUrl.hostname);

  // 构造新请求
  const newReq = new Request(upstream + url.pathname + url.search, {
    method: request.method,
    headers: headers,
    redirect: "follow",
    body: request.body
  });

  const response = await fetch(newReq);
  
  const contentType = response.headers.get("content-type") || "";
  const isJSON = contentType.includes("json") || await checkJSONPrefix(response.clone());

  if (isJSON) {
    let text = await response.text();
    Object.entries(routes).forEach(([proxyHost, targetUrl]) => {
      text = text.replaceAll(new URL(targetUrl).hostname, proxyHost);
    });
    
    const newHeaders = new Headers(response.headers);
    newHeaders.delete("content-length");
    
    return new Response(text, {
      status: response.status,
      headers: newHeaders
    });
  }

  // 非JSON响应：流式处理
  const { readable, writable } = new TransformStream();
  response.body.pipeTo(writable);
  
  return new Response(readable, response);
}

async function checkJSONPrefix(response) {
  const reader = response.body.getReader();
  const { value } = await reader.read();
  return value?.some(v => 
    String.fromCharCode(v).trim().match(/^(\{|\[)/)
  );
}