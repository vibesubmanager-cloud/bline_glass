import os
import socket
import sys
from threading import Thread

from app import create_app
from app.devcerts import ensure_dev_cert, local_hosts
from app.extensions import socketio
from app.utils.logging import arrow

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

app = create_app()


def _require_free_port(port: int, label: str) -> None:
    """Windows can bind two run.py copies to the same port. Refuse that."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind(("0.0.0.0", port))
    except OSError as exc:
        arrow(f"{label} port {port} is already in use. Stop the other run.py first. {exc}")
        raise SystemExit(1) from exc
    finally:
        sock.close()


def _run_https(cert_path: str, key_path: str, port: int) -> None:
    from werkzeug.serving import run_simple

    arrow(f"HTTPS starting on port {port}")
    try:
        run_simple(
            "0.0.0.0",
            port,
            app,
            ssl_context=(cert_path, key_path),
            threaded=True,
            use_reloader=False,
        )
    except OSError as exc:
        arrow(f"HTTPS did not start on port {port}: {exc}")
        print(f"HTTPS did not start on port {port}: {exc}", flush=True)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    https_port = int(os.getenv("HTTPS_PORT", "5443"))
    debug = os.getenv("FLASK_ENV") == "development"
    _require_free_port(port, "HTTP")
    _require_free_port(https_port, "HTTPS")
    cert_path, key_path = ensure_dev_cert()
    Thread(target=_run_https, args=(cert_path, key_path, https_port), daemon=True).start()
    hosts = ", ".join(f"https://{h}:{https_port}" for h in local_hosts() if h not in {"0.0.0.0"})
    print(f"iPhone camera/mic: use Safari with {hosts}", flush=True)
    print("On iPhone Safari, tap Allow, then Settings > General > About > Certificate Trust Settings > enable Vibe Eye Local.", flush=True)
    print(f"Admin website (PC): http://127.0.0.1:{port}/admin", flush=True)
    arrow(f"HTTP starting on port {port}")
    try:
        socketio.run(app, host="0.0.0.0", port=port, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)
    except TypeError:
        socketio.run(app, host="0.0.0.0", port=port, debug=False, use_reloader=False)
    except OSError as exc:
        arrow(f"HTTP did not start on port {port}: {exc}")
        raise
