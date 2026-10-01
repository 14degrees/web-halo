/* Emscripten FetchFS currently joins its base URL to a root-level file path
 * with two slashes. Local development servers commonly normalize that path,
 * while object storage treats it as a different key. Install this tiny shim in
 * every game worker so map requests use the canonical object-storage URL. */
;(function installHaloFetchPathNormalization(scope) {
  "use strict";

  if (!scope || typeof scope.fetch !== "function" || scope.__haloFetchNormalized) {
    return;
  }

  const nativeFetch = scope.fetch.bind(scope);
  scope.fetch = async function haloFetch(resource, options) {
    const originalUrl = typeof resource === "string" || resource instanceof URL
      ? String(resource)
      : resource && resource.url;
    let isMapRequest = false;

    if (originalUrl) {
      const normalizedUrl = new URL(originalUrl, scope.location.href);
      const canonicalPath = normalizedUrl.pathname.replace(
        /\/assets\/maps\/{2,}/g,
        "/assets/maps/"
      );
      if (canonicalPath !== normalizedUrl.pathname) {
        normalizedUrl.pathname = canonicalPath;
        resource = resource instanceof Request
          ? new Request(normalizedUrl.href, resource)
          : normalizedUrl.href;
      }
      isMapRequest = canonicalPath.includes("/assets/maps/");
    }

    const response = await nativeFetch(resource, options);
    const method = String(
      options && options.method || resource instanceof Request && resource.method || "GET"
    ).toUpperCase();

    /* CloudFront serves byte ranges for these objects but does not include
     * Accept-Ranges on its HEAD response. FetchFS interprets that omission as
     * "download the entire map into one JavaScript allocation", which is both
     * memory-heavy and unreliable for the large campaign maps. Advertise the
     * capability FetchFS is about to use; every range response is still checked
     * normally by fetch before its bytes are consumed. */
    if (isMapRequest && method === "HEAD" && response.ok &&
        response.headers.has("Content-Length") &&
        !response.headers.has("Accept-Ranges")) {
      const headers = new Headers(response.headers);
      headers.set("Accept-Ranges", "bytes");
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    return response;
  };
  scope.__haloFetchNormalized = true;
})(globalThis);
