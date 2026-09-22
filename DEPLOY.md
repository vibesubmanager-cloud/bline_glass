# Deploy AI Sight

Split:

| Piece | Where |
| --- | --- |
| Website (HTML/JS/CSS) | GitHub Pages |
| API (Flask) | Render |
| Photos / voice notes | Cloudinary |
| Users, contacts, messages text, settings | Neon PostgreSQL |

Do not put API keys in the frontend. They live only on Render.

## 1. Neon (database)

1. Create a project at [neon.tech](https://neon.tech).
2. Copy the connection string (it should include `sslmode=require`).
3. You will paste this into Render as `DATABASE_URL`.
4. Tables are created automatically the first time the API starts (`db.create_all()`).

## 2. Cloudinary (images)

1. Create an account at [cloudinary.com](https://cloudinary.com).
2. From the dashboard copy:
   - Cloud name
   - API Key
   - API Secret
3. You will paste these into Render. Chat photos and voice notes upload here. Neon only stores the Cloudinary URL plus the text.

Describe / Read / Detection still send the camera frame to the API for Gemini/YOLO and do **not** keep those frames.

## 3. Render (backend)

1. Push this repo to GitHub.
2. On Render: **New → Web Service** → that repo.
3. Settings:
   - Root directory: `backend`
   - Runtime: Python 3.11
   - Build: `pip install -r requirements.txt`
   - Start: `gunicorn -w 1 --threads 8 --timeout 120 --bind 0.0.0.0:$PORT run:app`
4. Environment variables:

| Name | Value |
| --- | --- |
| `FLASK_ENV` | `production` |
| `SECRET_KEY` | long random string |
| `DATABASE_URL` | Neon URI |
| `FRONTEND_ORIGINS` | your GitHub Pages origin, e.g. `https://YOURUSER.github.io` (comma-separated if more than one) |
| `GEMINI_API_KEY` | Google AI Studio key |
| `GROQ_API_KEY` | Groq key |
| `CLOUDINARY_CLOUD_NAME` | from Cloudinary |
| `CLOUDINARY_API_KEY` | from Cloudinary |
| `CLOUDINARY_API_SECRET` | from Cloudinary |
| `MAPS_PROVIDER` | `osm` (or `openrouteservice` plus `MAPS_API_KEY`) |

Use a **Starter** (or larger) instance. YOLO needs RAM. One gunicorn worker is required for in-app calling.

5. After the first deploy, open `https://YOUR-SERVICE.onrender.com/api/health`. You should see `"status":"ok"`.

## 4. GitHub Pages (frontend)

1. Repo **Settings → Pages → Build and deployment → GitHub Actions**.
2. Repo **Settings → Secrets and variables → Actions** → add `RENDER_API_URL` = `https://YOUR-SERVICE.onrender.com` (no trailing slash).
3. Push to `main` (or run the **Deploy frontend to GitHub Pages** workflow).
4. The workflow publishes the `frontend/` folder and writes `js/api-config.js` so the site calls Render.

If the secret is missing, open **Settings** in the app, paste the Render URL, tap **Save API address**, then reload.

## 5. After both are live

1. Add the GitHub Pages origin to Render `FRONTEND_ORIGINS`.
2. Hard-refresh the Pages site.
3. Create an account and test login, describe, detection, send photo, voice call, video call.

Phone camera and microphone need **https**. GitHub Pages is https, so iPhone Safari can use them. The local certificate is only for home LAN testing.

## Local development (unchanged)

```bash
cd backend
python run.py
```

Open `http://127.0.0.1:5000`. Local SQLite is used if `DATABASE_URL` is not set. Photos stay on disk unless Cloudinary is in `.env`.
