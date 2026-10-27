/*
 * IPTV EPG PROXY 2.0.2
 *
 * Source:
 *   GitHub Pages / processed/channels/{id}.xml
 *
 * POST /epg.xml
 * Body: {"ids":["channel-id-1","channel-id-2"]}
 *
 * GET /health
 *
 * Не завантажує повний XMLTV розміром ~338 MiB.
 */

const VERSION = '2.0.2';

const DATA_BASE =
    'https://crowley24.github.io/iptv-epg-proxy/processed/channels/';

const MAX_CHANNEL_IDS = 40;
const MAX_ID_LENGTH = 250;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-EPG-Found, X-EPG-Missing',
    'Cache-Control': 'no-store'
};

function response(body, status, contentType) {
    const headers = new Headers(CORS_HEADERS);
    headers.set(
        'Content-Type',
        contentType || 'application/json; charset=utf-8'
    );

    return new Response(body, {
        status: status || 200,
        headers
    });
}

function json(data, status) {
    return response(
        JSON.stringify(data, null, 2),
        status || 200
    );
}

function xmlResponse(body, status, found, missing) {
    const headers = new Headers(CORS_HEADERS);

    headers.set(
        'Content-Type',
        'application/xml; charset=utf-8'
    );

    headers.set('X-EPG-Found', String(found || 0));
    headers.set('X-EPG-Missing', String(missing || 0));

    return new Response(body, {
        status: status || 200,
        headers
    });
}

function escapeXmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function validId(value) {
    return typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_ID_LENGTH &&
        !/[\u0000-\u001F\u007F]/.test(value);
}

/*
 * Витягує вміст XMLTV-файлу каналу.
 *
 * Підтримує:
 *   <tv><channel>...</channel><programme>...</programme></tv>
 *
 * Також підтримує фрагмент без <tv>, якщо в ньому
 * присутні коректні XMLTV-елементи.
 */
function extractTvContents(source, id) {
    let xml = String(source || '')
        .replace(/^\uFEFF/, '')
        .trim();

    if (!xml) {
        throw new Error('Порожній файл каналу: ' + id);
    }

    // Прибираємо XML declaration.
    xml = xml.replace(/^<\?xml\b[^?]*\?>\s*/i, '');

    // Прибираємо коментарі на початку.
    xml = xml.replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/i, '');

    // Якщо файл має кореневий <tv>, знімаємо тільки зовнішню оболонку.
    const opening = xml.match(/^<tv(?:\s[^>]*)?>/i);

    if (opening) {
        xml = xml.slice(opening[0].length);

        const closing = xml.match(/<\/tv\s*>\s*$/i);

        if (!closing) {
            throw new Error('Незакритий кореневий тег tv: ' + id);
        }

        xml = xml.slice(0, closing.index).trim();
    } else if (/<\/?tv(?:\s|>)/i.test(xml)) {
        throw new Error('Некоректний кореневий тег tv: ' + id);
    }

    // Не дозволяємо вкладені кореневі документи.
    if (/<\/?tv(?:\s|>)/i.test(xml)) {
        throw new Error('Зайвий тег tv усередині файлу: ' + id);
    }

    if (!/<channel(?:\s|>)/i.test(xml) ||
        !/<\/channel\s*>/i.test(xml)) {
        throw new Error('Не знайдено елемент channel: ' + id);
    }

    // Кожен відкритий channel має бути закритий.
    const channelOpens = (xml.match(/<channel(?:\s|>)/gi) || []).length;
    const channelCloses = (xml.match(/<\/channel\s*>/gi) || []).length;

    if (channelOpens !== channelCloses) {
        throw new Error('Некоректна кількість тегів channel: ' + id);
    }

    // Забезпечуємо наявність хоча б одного XMLTV-елемента.
    if (!/<(?:channel|programme)(?:\s|>)/i.test(xml)) {
        throw new Error('Файл не містить XMLTV-даних: ' + id);
    }

    return xml;
}

async function fetchChannel(id) {
    const url = DATA_BASE + encodeURIComponent(id) + '.xml';

    let result;

    try {
        result = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.5'
            },
            cf: {
                cacheEverything: true,
                cacheTtl: 300
            }
        });
    } catch (error) {
        return {
            id,
            ok: false,
            error: 'Помилка мережі: ' + String(error.message || error)
        };
    }

    if (!result.ok) {
        return {
            id,
            ok: false,
            error: 'HTTP ' + result.status
        };
    }

    let source;

    try {
        source = await result.text();
    } catch (error) {
        return {
            id,
            ok: false,
            error: 'Не вдалося прочитати файл'
        };
    }

    try {
        const contents = extractTvContents(source, id);

        return {
            id,
            ok: true,
            contents
        };
    } catch (error) {
        return {
            id,
            ok: false,
            error: String(error.message || error)
        };
    }
}

async function handlePost(request) {
    let payload;

    try {
        payload = await request.json();
    } catch (_) {
        return json({
            success: false,
            version: VERSION,
            error: 'Тіло запиту має бути коректним JSON.'
        }, 400);
    }

    if (!payload || !Array.isArray(payload.ids)) {
        return json({
            success: false,
            version: VERSION,
            error: 'Очікується JSON з масивом ids.'
        }, 400);
    }

    if (payload.ids.length === 0) {
        return json({
            success: false,
            version: VERSION,
            error: 'Масив ids порожній.'
        }, 400);
    }

    if (payload.ids.length > MAX_CHANNEL_IDS) {
        return json({
            success: false,
            version: VERSION,
            error: 'Забагато каналів в одному запиті.',
            maxChannelIds: MAX_CHANNEL_IDS,
            received: payload.ids.length
        }, 413);
    }

    for (const id of payload.ids) {
        if (!validId(id)) {
            return json({
                success: false,
                version: VERSION,
                error: 'Некоректний ідентифікатор каналу.'
            }, 400);
        }
    }

    // Видаляємо дублікати, зберігаючи порядок.
    const ids = [...new Set(payload.ids)];

    /*
     * Максимум 40 підзапитів до GitHub Pages за один виклик.
     * Це відповідає ліміту одного пакета плагіна.
     */
    const results = await Promise.all(
        ids.map(id => fetchChannel(id))
    );

    const found = results.filter(item => item.ok);
    const missing = results.filter(item => !item.ok);

    if (!found.length) {
        return json({
            success: false,
            version: VERSION,
            error: 'Не вдалося отримати підготовлені EPG-файли.',
            requested: ids.length,
            found: 0,
            missing: missing.length,
            details: missing.slice(0, 5).map(item => ({
                id: item.id,
                error: item.error
            }))
        }, 502);
    }

    const body = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<tv generator-info-name="IPTV EPG Proxy ' + VERSION + '">',
        ...found.map(item => item.contents),
        '</tv>'
    ].join('\n');

    return xmlResponse(
        body,
        200,
        found.length,
        missing.length
    );
}

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: CORS_HEADERS
            });
        }

        if (path === '/health' && request.method === 'GET') {
            return json({
                success: true,
                service: 'IPTV EPG Proxy',
                version: VERSION,
                mode: 'preprocessed-channel-files',
                maxChannelIds: MAX_CHANNEL_IDS,
                dataBase: DATA_BASE,
                fullXmltvFallback: false
            });
        }

        if (path === '/epg.xml' && request.method === 'POST') {
            return handlePost(request);
        }

        if (path === '/epg.xml' && request.method === 'GET') {
            return json({
                success: false,
                version: VERSION,
                error: 'GET вимкнено. Надсилай POST із масивом ids.'
            }, 405);
        }

        return json({
            success: false,
            version: VERSION,
            error: 'Not found'
        }, 404);
    }
};
