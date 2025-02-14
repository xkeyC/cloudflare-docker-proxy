addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const UPSTREAM_MAP = {
  "docker-hub-proxy.xkeyc.com": "https://registry-1.docker.io",
  "gcr-hub-proxy.xkeyc.com": "https://gcr.io",
  "ghcr-hub-proxy.xkeyc.com": "https://ghcr.io"
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const upstream = UPSTREAM_MAP[url.hostname]

  if (!upstream) {
    return new Response('Invalid proxy domain', { status: 404 })
  }

  // 直接转发请求
  const target = new URL(upstream)
  target.pathname = url.pathname
  target.search = url.search

  const headers = new Headers(request.headers)
  headers.set('Host', target.hostname)  // 关键头信息修正

  const response = await fetch(target.toString(), {
    method: request.method,
    headers: headers,
    redirect: 'manual'
  })

  // 处理认证路由重定向
  if (response.status === 401) {
    const wwwAuth = response.headers.get('WWW-Authenticate')
    if (wwwAuth) {
      const newAuth = wwwAuth.replace(
        /realm="https?:\/\/[^\/]+/,
        `realm="https://${url.hostname}/v2/auth`
      )
      headers.set('WWW-Authenticate', newAuth)
    }
    return new Response(null, {
      status: 401,
      headers: headers
    })
  }

  return response
}
