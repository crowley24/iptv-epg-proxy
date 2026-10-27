
// IPTV EPG Proxy 1.2.0
// Modes:
// GET  /epg.xml       -> full XMLTV, streamed
// POST /epg.xml       -> filtered XMLTV by channel IDs
// GET  /health        -> service status

const EPG_URL = 'http://only4.tv/epg/epg.xml';
const VERSION = '1.2.0';

// Максимальний розмір XMLTV для режиму фільтрації: 25 MiB.
// Звичайний потоковий режим GET цим обмеженням не обмежений.
const MAX_FILTER_BYTES = 25 * 1024 * 1024;

// Обмеження списку каналів у запиті.
const MAX_CHANNEL_IDS = 2000;

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
    };
}

function response(body, status, contentType, extraHeaders = {}) {
    return new Response(body, {
        status,
        headers: {
            ...corsHeaders(),
            'Content-Type': contentType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-EPG-Proxy': 'iptv-epg-proxy-v' + VERSION,
            ...extraHeaders
        }
    });
}

function xmlEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function decodeBasicXml(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function getAttribute(tag, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
        '\\b' + escaped + '\\s*=\\s*(["\\'])(.*?)\\1',
        'i'
    );
    const match = tag.match(re);

    return match ? decodeBasicXml(match[2]) : '';
}

function normalizeIds(ids) {
    if (!Array.isArray(ids)) {
        throw new Error('Поле ids має бути масивом рядків.');
    }

    if (ids.length > MAX_CHANNEL_IDS) {
        throw new Error(
            'Забагато каналів. Максимум: ' + MAX_CHANNEL_IDS
        );
    }

    const result = new Set();

    for (const value of ids) {
        if (typeof value !== 'string') continue;

        const id = value.trim();

        if (!id || id.length > 300) continue;

        // Не дозволяємо передавати керівні символи.
        if (/[\u0000-\u001F\u007F]/.test(id)) continue;

        result.add(id);
    }

    return result;
}

async function fetchSource() {
    const upstream = await fetch(EPG_URL, {
        method: 'GET',
        headers: {
            'Accept': 'application/xml, text/xml, */*',
            'User-Agent':
                'Mozilla/5.0 (compatible; IPTV-EPG-Proxy/' +
                VERSION + ')'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(60000)
    });

    if (!upstream.ok) {
        await upstream.body?.cancel();

        throw new Error(
            'EPG source returned HTTP ' + upstream.status
        );
    }

    const contentType =
        upstream.headers.get('content-type') || '';

    if (
        contentType.includes('text/html') ||
        contentType.includes('application/json')
    ) {
        await upstream.body?.cancel();

        throw new Error(
            'EPG source returned unexpected content type: ' +
            contentType
        );
    }

    if (!upstream.body) {
        throw new Error('EPG source returned an empty body.');
    }

    return upstream;
}

async function filterXmltv(ids) {
    if (!ids.size) {
        throw new Error(
            'Список ids порожній. Передай tvg-id каналів із плейлиста.'
        );
    }

    const upstream = await fetchSource();

    const declaredLength = Number(
        upstream.headers.get('content-length') || 0
    );

    if (
        declaredLength &&
        declaredLength > MAX_FILTER_BYTES
    ) {
        await upstream.body.cancel();

        throw new Error(
            'XMLTV завеликий для фільтрації (' +
            declaredLength +
            ' байт). Максимум — ' +
            MAX_FILTER_BYTES +
            ' байт. Повний потоковий режим GET /epg.xml доступний.'
        );
    }

    // Читаємо тіло з контролем фактичного розміру.
    const reader = upstream.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
        while (true) {
            const part = await reader.read();

            if (part.done) break;

            totalBytes += part.value.byteLength;

            if (totalBytes > MAX_FILTER_BYTES) {
                await reader.cancel();

                throw new Error(
                    'XMLTV перевищив ліміт фільтрації ' +
                    MAX_FILTER_BYTES + ' байт.'
                );
            }

            chunks.push(part.value);
        }
    } finally {
        try {
            reader.releaseLock();
        } catch (_) {}
    }

    const buffer = new Uint8Array(totalBytes);
    let offset = 0;

    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
    }

    const xml = new TextDecoder('utf-8').decode(buffer);

    if (!/<tv(?:\s|>)/i.test(xml)) {
        throw new Error(
            'Отриманий документ не схожий на XMLTV: тег <tv> не знайдено.'
        );
    }

    // Беремо початковий тег tv, включно з атрибутами.
    const tvMatch = xml.match(/<tv\b[^>]*>/i);
    const tvOpen = tvMatch ? tvMatch[0] : '<tv>';

    // Знаходимо канали, ID яких є у переданому списку.
    const channelBlocks =
        xml.match(/<channel\b[\s\S]*?<\/channel\s*>/gi) || [];

    const selectedChannels = [];
    const selectedIds = new Set();

    for (const block of channelBlocks) {
        const opening = block.match(/^<channel\b[^>]*>/i);

        if (!opening) continue;

        const id = getAttribute(opening[0], 'id');

        if (id && ids.has(id)) {
            selectedChannels.push(block);
            selectedIds.add(id);
        }
    }

    // Якщо жоден ID не збігся, не повертаємо фальшивий порожній EPG
    // як успішний результат: це допоможе виявити неправильні tvg-id.
    if (!selectedIds.size) {
        throw new Error(
            'У XMLTV не знайдено каналів із переданими tvg-id. ' +
            'Перевір ID у M3U та атрибути id у XMLTV.'
        );
    }

    // Вибираємо програми тільки для знайдених каналів.
    const programmeBlocks =
        xml.match(/<programme\b[\s\S]*?<\/programme\s*>/gi) || [];

    const selectedProgrammes = [];

    for (const block of programmeBlocks) {
        const opening = block.match(/^<programme\b[^>]*>/i);

        if (!opening) continue;

        const channelId = getAttribute(opening[0], 'channel');

        if (selectedIds.has(channelId)) {
            selectedProgrammes.push(block);
        }
    }

    // Формуємо XMLTV без сторонніх каналів і програм.
    // Вміст channel/programme зберігаємо без змін.
    const output = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        tvOpen,
        ...selectedChannels,
        ...selectedProgrammes,
        '</tv>'
    ].join('\n');

    return {
        xml: output,
        requestedChannels: ids.size,
        matchedChannels: selectedIds.size,
        programmeCount: selectedProgrammes.length,
        sourceBytes: totalBytes,
        resultBytes: new TextEncoder().encode(output).byteLength
    };
}

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: corsHeaders()
            });
        }

        if (pathname === '/health') {
            if (
                request.method !== 'GET' &&
                request.method !== 'HEAD'
            ) {
                return response(
                    'Method not allowed',
                    405,
                    'text/plain; charset=utf-8'
                );
            }

            const body = JSON.stringify({
                success: true,
                service: 'IPTV EPG Proxy',
                version: VERSION,
                source: EPG_URL,
                modes: {
                    full: 'GET /epg.xml',
                    filtered: 'POST /epg.xml with JSON body {"ids":["channel.id"]}'
                },
                filterMaxBytes: MAX_FILTER_BYTES,
                maxChannelIds: MAX_CHANNEL_IDS
            }, null, 2);

            return response(
                request.method === 'HEAD' ? null : body,
                200,
                'application/json; charset=utf-8'
            );
        }

        if (pathname !== '/' && pathname !== '/epg.xml') {
            return response(
                'Not found',
                404,
                'text/plain; charset=utf-8'
            );
        }

        if (
            request.method !== 'GET' &&
            request.method !== 'HEAD' &&
            request.method !== 'POST'
        ) {
            return response(
                'Method not allowed',
                405,
                'text/plain; charset=utf-8'
            );
        }

        // Режим фільтрації: POST /epg.xml
        if (request.method === 'POST') {
            let body;

            try {
                body = await request.json();
            } catch (_) {
                return response(
                    'Invalid JSON request body',
                    400,
                    'text/plain; charset=utf-8'
                );
            }

            let ids;

            try {
                ids = normalizeIds(body?.ids);
            } catch (error) {
                return response(
                    error?.message || String(error),
                    400,
                    'text/plain; charset=utf-8'
                );
            }

            try {
                const result = await filterXmltv(ids);

                return response(
                    result.xml,
                    200,
                    'application/xml; charset=utf-8',
                    {
                        'X-EPG-Mode': 'filtered',
                        'X-EPG-Requested-Channels':
                            String(result.requestedChannels),
                        'X-EPG-Matched-Channels':
                            String(result.matchedChannels),
                        'X-EPG-Programme-Count':
                            String(result.programmeCount),
                        'X-EPG-Source-Bytes':
                            String(result.sourceBytes),
                        'X-EPG-Result-Bytes':
                            String(result.resultBytes)
                    }
                );
            } catch (error) {
                return response(
                    'EPG filter error: ' +
                    (error?.message || String(error)),
                    502,
                    'text/plain; charset=utf-8'
                );
            }
        }

        // Старий режим GET /epg.xml: передаємо повний XMLTV потоком.
        try {
            const upstream = await fetchSource();

            const headers = {
                ...corsHeaders(),
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-EPG-Proxy': 'iptv-epg-proxy-v' + VERSION,
                'X-EPG-Mode': 'streaming'
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
