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

  if (isDockerRegistry(upstream)) {
    if (url.pathname === '/v2/') return handleDockerAuth(upstream, request);
    if (url.pathname === '/v2/auth') return handleDockerToken(upstream, request);
  }
  return forwardRequest(upstream, request);
}

async function handleDockerAuth(upstream, request) {
  const authUrl = new URL(upstream + '/v2/');
  const probeResp = await fetch(authUrl, { headers: request.headers, redirect: 'manual' });

  if (probeResp.status !== 401) {
    return new Response(null, { status: probeResp.status, headers: probeResp.headers });
  }

  const wwwAuth = probeResp.headers.get('WWW-Authenticate') || '';
  const { realm, service } = parseAuthHeader(wwwAuth);
  const proxyRealm = `https://${new URL(request.url).hostname}/v2/auth`;

  const authHeader = [
    `Bearer realm="${proxyRealm}"`,
    `service="${service || 'registry.docker.io'}"`,
    `scope="repository:${getImageName(request)}:pull"`
  ].join(', ');

  return new Response(null, {
    status: 401,
    headers: { 'Www-Authenticate': authHeader }
  });
}

async function handleDockerToken(upstream, request) {
  const url = new URL(request.url);
  const tokenUrl = new URL(parseAuthHeader(
    await (await fetch(new URL(upstream + '/v2/'))).headers.get('WWW-Authenticate') || ''
  ).realm);

  // 强制使用修正后的镜像名称
  if (!url.searchParams.has('scope')) {
    url.searchParams.set('scope', `repository:${getImageName(request)}:pull`);
  }

  // 保留客户端原始参数并追加必要参数
  tokenUrl.search = new URLSearchParams([
    ...tokenUrl.searchParams.entries(),
    ...url.searchParams.entries(),
    ['service', 'registry.docker.io']
  ]).toString();

  return fetch(tokenUrl, {
    headers: {
      'User-Agent': request.headers.get('User-Agent') || '',
      'Accept': 'application/json'
    }
  });
}

function forwardRequest(upstream, request) {
  const target = new URL(upstream);
  const url = new URL(request.url);
  
  target.pathname = url.pathname;
  target.search = url.search;
  
  const headers = new Headers(request.headers);
  headers.set('Host', target.hostname);
  
  return fetch(target.toString(), {
    method: request.method,
    headers: headers,
    redirect: 'follow'
  });
}

function parseAuthHeader(header) {
  return header.replace(/Bearer\s+/i, '').split(/,\s*/).reduce((acc, pair) => {
    const [k, v] = pair.split('=', 2);
    if (k) acc[k] = (v || '').replace(/^"+|"+$/g, '');
    return acc;
  }, {});
}

function getImageName(request) {
  const path = new URL(request.url).pathname;
  let image = (path.match(/\/v2\/([^\/]+)/) || [,'library/nginx'])[1];
  
  // 处理镜像名称转换
  if (image.startsWith('_/')) {
    image = `library/${image.slice(2)}`;
  } else if (!image.includes('/')) {
    image = `library/${image}`;
  }
  
  return image;
}
