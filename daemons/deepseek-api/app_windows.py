"""
Windows-friendly entry point for the DeepSeek OpenAI-compatible server.

The original app.py uses uvicorn.run("server.api:app", reload=False) which
passes a STRING import path. On Windows, uvicorn's import reloader can fail
to resolve the string path correctly when run via spawn() with shell:true.

This wrapper imports the FastAPI app object directly and passes it to
uvicorn.run() as an object (not a string), avoiding the import resolution
issue entirely.
"""

import os

import uvicorn
from dotenv import load_dotenv

# Import the app OBJECT (not a string) so uvicorn doesn't need to resolve
# a string import path — this works reliably on Windows.
from server.api import app as fastapi_app

load_dotenv()

if __name__ == "__main__":
    uvicorn.run(
        fastapi_app,  # ← object, not "server.api:app" string
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        reload=False,
    )
