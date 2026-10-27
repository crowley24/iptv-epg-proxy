
/*
 * IPTV EPG Proxy 2.0.1
 * Cloudflare Workers Free
 *
 * POST /epg.xml
 * Body: {"ids":["channel.id"]}
 *
 * Source:
 * GitHub Pages preprocessed XMLTV files
 *
 * Supported channel file format:
 * <?xml version="1.0" encoding="UTF-8"?>
 * <tv>
 *   <channel>...</channel>
 *   <programme>...</programme>
 * </tv>
 *
 * Also supports legacy XML fragments without <tv>.
 */

const VERSION = "2.0.1";
const MAX_CHANNEL_IDS = 40;
const REQUEST_TIMEOUT_MS = 10000;

const DATA_BASE =
    "https://crowley24.github.io/iptv-epg-proxy/processed/channels/";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
};

function response(
    body,
    status = 200,
    contentType = "text/plain; charset=utf-8"
) {
    return new Response(body, {
        status,
        headers: {
            ...CORS_HEADERS,
            "Content-Type": contentType
        }
    });
}

function json(data, status = 200) {
    return response(
        JSON.stringify(data),
        status,
        "application/json; charset=utf-8"
    );
}

function validId(id) {
    return (
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 200 &&
        !/[\u0000-\u001f\u007f]/.test(id)
    );
}

function safeFilename(id) {
    return encodeURIComponent(id);
}

/*
 * Normalizes channel XML.
 *
 * Removes:
 * - UTF-8 BOM
 * - XML declaration
 * - DOCTYPE declaration
 * - outer <tv> wrapper
 *
 * Keeps:
 * - <channel>
 * - <programme>
 *
 * Supports both complete XMLTV documents
 * and legacy channel fragments.
 */
function normalizeChannelXml(xml, id) {
    if (typeof xml !== "string" || !xml.trim()) {
        throw new Error(
            "Порожній XML-файл каналу: " + id
        );
    }

    let content = xml.replace(/^\uFEFF/, "").trim();

    // Remove XML declaration.
    content = content.replace(
        /^<\?xml\s+[\s\S]*?\?>\s*/i,
        ""
    );

    // Remove optional DOCTYPE declaration.
    content = content.replace(
        /^<!DOCTYPE\s+tv(?:\s+[^>]*?)?>\s*/i,
        ""
    );

    // Remove optional XML comments before the root.
    content = content.replace(
        /^(?:\s*<!--[\s\S]*?-->\s*)+/,
        ""
    );

    /*
     * Detect a complete XMLTV document.
     * The wrapper must enclose the entire file.
     */
    if (/^<tv(?:\s[^>]*)?>/i.test(content)) {
        const openingTag = content.match(
            /^<tv(?:\s[^>]*)?>/i
        );

        if (!/<\/tv>\s*$/i.test(content)) {
            throw new Error(
                "Не знайдено закривальний тег </tv>: " + id
            );
        }

        content = content
            .slice(openingTag[0].length)
            .replace(/<\/tv>\s*$/i, "")
            .trim();
    }

    // Nested or unexpected <tv> tags are not allowed.
    if (/<\/?tv(?:\s|>)/i.test(content)) {
        throw new Error(
            "Некоректна структура XMLTV: " + id
        );
    }

    // XML declarations must not appear inside the result.
    if (/<\?xml(?:\s|\?>)/i.test(content)) {
        throw new Error(
            "Зайва XML-декларація: " + id
        );
    }

    if (
        !/<channel(?:\s|>)/i.test(content) ||
        !/<\/channel>/i.test(content)
    ) {
        throw new Error(
            "Не знайдено опис каналу: " + id
        );
    }

    return content;
}

async function fetchChannel(id) {
    const url = DATA_BASE + safeFilename(id) + ".xml";

    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
    );

    try {
        const result = await fetch(url, {
            method: "GET",
            headers: {
                "Accept": "application/xml,text/xml;q=0.9"
            },
            signal: controller.signal,
            cf: {
                cacheTtl: 300,
                cacheEverything: true
            }
        });

        if (result.status === 404) {
            return {
                id,
                found: false,
                xml: ""
            };
        }

        if (!result.ok) {
            throw new Error(
                "HTTP " + result.status +
                " для каналу " + id
            );
        }

        const rawXml = await result.text();

        const normalizedXml = normalizeChannelXml(
            rawXml,
            id
        );

        return {
            id,
            found: true,
            xml: normalizedXml
        };

    } finally {
        clearTimeout(timeout);
    }
}

async function handlePost(request) {
    let body;

    try {
        body = await request.json();
    } catch {
        return json({
            success: false,
            version: VERSION,
            error: "Тіло запиту має бути JSON."
        }, 400);
    }

    if (!body || !Array.isArray(body.ids)) {
        return json({
            success: false,
            version: VERSION,
            error:
                'Очікується JSON формату {"ids":["channel.id"]}.'
        }, 400);
    }

    const ids = [...new Set(body.ids)];

    if (ids.length === 0) {
        return json({
            success: false,
            version: VERSION,
            error: "Список channel IDs порожній."
        }, 400);
    }

    if (ids.some(id => !validId(id))) {
        return json({
            success: false,
            version: VERSION,
            error: "Список містить некоректний channel ID."
        }, 400);
    }

    if (ids.length > MAX_CHANNEL_IDS) {
        return json({
            success: false,
            version: VERSION,
            error: "Забагато каналів в одному запиті.",
            maxChannelIds: MAX_CHANNEL_IDS,
            received: ids.length,
            hint: "Розбий ids на пакети по 40 каналів."
        }, 413);
    }

    let results;

    try {
        results = await Promise.all(
            ids.map(fetchChannel)
        );
    } catch (error) {
        return json({
            success: false,
            version: VERSION,
            error:
                "Не вдалося отримати підготовлені EPG-файли.",
            details: String(error.message || error)
        }, 502);
    }

    const found = results.filter(
        item => item.found
    );

    const missing = results
        .filter(item => !item.found)
        .map(item => item.id);

    if (found.length === 0) {
        return json({
            success: false,
            version: VERSION,
            error:
                "Не знайдено EPG-файлів для запитаних каналів.",
            requested: ids.length,
            missing
        }, 404);
    }

    const xmlParts = found
        .map(item => item.xml)
        .join("\n");

    const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<tv generator-info-name="IPTV EPG Proxy ' +
        VERSION +
        '">\n' +
        xmlParts +
        "\n</tv>\n";

    return response(
        xml,
        200,
        "application/xml; charset=utf-8"
    );
}

async function handleRequest(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: CORS_HEADERS
        });
    }

    if (url.pathname === "/health") {
        return json({
            success: true,
            service: "IPTV EPG Proxy",
            version: VERSION,
            mode: "preprocessed-channel-files",
            source: DATA_BASE,
            maxChannelIds: MAX_CHANNEL_IDS,
            channelFileFormat: "complete-xmltv",
            supportsLegacyFragments: true,
            fullXmltvFallback: false
        });
    }

    if (url.pathname !== "/epg.xml") {
        return json({
            success: false,
            version: VERSION,
            error: "Endpoint не знайдено."
        }, 404);
    }

    if (request.method === "POST") {
        return handlePost(request);
    }

    if (request.method === "GET") {
        return json({
            success: false,
            version: VERSION,
            error: "Повний XMLTV через GET вимкнено.",
            hint:
                "Надсилайте POST із масивом ids."
        }, 405);
    }

    return json({
        success: false,
        version: VERSION,
        error: "Метод не підтримується."
    }, 405);
}

export default {
    async fetch(request) {
        try {
            return await handleRequest(request);
        } catch (error) {
            return json({
                success: false,
                version: VERSION,
                error: "Внутрішня помилка Worker.",
                details: String(
                    error.message || error
                )
            }, 500);
        }
    }
};
