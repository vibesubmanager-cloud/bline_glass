"""Consistent JSON envelope for every API response."""

from __future__ import annotations

from flask import jsonify


def ok(data=None, status: int = 200):
    return jsonify({"success": True, "data": data if data is not None else {}, "error": None}), status


def fail(code: str, message: str, status: int = 400, details=None):
    error = {"code": code, "message": message}
    if details:
        error["details"] = details
    return jsonify({"success": False, "data": None, "error": error}), status
