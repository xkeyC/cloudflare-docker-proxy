addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const routes = {
  "docker-hub-proxy.xkeyc.com": "https://registry-1.docker.io",
  "gcr-hub-proxy.xkeyc.com": "https://gcr.io",
  "ghcr-hub-proxy.xkeyc.com": "https://ghcr.io",
  "docker-ce-proxy.xkeyc.com": "https://download.docker.com",
  "translate-g-proxy.xkeyc.com": "https://translate.googleapis.com"
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const upstream = routeByHosts(url.hostname)
  
  if (upstream.includes('registry-1.docker.io')) {
    const authResponse = await handleDockerAuth(url, request)
    if (authResponse) return authResponse
  }

  const proxyRequest = buildProxyRequest(request, upstream)
  
  const response = await fetch(proxyRequest)
  return processProxyResponse(response, upstream, url.hostname)
}

function routeByHosts(host) {
  return routes[host] || (typeof MODE !== 'undefined' && MODE === 'debug' ? TARGET_UPSTREAM : null)
}

async function handleDockerAuth(url, request) {
  if (url.pathname === '/v2/') {
    return new Response(null, {
      status: 401,
      headers: {
        'Www-Authenticate': `Bearer realm="https://${url.hostname}/v2/auth",service="registry.docker.io"`
      }
    })
  }

  if (url.pathname === '/v2/auth') {
    const authUrl = new URL('https://auth.docker.io/token')
    authUrl.search = url.search
    return fetch(authUrl.toString())
  }
  
  return null
}

// 构造代理请求
function buildProxyRequest(originalRequest, upstream) {
  const url = new URL(originalRequest.url)
  const headers = new Headers(originalRequest.headers)
  
  const target = new URL(upstream)
  headers.set('Host', target.hostname)

  return new Request(target.origin + url.pathname + url.search, {
    method: originalRequest.method,
    headers: headers,
    body: originalRequest.body
  })
}

// 处理代理响应
async function processProxyResponse(response, upstream, proxyHost) {
  // JSON响应处理
  if (await isJsonResponse(response)) {
    const text = await response.text()
    const modified = replaceUpstreamUrls(text, upstream, proxyHost)
    
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    
    return new Response(modified, {
      status: response.status,
      headers: headers
    })
  }

  return new Response(response.body, {
    status: response.status,
    headers: response.headers
  })
}

// 判断JSON响应
async function isJsonResponse(response) {
  const contentType = response.headers.get('content-type') || ''
  if (/json|text\/plain/.test(contentType)) return true
  
  const reader = response.clone().body.getReader()
  const { value } = await reader.read()
  return value && /^[\s\r\n]*[\{\[]/.test(String.fromCharCode(...value.slice(0, 1000)))
}

function replaceUpstreamUrls(text, upstream, proxyHost) {
  const targetHost = new URL(upstream).hostname
  const replacements = [
    { from: `https://${targetHost}`, to: `https://${proxyHost}` },
    { from: targetHost, to: proxyHost }
  ]
  
  replacements.forEach(({ from, to }) => {
    const regex = new RegExp(escapeRegExp(from), 'g')
    text = text.replace(regex, to)
  })
  
  return text
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}