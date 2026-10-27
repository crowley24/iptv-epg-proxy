
const EPG_URL = 'http://only4.tv/epg/epg.xml';
const CACHE_TTL = 1800;

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
    };
}

function response(body, status, contentType) {
    return new Response(body, {
        status,
        headers: {
            ...corsHeaders(),
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        }
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return response('Method not allowed', 405, 'text/plain; charset=utf-8');
        }

        if (url.pathname === '/health') {
            return response(JSON.stringify({
                success: true,
                service: 'IPTV EPG Proxy',
                version: '1.0.0',
                source: EPG_URL,
                endpoint: '/epg.xml'
            }, null, 2), 200, 'application/json; charset=utf-8');
        }

        if (url.pathname !== '/' && url.pathname !== '/epg.xml') {
            return response('Not found', 404, 'text/plain; charset=utf-8');
        }

        const cacheKey = new Request(
            new URL('/__epg_cache_v1', url.origin).toString(),
            { method: 'GET' }
        );

        try {
            const cached = await caches.default.match(cacheKey);

            if (cached) {
                return request.method === 'HEAD'
                    ? new Response(null, {
                        status: cached.status,
                        headers: cached.headers
                    })
                    : cached;
            }

            const upstream = await fetch(EPG_URL, {
                method: 'GET',
                headers: {
                    'Accept': 'application/xml, text/xml, */*',
                    'User-Agent': 'Mozilla/5.0 (compatible; IPTV-EPG-Proxy/1.0)'
                },
                signal: AbortSignal.timeout(25000),
                redirect: 'follow'
            });

            if (!upstream.ok) {
                return response(
                    'EPG source returned HTTP ' + upstream.status,
                    502,
                    'text/plain; charset=utf-8'
                );
            }

            const contentType = upstream.headers.get('content-type') || '';

            if (
                contentType.includes('text/html') ||
                contentType.includes('application/json')
            ) {
                return response(
                    'EPG source returned an unexpected content type: ' + contentType,
                    502,
                    'text/plain; charset=utf-8'
                );
            }

            const xml = await upstream.text();

            if (
                !xml.trim() ||
                !/<(?:\w+:)?tv(?:\s|>)/i.test(xml) ||
                !/<(?:\w+:)?(?:channel|programme)(?:\s|>)/i.test(xml)
            ) {
                return response(
                    'EPG source did not return valid XMLTV data.',
                    502,
                    'text/plain; charset=utf-8'
                );
            }

            const result = new Response(xml, {
                status: 200,
                headers: {
                    ...corsHeaders(),
                    'Content-Type': 'application/xml; charset=utf-8',
                    'Cache-Control': 'public, max-age=' + CACHE_TTL,
                    'X-EPG-Proxy': 'iptv-epg-proxy-v1'
                }
            });

            ctx.waitUntil(
                caches.default.put(cacheKey, result.clone())
            );

            return request.method === 'HEAD'
                ? new Response(null, {
                    status: 200,
                    headers: result.headers
                })
                : result;

        } catch (error) {
            return response(
                'EPG proxy error: ' + (error?.message || String(error)),
                502,
                'text/plain; charset=utf-8'
            );
        }
    }
};
      
