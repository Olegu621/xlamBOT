# Совместная работа / Contributing

Основной репозиторий: **[Olegu621/xlamBOT](https://github.com/Olegu621/xlamBOT)**.
Форк для изменений bsdedus: **[bsdedus/xlamBOT](https://github.com/bsdedus/xlamBOT)**.

Каждый работает под своим аккаунтом GitHub и в своём чате GPT/Codex. Изменения объединяются через Pull Request (PR): `bsdedus:codex/название` → `Olegu621:main`. Владелец основного репозитория проверяет изменения и нажимает **Merge pull request**.

## Первый запуск и новая задача

```bash
git clone https://github.com/bsdedus/xlamBOT.git
cd xlamBOT
git remote add upstream https://github.com/Olegu621/xlamBOT.git
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch -c codex/describe-your-change
```

Для следующей задачи повторите команды начиная с `git fetch upstream`, используя новое имя ветки. Если `--ff-only` не проходит, сначала разберите расхождение веток; не заменяйте историю принудительным push.

Пример задания своему GPT/Codex:

> Работай в моём форке bsdedus/xlamBOT. Возьми актуальный Olegu621/xlamBOT/main, создай отдельную ветку codex/название, внеси исправление, выполни проверки и открой PR в Olegu621/xlamBOT/main. Опиши проверку и её ограничения. Не публикуй ключи, токены и данные аккаунтов.

После изменений:

```bash
python -m pip install -r requirements-ci.txt
python -m unittest discover -s tests -v
python tools/validate_distribution.py
git add <изменённые-файлы>
git commit -m "Describe the resulting behavior"
git push -u origin codex/describe-your-change
```

Нужны Python 3.13+ и Node.js 22+. Откройте вкладку **Pull requests → New pull request** на GitHub, выберите **base: Olegu621/xlamBOT / main**, **head: bsdedus/xlamBOT / ваша ветка**. После объединения обновите свой `main` из `upstream` теми же командами. У GPT должна быть подключена учётная запись своего владельца с доступом к соответствующему репозиторию.

## Что проверяет CI

| Проверка | Что обнаруживает |
| --- | --- |
| Подпись Ed25519 | Изменённый манифест или пакет от другого издателя |
| Размер и SHA-256 архива/каждого файла | Повреждённый или несогласованный пакет |
| Состав ZIP и безопасные пути | Лишние файлы, дубликаты, выход за каталог, симлинки |
| Заголовки `.pyc` | Неподходящую версию Python или обрезанный заголовок |
| `node --check` | Синтаксические ошибки JS в `static/` и внутри `scripts.zip` |
| Регрессионные тесты валидатора | Ошибочное принятие испорченных пакетов |

Проверки запускаются при push и открытии/обновлении PR. Workflow получает только чтение репозитория, использует закреплённые версии Actions, не использует секреты и не запускает байткод из пакета. Публичный ключ в валидаторе сверяет действующую подпись ревизии 23; это открытый ключ проверки, его можно публиковать.

Файлы `static/` распространяются отдельным каналом ресурсов и могут опережать `scripts.zip`. CI проверяет синтаксис обоих каналов независимо и не требует совпадения их содержимого. Части большого `runtime/` не загружаются в CI; их целостность проверяет установщик. CI не проверяет работу EXE, эмулятора и игровой логики.

## Изменения поведения и подписанные релизы

Этот репозиторий содержит **публичную сборку**: Python-модули опубликованы в `.pyc`, исходные `.py` отсутствуют. Чтобы оба разработчика могли менять Python-код, владелец исходников должен дать второму разработчику доступ к репозиторию исходников, например закрытому, через **Settings → Collaborators**. Там же нужно запускать тесты ADB, навигации, газа, распознавания и профилей устройств. Distribution CI дополняет эти тесты проверкой результата сборки.

Изменение `scripts.zip` требует пересборки для Python 3.13, увеличения `manifest.revision`, обновления размеров/хешей и новой подписи **действующим ключом издателя**. Закрытый ключ остаётся у издателя и не попадает в Git, PR или чат. Ключ для подписи не меняется ради форка. `manifest.repository` остаётся `Olegu621/xlamBOT`, пока издатель не подготовит отдельный загрузчик и канал обновлений.

Для изменений игрового поведения опишите проверку на эмуляторе и результат. Прохождение проверок сборки не доказывает, что бот правильно играет. После появления CI в основном репозитории владелец может включить правило защиты `main`: PR, проверка `Validate signed update and web resources` и одобрение второго разработчика перед объединением.

## English

The canonical repository is **Olegu621/xlamBOT**. Work in **bsdedus/xlamBOT**, synchronize `main` from `upstream/main`, create a separate `codex/...` branch, run the commands above, and open a PR targeting `Olegu621:main`. Each developer uses their own GitHub account and assistant session. The maintainer reviews and merges the PR, then both developers synchronize again.

Distribution CI verifies the existing Ed25519 signature, archive/file hashes, safe ZIP inventory, Python 3.13 bytecode headers, and JavaScript syntax in both resource channels. It tests the validator against malformed updates. It does not execute the packaged bytecode, download the large runtime, or test gameplay. Standalone resources may be newer than the signed script bundle.

Python sources are absent from this public distribution. Share a source repository with the other developer and run behavior tests there. Changes to `scripts.zip` require rebuilding, incrementing the revision, updating hashes and signing with the publisher's existing private key. Never commit private keys or account data; keep the canonical update repository unchanged unless a new bootstrap is intentionally released. Protect `main` with PR review and the distribution check after this workflow is merged.


## Репозиторий исходников и соответствие ревизий

Python-исходники находятся в закрытом [Olegu621/xlamBOT-source](https://github.com/Olegu621/xlamBOT-source). Для работы нужен доступ к этому репозиторию. Тег `bot-revision-24` соответствует текущему подписанному обновлению: проверено совпадение всех 71 файлов после компиляции. Там находятся точки запуска EXE, управление устройствами, веб-панель, шаблоны настроек и инструменты публикации.

Каждое следующее обновление собирается через `tools/publish.py` в репозитории исходников. Публикация требует успешного сохранения кода на GitHub и отправки тега `bot-revision-N`; повторно использовать номер ревизии нельзя. `source-provenance.json` в каталоге результата связывает SHA-256 пакета с source commit. Изменения объединяйте через PR, затем собирайте подписанное обновление и открывайте PR с артефактами сюда. Releases содержат только установщик. Закрытый ключ подписи, профили устройств и записи обучения не коммитятся.
