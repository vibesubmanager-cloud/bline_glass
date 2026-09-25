# vibeEye backend

Flask API for vibeEye. Run from this directory:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python run.py
```

Production start command (Render):

```text
gunicorn -w 1 --threads 8 run:app
```

Configure secrets with environment variables only. See the root README and `.env.example`.
