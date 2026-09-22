"""Serve the Vibe Eye website from the same Flask process as the API."""

from pathlib import Path

from flask import Blueprint, redirect, send_file, send_from_directory

from app.devcerts import CERT_FILE, ensure_dev_cert
from app.utils.responses import fail

frontend_bp = Blueprint("frontend", __name__)
FRONTEND_DIR = Path(__file__).resolve().parents[2].parent / "frontend"


@frontend_bp.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@frontend_bp.get("/admin")
@frontend_bp.get("/admin/")
def admin_site():
    return redirect("/pages/admin.html")


@frontend_bp.get("/ios-cert.cer")
def ios_cert():
    ensure_dev_cert()
    return send_file(
        CERT_FILE,
        mimetype="application/x-x509-ca-cert",
        as_attachment=True,
        download_name="vibe-eye.cer",
    )


@frontend_bp.get("/<path:asset_path>")
def asset(asset_path: str):
    if asset_path == "api" or asset_path.startswith("api/"):
        return fail("NOT_FOUND", "That endpoint does not exist.", 404)
    target = FRONTEND_DIR / asset_path
    if not target.is_file():
        return fail("NOT_FOUND", "That page does not exist.", 404)
    return send_from_directory(FRONTEND_DIR, asset_path)
