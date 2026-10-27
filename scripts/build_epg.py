#!/usr/bin/env python3

import os
import sys
import time
import sqlite3
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

from pathlib import Path
from urllib.parse import quote


SOURCE_URL = "http://only4.tv/epg/epg.xml"

OUTPUT_DIR = Path("dist/processed/channels")
WORK_DIR = Path("epg-work")
SOURCE_FILE = WORK_DIR / "source.xml"
DATABASE_FILE = WORK_DIR / "epg.sqlite3"

USER_AGENT = "IPTV-EPG-Builder/1.0"

BATCH_SIZE = 2000
DOWNLOAD_TIMEOUT = 120

XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'


def log(message):
    print(f"[EPG] {message}", flush=True)


def prepare_directories():
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def download_source():
    log(f"Завантаження джерела: {SOURCE_URL}")

    request = urllib.request.Request(
        SOURCE_URL,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/xml,text/xml,*/*",
        },
    )

    total = 0
    started = time.time()

    try:
        with urllib.request.urlopen(
            request,
            timeout=DOWNLOAD_TIMEOUT,
        ) as response:
            status = getattr(response, "status", 200)

            if status != 200:
                raise RuntimeError(
                    f"Джерело повернуло HTTP {status}"
                )

            content_length = response.headers.get("Content-Length")

            if content_length:
                log(
                    "Розмір джерела: "
                    f"{int(content_length):,} байт"
                )

            with open(SOURCE_FILE, "wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)

                    if not chunk:
                        break

                    output.write(chunk)
                    total += len(chunk)

                    if total % (25 * 1024 * 1024) < len(chunk):
                        log(
                            f"Завантажено {total / 1024 / 1024:.1f} MiB"
                        )

    except Exception as error:
        raise RuntimeError(
            f"Не вдалося завантажити XMLTV: {error}"
        ) from error

    elapsed = time.time() - started

    if total == 0:
        raise RuntimeError("Джерело повернуло порожній файл.")

    log(
        f"Завантаження завершено: {total:,} байт "
        f"за {elapsed:.1f} с"
    )


def create_database():
    if DATABASE_FILE.exists():
        DATABASE_FILE.unlink()

    db = sqlite3.connect(DATABASE_FILE)

    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA temp_store=FILE")

    db.execute("""
        CREATE TABLE channels (
            id TEXT PRIMARY KEY,
            xml TEXT NOT NULL
        )
    """)

    db.execute("""
        CREATE TABLE programmes (
            channel_id TEXT NOT NULL,
            xml TEXT NOT NULL
        )
    """)

    db.commit()
    return db


def parse_xmltv(db):
    log("Розбір XMLTV потоковим парсером")

    channels_count = 0
    programmes_count = 0
    skipped_programmes = 0

    programme_batch = []
    channel_batch = []

    def save_batches():
        if channel_batch:
            db.executemany(
                """
                INSERT OR REPLACE INTO channels (id, xml)
                VALUES (?, ?)
                """,
                channel_batch,
            )
            channel_batch.clear()

        if programme_batch:
            db.executemany(
                """
                INSERT INTO programmes (channel_id, xml)
                VALUES (?, ?)
                """,
                programme_batch,
            )
            programme_batch.clear()

        db.commit()

    try:
        context = ET.iterparse(
            str(SOURCE_FILE),
            events=("start", "end"),
        )

        first_event, root = next(context)

        if first_event != "start" or root.tag != "tv":
            raise RuntimeError(
                "Файл не має кореневого елемента <tv>."
            )

        stack = [root]

        for event, element in context:
            if event == "start":
                stack.append(element)
                continue

            # Обробляємо лише прямі дочірні елементи <tv>.
            if len(stack) == 2:
                if element.tag == "channel":
                    channel_id = element.attrib.get("id", "").strip()

                    if channel_id:
                        xml = ET.tostring(
                            element,
                            encoding="unicode",
                            short_empty_elements=True,
                        )

                        channel_batch.append((channel_id, xml))
                        channels_count += 1

                elif element.tag == "programme":
                    channel_id = (
                        element.attrib.get("channel", "").strip()
                    )

                    if channel_id:
                        xml = ET.tostring(
                            element,
                            encoding="unicode",
                            short_empty_elements=True,
                        )

                        programme_batch.append((channel_id, xml))
                        programmes_count += 1
                    else:
                        skipped_programmes += 1

                # Видаляємо вже оброблений великий XML-вузол.
                root.clear()

                if (
                    len(channel_batch) + len(programme_batch)
                    >= BATCH_SIZE
                ):
                    save_batches()

                    if (
                        channels_count + programmes_count
                    ) % 20000 < BATCH_SIZE:
                        log(
                            f"Каналів: {channels_count:,}; "
                            f"програм: {programmes_count:,}"
                        )

            stack.pop()

        save_batches()

    except ET.ParseError as error:
        raise RuntimeError(
            f"Помилка XML на етапі розбору: {error}"
        ) from error

    db.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_programmes_channel
        ON programmes(channel_id)
        """
    )
    db.commit()

    log(f"Каналів: {channels_count:,}")
    log(f"Програм: {programmes_count:,}")
    log(f"Пропущено програм без channel ID: {skipped_programmes:,}")

    if channels_count == 0:
        raise RuntimeError(
            "Не знайдено жодного XMLTV-каналу."
        )

    if programmes_count == 0:
        raise RuntimeError(
            "Не знайдено жодної XMLTV-програми."
        )


def export_channel_files(db):
    log("Створення окремих XML-файлів каналів")

    cursor = db.execute(
        "SELECT id, xml FROM channels ORDER BY id"
    )

    exported = 0
    missing_programmes = 0

    for channel_id, channel_xml in cursor:
        filename = quote(
            channel_id,
            safe="-_.!~*'()",
        ) + ".xml"

        output_path = OUTPUT_DIR / filename

        # Не дозволяємо ID впливати на структуру директорій.
        if output_path.parent.resolve() != OUTPUT_DIR.resolve():
            raise RuntimeError(
                f"Некоректний шлях для ID: {channel_id!r}"
            )

        with open(
            output_path,
            "w",
            encoding="utf-8",
            newline="\n",
        ) as output:
            output.write(XML_DECLARATION)
            output.write(channel_xml)
            output.write("\n")

            programmes = db.execute(
                """
                SELECT xml
                FROM programmes
                WHERE channel_id = ?
                """,
                (channel_id,),
            )

            has_programmes = False

            for (programme_xml,) in programmes:
                output.write(programme_xml)
                output.write("\n")
                has_programmes = True

        if not has_programmes:
            missing_programmes += 1

        exported += 1

        if exported % 250 == 0:
            log(f"Створено файлів: {exported:,}")

    log(f"Усього створено файлів: {exported:,}")
    log(
        "Каналів без програм: "
        f"{missing_programmes:,}"
    )

    if exported == 0:
        raise RuntimeError("Не створено жодного XML-файлу.")


def write_manifest():
    files = sorted(OUTPUT_DIR.glob("*.xml"))

    manifest = Path("dist/processed/manifest.json")
    manifest.parent.mkdir(parents=True, exist_ok=True)

    import json

    with open(manifest, "w", encoding="utf-8") as output:
        json.dump(
            {
                "success": True,
                "source": SOURCE_URL,
                "channelFiles": len(files),
                "format": "per-channel-xml",
            },
            output,
            ensure_ascii=False,
            indent=2,
        )

    log(f"Маніфест: {manifest}")


def main():
    prepare_directories()
    download_source()

    db = create_database()

    try:
        parse_xmltv(db)
        export_channel_files(db)
        write_manifest()
    finally:
        db.close()

    log("Готово. Файли збережено в dist/processed/channels/")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ПОМИЛКА: {error}", file=sys.stderr)
        sys.exit(1)
