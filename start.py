"""Direct entry point — run with: python3 start.py

This file ensures the project root is on sys.path before importing app.main,
so it works regardless of your current working directory.
"""

import sys
from pathlib import Path

# Add project root to Python path
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)

