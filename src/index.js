const customDomain = 'xkeyc.com'

const dockerHub = 'https://registry-1.docker.io'
const routes = {
  // Docker 相关代理
  [customDomain]: dockerHub,
  ['docker-hub-proxy.' + customDomain]: dockerHub,
  ['quay-proxy.' + customDomain]: 'https://quay.io',
  ['gcr-proxy.' + customDomain]: 'https://gcr.io',
  ['k8s-gcr-proxy.' + customDomain]: 'https://k8s.gcr.io',
  ['k8s-proxy.' + customDomain]: 'https://registry.k8s.io',
  ['ghcr-proxy.' + customDomain]: 'https://ghcr.io',
  ['cloudsmith-proxy.' + customDomain]: 'https://docker.cloudsmith.io',
  ['ecr-proxy.' + customDomain]: 'https://public.ecr.aws',
  ['docker-staging.' + customDomain]: dockerHub,
  ['docker-ce-proxy.' + customDomain]: "https://download.docker.com",
  ['github-proxy.' + customDomain]: "https://github.com"
}

function routeByHosts(host) {
  if (host in routes) {
    return routes[host]
  }
  if (MODE == "debug") {
    return TARGET_UPSTREAM
  }
  return ''
}

export default {
  async fetch(request) {
    const url = new URL(request.url)

    // 添加根路径重定向
    if (url.pathname == '/') {
      return Response.redirect(url.protocol + '//' + url.host + '/v2/', 301)
    }

    const upstream = routeByHosts(url.hostname)

    if (upstream === '') {
      return new Response(JSON.stringify({ routes: routes }), { status: 404 })
    }

    // Handle GitHub proxy
    if (upstream === "https://github.com") {
      return handleGitHubProxy(request, url, upstream)
    }

    const isDockerHub = upstream == dockerHub
    const authorization = request.headers.get('Authorization')
    if (url.pathname == '/v2/') {
      const newUrl = new URL(upstream + '/v2/')
      const headers = new Headers()
      if (authorization) {
        headers.set('Authorization', authorization)
      }

      const resp = await fetch(newUrl.toString(), {
        method: 'GET',
        headers: headers,
        redirect: 'follow',
      })

      if (resp.status === 401) {
        return responseUnauthorized(url)
      }

      return resp
    }

    if (url.pathname == '/v2/auth') {
      const newUrl = new URL(upstream + '/v2/')
      const resp = await fetch(newUrl.toString(), {
        method: 'GET',
        redirect: 'follow',
      })

      if (resp.status !== 401) {
        return resp
      }

      const authenticateStr = resp.headers.get('WWW-Authenticate')
      if (authenticateStr === null) {
        return resp
      }

      const wwwAuthenticate = parseAuthenticate(authenticateStr)
      let scope = url.searchParams.get('scope')

      // autocomplete repo part into scope for DockerHub library images
      // Example: repository:busybox:pull => repository:library/busybox:pull
      if (scope && isDockerHub) {
        let scopeParts = scope.split(':')
        if (scopeParts.length == 3 && !scopeParts[1].includes('/')) {
          scopeParts[1] = 'library/' + scopeParts[1]
          scope = scopeParts.join(':')
        }
      }

      return await fetchToken(wwwAuthenticate, scope, authorization)
    }

    // redirect for DockerHub library images
    // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
    if (isDockerHub) {
      const pathParts = url.pathname.split('/')
      if (pathParts.length == 5) {
        pathParts.splice(2, 0, 'library')
        const redirectUrl = new URL(url)
        redirectUrl.pathname = pathParts.join('/')

        return Response.redirect(redirectUrl, 301)
      }
    }

    // foward requests
    const newUrl = new URL(upstream + url.pathname)
    const newReq = new Request(newUrl, {
      method: request.method,
      headers: request.headers,
      // don't follow redirect to dockerhub blob upstream
      redirect: isDockerHub ? 'manual' : 'follow',
    })

    const resp = await fetch(newReq)
    if (resp.status == 401) {
      return responseUnauthorized(url)
    }

    // handle dockerhub blob redirect manually
    if (isDockerHub && resp.status == 307) {
      const location = new URL(resp.headers.get('Location'))
      const redirectResp = await fetch(location.toString(), {
        method: 'GET',
        redirect: 'follow',
      })
      return redirectResp
    }

    return resp
  },
}

async function handleGitHubProxy(request, url, upstream) {
  const userAgent = request.headers.get("User-Agent") || ""

  // 只允许 git 客户端访问,拒绝浏览器
  // Git 客户端的 User-Agent 通常包含 "git"
  const isGitClient = userAgent.toLowerCase().includes("git")

  if (!isGitClient) {
    return new Response(
      JSON.stringify({
        error: "Access Denied",
        message: "This proxy only supports git clone operations. Web browser access is not allowed.",
        usage: "git clone https://" + url.hostname + "/owner/repo.git"
      }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json"
        }
      }
    )
  }

  // 转发 git 请求到 GitHub
  const newUrl = new URL(upstream + url.pathname + url.search)
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow",
  })

  return await fetch(newReq)
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g
  const matches = authenticateStr.match(re)

  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`)
  }

  return {
    realm: matches[0],
    service: matches[1],
  }
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm)
  if (wwwAuthenticate.service.length) {
    url.searchParams.set('service', wwwAuthenticate.service)
  }

  if (scope) {
    url.searchParams.set('scope', scope)
  }

  const headers = new Headers()
  if (authorization) {
    headers.set('Authorization', authorization)
  }

  return await fetch(url, { method: 'GET', headers: headers })
}

function responseUnauthorized(url) {
  const headers = new Headers()

  headers.set(
    'Www-Authenticate',
    `Bearer realm="https://${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`
  )

  return new Response(JSON.stringify({ message: 'UNAUTHORIZED' }), {
    status: 401,
    headers: headers,
  })
}
