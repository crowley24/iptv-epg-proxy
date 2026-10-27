 // Auto-deploy test
const EPG_URL = 'http://only4.tv/epg/epg.xml';

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
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return response(
                'Method not allowed',
                405,
                'text/plain; charset=utf-8'
            );
        }

        if (url.pathname === '/health') {
            return response(JSON.stringify({
                success: true,
                service: 'IPTV EPG Proxy',
                version: '1.1.0',
                source: EPG_URL,
                mode: 'streaming',
                endpoint: '/epg.xml'
            }, null, 2), 200, 'application/json; charset=utf-8');
        }

        if (url.pathname !== '/' && url.pathname !== '/epg.xml') {
            return response(
                'Not found',
                404,
                'text/plain; charset=utf-8'
            );
        }

        try {
            const upstream = await fetch(EPG_URL, {
                method: 'GET',
                headers: {
                    'Accept': 'application/xml, text/xml, */*',
                    'User-Agent': 'Mozilla/5.0 (compatible; IPTV-EPG-Proxy/1.1)'
                },
                redirect: 'follow',
                signal: AbortSignal.timeout(60000)
            });

            if (!upstream.ok) {
                return response(
                    'EPG source returned HTTP ' + upstream.status,
                    502,
                    'text/plain; charset=utf-8'
                );
            }

            const contentType =
                upstream.headers.get('content-type') || '';

            if (
                contentType.includes('text/html') ||
                contentType.includes('application/json')
            ) {
                await upstream.body?.cancel();

                return response(
                    'EPG source returned unexpected content type: ' +
                    contentType,
                    502,
                    'text/plain; charset=utf-8'
                );
            }

            if (!upstream.body) {
                return response(
                    'EPG source returned an empty response body',
                    502,
                    'text/plain; charset=utf-8'
                );
            }

            const headers = {
                ...corsHeaders(),
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-EPG-Proxy': 'iptv-epg-proxy-v1.1'
            };

            if (upstream.headers.has('content-length')) {
                headers['Content-Length'] =
                    upstream.headers.get('content-length');
            }

            if (request.method === 'HEAD') {
                await upstream.body.cancel();

                return new Response(null, {
                    status: 200,
                    headers
                });
            }

            // Передаємо потік напряму, не читаючи весь XML у пам'ять.
            return new Response(upstream.body, {
                status: 200,
                headers
            });

        } catch (error) {
            return response(
                'EPG proxy error: ' +
                (error?.message || String(error)),
                502,
                'text/plain; charset=utf-8'
            );
        }
    }
};
