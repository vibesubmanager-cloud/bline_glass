"""Create a local TLS certificate so iPhones can use camera and microphone.

Apple only allows getUserMedia and speech recognition in a secure context
(HTTPS or localhost). A LAN http://IP address is not secure.
"""

from __future__ import annotations

import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path

CERT_DIR = Path(__file__).resolve().parents[1] / "certs"
CERT_FILE = CERT_DIR / "cert.pem"
KEY_FILE = CERT_DIR / "key.pem"


def local_hosts() -> list[str]:
    hosts = {"localhost", "127.0.0.1", "0.0.0.0"}
    try:
        hostname = socket.gethostname()
        hosts.add(hostname)
        hosts.add(socket.gethostbyname(hostname))
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        hosts.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    return sorted(h for h in hosts if h and h != "0.0.0.0")


def ensure_dev_cert() -> tuple[str, str]:
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    if CERT_FILE.exists() and KEY_FILE.exists():
        return str(CERT_FILE), str(KEY_FILE)

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    from ipaddress import ip_address

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    names = local_hosts()
    san = []
    for name in names:
        try:
            san.append(x509.IPAddress(ip_address(name)))
        except ValueError:
            san.append(x509.DNSName(name))

    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Vibe Eye Local")])
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(key, hashes.SHA256())
    )
    KEY_FILE.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return str(CERT_FILE), str(KEY_FILE)
