# Vibe Eye

Assistive AI for blind and visually impaired users. The primary interaction is:

**Tap → Speak → Understand → Act → Speak the result**

The user does not need to see the screen to use object detection, reading, scene description, navigation, calling, or emergency.

This is a real application: Flask API, PostgreSQL, YOLO, Gemini, maps routing, and WebRTC/phone calling. Secrets stay on the backend.

## Architecture

```
GitHub Pages (frontend)  →  Render Flask API
                                ├─ Neon PostgreSQL
                                ├─ YOLO object detection
                                ├─ Gemini vision
                                ├─ Cloudinary (only if an image must be stored)
                                └─ OpenRouteService walking directions
```

Frontend: `frontend/` (HTML, CSS, vanilla JS, PWA-ready)  
Backend: `backend/` (modular Flask)

## Local setup

### 1. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python run.py
```

The API starts on `http://localhost:5000`. Without `DATABASE_URL`, it uses local SQLite so you can develop before Neon is configured.

YOLO weights (`yolov8n.pt`) download automatically on the first detection request.

### 2. Frontend

Serve the frontend over HTTP (required for camera and microphone on most browsers):

```bash
python -m http.server 8080 --directory frontend
```

Open `http://localhost:8080`. Create an account, then tap the large center area and speak.

If the frontend origin is not `http://localhost:8080`, add it to `FRONTEND_ORIGINS`.

### 3. Environment variables

See `.env.example` and `backend/.env.example`. Never put these values in frontend JavaScript.

| Variable | Purpose |
| --- | --- |
| `SECRET_KEY` | Flask / JWT signing |
| `DATABASE_URL` | Neon PostgreSQL URL (`postgres://` is accepted and converted) |
| `FRONTEND_ORIGINS` | Allowed GitHub Pages and local origins, comma-separated |
| `GEMINI_API_KEY` | Gemini vision / OCR / visual Q&A |
| `GEMINI_MODEL` | Default `gemini-2.0-flash` |
| `CLOUDINARY_*` | Persistent image storage (not used for ordinary camera commands) |
| `MAPS_API_KEY` | OpenRouteService API key |
| `MAPS_PROVIDER` | Default `openrouteservice` (swap the provider class to change later) |
| `YOLO_MODEL` | Default `yolov8n.pt` (replace to upgrade YOLO without rewriting routes) |
| `TWILIO_*` | Optional SMS when emergency is activated |
| `TURN_*` | Optional TURN server for WebRTC on strict mobile networks |

## Cloud accounts

1. **Neon** — PostgreSQL. Copy the connection string to Render `DATABASE_URL`.
2. **Cloudinary** — chat photos and voice notes. Set `CLOUDINARY_*` on Render.
3. **Render** — Flask API, root directory `backend`, start command in `Procfile`. Set every secret as a Render env var. Use a Starter instance or larger; YOLO needs RAM.
4. **GitHub Pages** — workflow `.github/workflows/deploy-frontend.yml` publishes `frontend/`. Add Action secret `RENDER_API_URL` (your Render origin). Add the Pages origin to `FRONTEND_ORIGINS`.
5. **Gemini** — API key from Google AI Studio.
6. **Groq** — conversation / intent helper.

Step-by-step: [DEPLOY.md](DEPLOY.md).

## Voice commands

Tap the large center control, then say:

| You say | What happens |
| --- | --- |
| What is in front of me? | YOLO object detection |
| What is this object? / Is there a car in front of me? | YOLO |
| Read this | Gemini OCR / document reading |
| What do you see? | Gemini scene description for a blind user |
| What color is this shirt? | Gemini visual question |
| Take me to Sharda University | Walking route + spoken turn-by-turn |
| Where am I? / How far? / Next turn / Repeat / Stop navigation | Navigation helpers |
| Call John / Call my brother | WebRTC if they use Vibe Eye, otherwise the phone dialer |
| Emergency | Location (only with permission) + notify/call emergency contact |
| Help | Spoken command list |

Exact distances are never invented. YOLO positions are spoken as left / right / in front, not as meters.

## Privacy

- Camera frames are sent only for the current command, then discarded.
- Voice audio is processed in the browser (Web Speech API). The backend stores transcripts only as intent text in memory for that request, not as recordings.
- Location is shared during emergency only if the user setting allows it.
- Passwords are bcrypt-hashed. JWT is required for API access.
- Images are not written to Postgres. Cloudinary is used only when persistent storage is explicitly required.

## Tests

```bash
cd backend
pytest -q
```

Covered automatically: registration/login, protected routes, intent parsing, spoken response engine, contacts CRUD, mocked YOLO detection, missing maps key, emergency without contacts, unknown call targets.

Manual checks before production (camera, mic, GPS, and WebRTC need a real device):

- Camera permission denied → app still speaks and remains usable for non-camera commands
- Microphone permission denied → typed command fallback appears
- Gemini timeout → user hears a retry/error message, app does not crash
- GPS denied → navigation does not start, spoken explanation
- Offline → AI features explain that internet is required; static pages can load from the service worker

## Swappable services

- Object detection: `ObjectDetector.detect(image)` in `backend/app/services/yolo_service.py`
- Maps: `MapsProvider` in `backend/app/services/navigation_service.py`
- Calling: signaling in `calling_service.py`; media is WebRTC peer-to-peer
- Vision: `GeminiService` in `gemini_service.py`

## Render notes

Use one gunicorn worker (`Procfile`) so in-memory call signaling stays consistent. For multiple workers, move signaling to Redis.

Do not enable unrestricted CORS in production. Set `FRONTEND_ORIGINS` to your GitHub Pages URL only.
