addEventListener('fetch', event => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const DOCKER_REGISTRIES = new Set([
  'registry-1.docker.io',
  'gcr.io',
  'ghcr.io'
]);

const routes = {
  "docker-hub-proxy.xkeyc.com": "https://registry-1.docker.io",
  "gcr-hub-proxy.xkeyc.com": "https://gcr.io",
  "ghcr-hub-proxy.xkeyc.com": "https://ghcr.io",
  "docker-ce-proxy.xkeyc.com": "https://download.docker.com",
  "translate-g-proxy.xkeyc.com": "https://translate.googleapis.com"
};

function getUpstream(host) {
  return routes[host] || (MODE === "debug" ? TARGET_UPSTREAM : null);
}

function isDockerRegistry(upstream) {
  try {
    return DOCKER_REGISTRIES.has(new URL(upstream).hostname);
  } catch {
    return false;
  }
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const upstream = getUpstream(url.hostname);
  
  if (!upstream) {
    return new Response(JSON.stringify({ routes }), { 
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 保留原始UA
  const headers = new Headers(request.headers);
  const userAgent = headers.get('User-Agent') || '';

  // 判断是否进入Docker模式
  const dockerMode = isDockerRegistry(upstream);

  // Docker认证处理
  if (dockerMode) {
    if (url.pathname === '/v2/') {
      return handleDockerAuthCheck(upstream, url, headers);
    }
    
    if (url.pathname === '/v2/auth') {
      return handleDockerToken(upstream, request, headers);
    }
  }

  // 普通请求转发
  const targetUrl = new URL(upstream);
  targetUrl.pathname = url.pathname;
  targetUrl.search = url.search;

  // 修正Host头
  headers.set('Host', targetUrl.hostname);

  return fetch(new Request(targetUrl, {
    method: request.method,
    headers: headers,
    redirect: 'follow'
  }));
}

async function handleDockerAuthCheck(upstream, url, headers) {
  // 探测上游/v2/端点
  const probeUrl = new URL(upstream + '/v2/');
  const probeResp = await fetch(probeUrl, { 
    headers: headers,
    redirect: 'manual'
  });

  if (probeResp.status !== 401) {
    return new Response(null, { 
      status: probeResp.status,
      headers: probeResp.headers
    });
  }

  // 构造认证头
  const authHeader = probeResp.headers.get('WWW-Authenticate') || '';
  const service = authHeader.match(/service="([^"]+)"/)?.[1] || 'docker.io';
  
  const authHeaders = new Headers({
    'Www-Authenticate': `Bearer realm="https://${url.hostname}/v2/auth",service="${service}"`
  });

  return new Response(JSON.stringify({ status: 'UNAUTHORIZED' }), {
    status: 401,
    headers: authHeaders
  });
}

async function handleDockerToken(upstream, request, headers) {
  const url = new URL(request.url);
  const authUrl = new URL(upstream + '/v2/');
  
  // 获取上游认证头
  const authResp = await fetch(authUrl, { headers });
  const authHeader = authResp.headers.get('WWW-Authenticate') || '';
  
  // 解析认证参数
  const params = parseAuthHeader(authHeader);
  const tokenUrl = new URL(params.realm);
  
  // 保留客户端传递的所有参数
  url.searchParams.forEach((value, key) => {
    tokenUrl.searchParams.set(key, value);
  });

  // 自动补充scope
  if (!tokenUrl.searchParams.has('scope')) {
    const pathMatch = request.headers.get('Referer')?.match(/\/v2\/([^\/]+)/);
    if (pathMatch) {
      tokenUrl.searchParams.set('scope', `repository:${pathMatch[1]}:pull`);
    }
  }

  // 转发token请求（保留原始UA）
  return fetch(tokenUrl.toString(), {
    headers: { 'User-Agent': headers.get('User-Agent') || '' }
  });
}

function parseAuthHeader(header) {
  const params = {};
  header.replace(/Bearer\s+/i, '')
    .split(/,\s*/)
    .forEach(pair => {
      const [key, value] = pair.split('=', 2);
      params[key] = value?.replace(/^"+|"+$/g, '') || '';
    });
  return params;
}
