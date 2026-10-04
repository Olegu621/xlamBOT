"""Собирает очередь бойцов по умолчанию для поставки.

Зачем это нужно. Файл latest_brawler_data.json не попадает в репозиторий
(.gitignore), и в репозитории он весит два байта - пустой список. Установленная
программа брала его с собой и показывала на старте ноль бойцов: играть было
нечем, пока бот не наткнулся бы на кого-то сам.

Источник имён - cfg/brawlers_info.json, а не папки с иконками. Иконки названы
как попало: рядом лежат и 8bit.png, и 8-bit.png, плюс el primo, r-t, mr p.
Такое имя игра никогда не вернёт, а бот ищет бойца обычным обращением к
словарю, поэтому лишнее имя в очереди роняет плейстайл с KeyError. Канонические
имена берём из таблицы, к которой в итоге и идут все обращения.

    python -B tools_make_default_queue.py [куда положить.json]
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def canonical_names() -> list[str]:
    """Канонические имена бойцов из таблицы, на которую опирается play.py.

    Читаем файл напрямую, а не через load_brawlers_info(): тот возвращает
    ещё и псевдонимы (jess рядом с jessie), которых в самой таблице нет. В
    очередь должны попадать ровно те имена, что лежат в поставляемой таблице,
    иначе сверка сборки справедливо ругается.
    """
    import json

    table = ROOT / "cfg" / "brawlers_info.json"
    data = json.loads(table.read_text(encoding="utf-8"))
    names = [str(key) for key in data.keys()]
    if not names:
        raise RuntimeError("brawlers_info.json пуст или не читается")
    return sorted(names)


def build() -> list[dict]:
    # Порядок не важен: бот всё равно сортирует бойцов по своим правилам, а
    # очередь по трофеям он пересобирает сам. Значения - нули, чтобы панель
    # не показывала чужие цифры.
    return [
        {
            "brawler": name,
            "type": "trophies",
            "trophies": 0,
            "wins": 0,
            "push_until": 1000,
            "automatically_pick": True,
            "win_streak": 0,
        }
        for name in canonical_names()
    ]


def main() -> int:
    try:
        queue = build()
    except Exception as error:  # noqa: BLE001
        print(f"Не удалось собрать очередь: {error}")
        return 1

    # Проверяем сами себя: имя, которого нет в поставляемой таблице, уронит
    # плейстайл. Сверяемся с тем же файлом, который попадёт в сборку.
    import json

    table = json.loads(
        (ROOT / "cfg" / "brawlers_info.json").read_text(encoding="utf-8"))
    known = set(table.keys())
    unknown = [e["brawler"] for e in queue if e["brawler"] not in known]
    if unknown:
        print(f"В очереди есть чужие имена: {unknown}")
        return 1

    target = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "latest_brawler_data.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(queue, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Записано {len(queue)} бойцов в {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())