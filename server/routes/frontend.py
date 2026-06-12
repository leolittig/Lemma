"""GET / — serve the built React frontend (production mode).

In development the frontend is served by Vite instead (npm run dev), which
proxies API calls to this server; this route then only shows instructions.
"""

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from .. import config

router = APIRouter()

DIST_INDEX = config.PROJECT_ROOT / "dist" / "index.html"


@router.get("/", response_class=HTMLResponse)
def index():
    if DIST_INDEX.exists():
        return DIST_INDEX.read_text(encoding="utf-8")
    return """
    <html>
        <body style="font-family: sans-serif; padding: 2rem; text-align: center; max-width: 600px; margin: 0 auto; line-height: 1.6;">
            <h2>Frontend not built yet</h2>
            <p>To run the app, you can either:</p>
            <ul style="text-align: left; display: inline-block;">
                <li>Build the production files: <code>npm run build</code>, then refresh this page.</li>
                <li>Or run the Vite development server: <code>npm run dev</code> and open the printed URL (usually <a href="http://localhost:5173">http://localhost:5173</a>).</li>
            </ul>
        </body>
    </html>
    """
