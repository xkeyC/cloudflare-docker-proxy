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
    const hostname = new URL(upstream).hostname;
    return DOCKER_REGISTRIES.has(hostname);
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

  const dockerMode = isDockerRegistry(upstream);
  if (dockerMode) {
    if (url.pathname === '/v2/') {
      return handleDockerAuth(upstream, request);
    }
    if (url.pathname === '/v2/auth') {
      return handleDockerToken(upstream, request);
    }
  }
  return forwardRequest(upstream, request);
}

async function handleDockerAuth(upstream, request) {
  const authUrl = new URL(upstream + '/v2/');
  const probeResp = await fetch(authUrl, {
    headers: request.headers,
    redirect: 'manual'
  });

  if (probeResp.status !== 401) {
    return new Response(null, {
      status: probeResp.status,
      headers: probeResp.headers
    });
  }

  const wwwAuth = probeResp.headers.get('WWW-Authenticate') || '';
  const { realm, service, scope } = parseAuthHeader(wwwAuth);
  const proxyRealm = `https://${new URL(request.url).hostname}/v2/auth`;

  const authHeader = [
    `Bearer realm="${proxyRealm}"`,
    `service="${service || 'registry.docker.io'}"`,
    scope ? `scope="${scope}"` : `scope="repository:${getImageName(request)}:pull"`
  ].filter(Boolean).join(', ');

  return new Response(null, {
    status: 401,
    headers: { 'Www-Authenticate': authHeader }
  });
}

async function handleDockerToken(upstream, request) {
  const url = new URL(request.url);
  const authUrl = new URL(upstream + '/v2/');
  const authResp = await fetch(authUrl, { headers: request.headers });
  const wwwAuth = authResp.headers.get('WWW-Authenticate') || '';
  const { realm, service } = parseAuthHeader(wwwAuth);

  const tokenUrl = new URL(realm);
  tokenUrl.searchParams.set('service', service);
  url.searchParams.forEach((v, k) => tokenUrl.searchParams.set(k, v));

  if (!tokenUrl.searchParams.has('scope')) {
    const image = getImageName(request);
    tokenUrl.searchParams.set('scope', `repository:${image}:pull`);
  }

  return fetch(tokenUrl.toString(), {
    headers: {
      'User-Agent': request.headers.get('User-Agent') || '',
      'Accept': 'application/json'
    }
  });
}

function forwardRequest(upstream, request) {
  const url = new URL(request.url);
  const target = new URL(upstream);
  
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
  const params = {};
  header.replace(/Bearer\s+/i, '')
    .split(/,\s*/)
    .forEach(pair => {
      const [key, value] = pair.split('=', 2);
      if (key) params[key] = (value || '').replace(/^"+|"+$/g, '');
    });
  return params;
}

function getImageName(request) {
  const path = new URL(request.url).pathname;
  const match = path.match(/\/v2\/([^\/]+)/);
  let image = match ? match[1] : 'library/nginx';

  if (image.startsWith('_/')) {
    image = `library/${image.slice(2)}`;
  } else if (!image.includes('/')) {
    image = `library/${image}`;
  }

  return image;
}
