addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const DOCKER_HUB_UPSTREAM = "https://registry-1.docker.io";

const routes = {
  "docker-hub-proxy.xkeyc.com": DOCKER_HUB_UPSTREAM,
  "gcr-hub-proxy.xkeyc.com": "https://gcr.io",
  "ghcr-hub-proxy.xkeyc.com": "https://ghcr.io",
  "docker-ce-proxy.xkeyc.com": "https://download.docker.com",
  "translate-g-proxy.xkeyc.com": "https://translate.googleapis.com"
};



function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
  if (MODE == "debug") {
    return TARGET_UPSTREAM;
  }
  return "";
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const upstream = routeByHosts(url.hostname);
  
  if (upstream === "") {
    return new Response(
      JSON.stringify({ routes: routes }),
      { status: 404 }
    );
  }

  // Authentication check logic
  if (url.pathname == "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      redirect: "follow",
    });
    
    if (resp.status === 401) {
      const headers = new Headers();
      const authRealm = MODE == "debug" 
        ? `${LOCAL_ADDRESS}/v2/auth` 
        : `https://${url.hostname}/v2/auth`;
      
      headers.set(
        "Www-Authenticate",
        `Bearer realm="${authRealm}",service="cloudflare-docker-proxy"`
      );
      return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
        status: 401,
        headers: headers,
      });
    }
    return resp;
  }

  // Token endpoint
  if (url.pathname == "/v2/auth") {
    const newUrl = new URL(upstream + "/v2/");
    const resp = await fetch(newUrl.toString(), { method: "GET" });
    
    if (resp.status === 401) {
      const authenticateStr = resp.headers.get("WWW-Authenticate");
      if (authenticateStr) {
        const wwwAuthenticate = parseAuthenticate(authenticateStr);
        return fetchToken(wwwAuthenticate, url.searchParams);
      }
    }
    return resp;
  }

  // Prepare upstream request
  const newUrl = new URL(upstream + url.pathname + url.search);
  const headers = new Headers(request.headers);

  // Special handling for Docker Hub
  if (upstream === DOCKER_HUB_UPSTREAM) {
    if (!headers.has("x-amz-content-sha256")) {
      headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
    }
  }

  const newReq = new Request(newUrl, {
    method: request.method,
    headers: headers,
    redirect: "follow",
    body: request.body
  });

  return await fetch(newReq);
}

function parseAuthenticate(authenticateStr) {
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  
  if (!matches || matches.length < 2) {
    throw new Error(`Invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, searchParams) {
  const url = new URL(wwwAuthenticate.realm);
  url.searchParams.set("service", wwwAuthenticate.service);
  
  if (searchParams.get("scope")) {
    url.searchParams.set("scope", searchParams.get("scope"));
  }
  
  return await fetch(url.toString());
}
