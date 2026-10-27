#!/usr/bin/env python3

import sys
import time
import json
import shutil
import sqlite3
import urllib.request
import xml.etree.ElementTree as ET

from pathlib import Path
from urllib.parse import quote


# ============================================================
# IPTV EPG BUILDER
# Джерело: only4.tv
# Вихід: окремий XML-файл на кожен канал
# ============================================================

SOURCE_URL = "http://only4.tv/epg/epg.xml"

DIST_DIR = Path("dist")
OUTPUT_DIR = DIST_DIR / "processed" / "channels"
WORK_DIR = Path("epg-work")

SOURCE_FILE = WORK_DIR / "source.xml"
DATABASE_FILE = WORK_DIR / "epg.sqlite3"

USER_AGENT = "IPTV-EPG-Builder/1.0"
DOWNLOAD_TIMEOUT = 180
BATCH_SIZE = 2000

XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'
XML_ROOT_OPEN = '<tv generator-info-name="IPTV EPG Proxy">\n'
XML_ROOT_CLOSE = '</tv>\n'


def log(message):
    print(f"[EPG] {message}", flush=True)


def prepare_directories():
    # Прибираємо результати попередньої збірки,
    # щоб старі XML-файли не потрапили в новий deployment.
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)

    if WORK_DIR.exists():
        shutil.rmtree(WORK_DIR)

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def download_source():
    log(f"Завантаження XMLTV: {SOURCE_URL}")

    request = urllib.request.Request(
        SOURCE_URL,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/xml,text/xml,*/*",
        },
    )

    total_bytes = 0
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
                    "Очікуваний розмір: "
                    f"{int(content_length):,} байт"
                )

            with open(SOURCE_FILE, "wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)

                    if not chunk:
                        break

                    output.write(chunk)
                    total_bytes += len(chunk)

                    if total_bytes // (25 * 1024 * 1024) != (
                        total_bytes - len(chunk)
                    ) // (25 * 1024 * 1024):
                        log(
                            f"Завантажено: "
                            f"{total_bytes / 1024 / 1024:.1f} MiB"
                        )

    except Exception as error:
        raise RuntimeError(
            f"Не вдалося завантажити XMLTV: {error}"
        ) from error

    elapsed = time.time() - started

    if total_bytes == 0:
        raise RuntimeError("Завантажений XMLTV-файл порожній.")

    log(
        f"Завантаження завершено: {total_bytes:,} байт "
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
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id TEXT NOT NULL,
            xml TEXT NOT NULL
        )
    """)

    db.commit()
    return db


def parse_xmltv(db):
    log("Потоковий розбір XMLTV")

    channels_count = 0
    programmes_count = 0
    skipped_count = 0

    channel_batch = []
    programme_batch = []

    def save_batches():
        nonlocal channel_batch, programme_batch

        if channel_batch:
            db.executemany(
                """
                INSERT OR REPLACE INTO channels (id, xml)
                VALUES (?, ?)
                """,
                channel_batch,
            )
            channel_batch = []

        if programme_batch:
            db.executemany(
                """
                INSERT INTO programmes (channel_id, xml)
                VALUES (?, ?)
                """,
                programme_batch,
            )
            programme_batch = []

        db.commit()

    try:
        context = ET.iterparse(
            str(SOURCE_FILE),
            events=("start", "end"),
        )

        first_event, root = next(context)

        if first_event != "start" or root.tag != "tv":
            raise RuntimeError(
                "Некоректний XMLTV: очікується кореневий тег <tv>."
            )

        depth = 1

        for event, element in context:
            if event == "start":
                depth += 1
                continue

            # depth == 2 означає прямого нащадка <tv>.
            if depth == 2:
                if element.tag == "channel":
                    channel_id = element.attrib.get("id", "").strip()

                    if channel_id:
                        channel_xml = ET.tostring(
                            element,
                            encoding="unicode",
                            short_empty_elements=True,
                        )

                        channel_batch.append(
                            (channel_id, channel_xml)
                        )
                        channels_count += 1
                    else:
                        skipped_count += 1

                elif element.tag == "programme":
                    channel_id = (
                        element.attrib.get("channel", "").strip()
                    )

                    if channel_id:
                        programme_xml = ET.tostring(
                            element,
                            encoding="unicode",
                            short_empty_elements=True,
                        )

                        programme_batch.append(
                            (channel_id, programme_xml)
                        )
                        programmes_count += 1
                    else:
                        skipped_count += 1

                # Очищаємо тільки поточний елемент.
                # Не викликаємо root.clear(), щоб не видалити
                # ще не оброблені сусідні елементи.
                element.clear()

                if (
                    len(channel_batch) + len(programme_batch)
                    >= BATCH_SIZE
                ):
                    save_batches()

                    log(
                        f"Оброблено: {channels_count:,} каналів, "
                        f"{programmes_count:,} програм"
                    )

            depth -= 1

        save_batches()

    except ET.ParseError as error:
        raise RuntimeError(
            f"Помилка синтаксису XMLTV: {error}"
        ) from error

    db.execute("""
        CREATE INDEX IF NOT EXISTS idx_programmes_channel
        ON programmes(channel_id)
    """)

    db.commit()

    log(f"Каналів: {channels_count:,}")
    log(f"Програм: {programmes_count:,}")
    log(f"Пропущених елементів: {skipped_count:,}")

    if channels_count == 0:
        raise RuntimeError("XMLTV не містить каналів.")

    if programmes_count == 0:
        raise RuntimeError("XMLTV не містить програм телепередач.")


def export_channel_files(db):
    log("Створення XML-файлів каналів")

    channels = db.execute(
        "SELECT id, xml FROM channels ORDER BY id"
    )

    exported = 0
    missing_programmes = 0

    for channel_id, channel_xml in channels:
        filename = quote(
            channel_id,
            safe="-_.!~*'()",
        ) + ".xml"

        output_path = OUTPUT_DIR / filename

        # Не дозволяємо ID створювати вкладені каталоги.
        if output_path.parent.resolve() != OUTPUT_DIR.resolve():
            raise RuntimeError(
                f"Некоректний ID каналу: {channel_id!r}"
            )

        has_programmes = False

        with open(
            output_path,
            "w",
            encoding="utf-8",
            newline="\n",
        ) as output:
            output.write(XML_DECLARATION)
            output.write(XML_ROOT_OPEN)
            output.write(channel_xml)
            output.write("\n")

            programmes = db.execute(
                """
                SELECT xml
                FROM programmes
                WHERE channel_id = ?
                ORDER BY id
                """,
                (channel_id,),
            )

            for (programme_xml,) in programmes:
                output.write(programme_xml)
                output.write("\n")
                has_programmes = True

            output.write(XML_ROOT_CLOSE)

        if not has_programmes:
            missing_programmes += 1

        exported += 1

        if exported % 250 == 0:
            log(f"Створено файлів: {exported:,}")

    log(f"Усього XML-файлів: {exported:,}")
    log(f"Каналів без програм: {missing_programmes:,}")

    if exported == 0:
        raise RuntimeError("Не створено жодного XML-файлу.")


def write_manifest():
    files = list(OUTPUT_DIR.glob("*.xml"))

    manifest_path = DIST_DIR / "processed" / "manifest.json"

    manifest_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    manifest = {
        "success": True,
        "source": SOURCE_URL,
        "channelFiles": len(files),
        "format": "per-channel-xml",
    }

    with open(
        manifest_path,
        "w",
        encoding="utf-8",
    ) as output:
        json.dump(
            manifest,
            output,
            ensure_ascii=False,
            indent=2,
        )
        output.write("\n")

    log(f"Маніфест створено: {manifest_path}")


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

    log("ЗБІРКА УСПІШНА")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"ПОМИЛКА: {error}")
        sys.exit(1)
