"""Runs the xlamBOT control panel.

    python panel.py --port 5195

The panel is the multi-device front end: one bot per ADB device, each with its
own settings and brawler queue. It is the only supported way to run the bot on
more than one device, because the single-device entry point in main.py assumes
one global configuration directory.
"""
from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser

from utils import resolve_project_path


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description="xlamBOT multi-device control panel.")
    parser.add_argument("--port", type=int, default=5195, help="port to serve on")
    parser.add_argument("--host", default="127.0.0.1",
                        help="address to bind; 0.0.0.0 exposes the panel to the network")
    parser.add_argument("--no-browser", action="store_true",
                        help="do not open a browser window on start")
    parser.add_argument("--debug", action="store_true", help="run Flask in debug mode")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = _parse_args(argv)

    # Imported here so that --help works even when a device library is missing.
    from webui.app import create_app

    app = create_app(None, start_discord_bot=False)
    url = f"http://{args.host}:{args.port}/panel"

    print("=" * 66)
    print("  xlamBOT multi-device control panel")
    print(f"  Panel:  {url}")
    print("  Devices: each connected ADB device gets its own bot, settings and queue.")
    print("=" * 66)

    if not args.no_browser:
        # Give the server a moment so the first page load is not a connection
        # error the user has to reload past.
        threading.Timer(1.2, lambda: _open_browser(url)).start()

    # threaded=True: the panel streams screenshots and polls telemetry, and a
    # single-threaded server would block on each of those.
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)
    return 0


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url)
    except Exception as error:  # noqa: BLE001
        print(f"Could not open a browser automatically: {error}")
        print(f"Open it manually: {url}")


if __name__ == "__main__":
    raise SystemExit(main())
